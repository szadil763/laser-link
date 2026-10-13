import { EventEmitter } from "node:events";
import type { JobOutcome, MachineState, Position } from "@laserlink/shared";
import type { SerialLink } from "./serial-link.js";

export const RX_BUFFER_SIZE = 127; // buffer de RX do GRBL 1.1
const STATUS_POLL_MS = 200;

// Comandos de tempo real: vão direto para a serial, fora da fila de linhas.
const RT_STATUS = Buffer.from("?");
const RT_HOLD = Buffer.from("!");
const RT_RESUME = Buffer.from("~");
const RT_RESET = Buffer.from([0x18]);
const RT_SPINDLE_STOP = Buffer.from([0x9e]); // override: liga/desliga o laser, só vale em Hold

export interface GrblStatus {
  state: MachineState;
  mpos: Position;
  /** Posição de trabalho (MPos − WCO). Só existe depois do primeiro WCO recebido. */
  wpos?: Position;
  feed: number;
  spindle: number;
}

export interface JobEnd {
  outcome: JobOutcome;
  reason: string;
}

export interface JobProgress {
  sent: number;
  total: number;
  running: boolean;
}

interface GrblEvents {
  status: [GrblStatus];
  log: ["info" | "warn" | "error", string];
  progress: [JobProgress];
  jobEnd: [JobEnd];
  closed: [];
}

/** Linha enviada ao GRBL e ainda sem resposta. */
interface InFlight {
  text: string;
  size: number;
  /** Número da linha no arquivo do trabalho (1…n). Ausente em comandos avulsos. */
  jobLine?: number;
}

interface Queued {
  text: string;
  jobLine?: number;
}

export interface GrblOptions {
  statusPollMs?: number;
}

export class Grbl extends EventEmitter<GrblEvents> {
  private pollTimer?: NodeJS.Timeout;
  private readonly pollMs: number;

  // Uma fila só para tudo que é linha (jog, $H, trabalho): a contagem de bytes nunca se perde.
  private queue: Queued[] = [];
  private inFlight: InFlight[] = [];
  private inFlightBytes = 0;

  // estado do trabalho
  private total = 0;
  private acked = 0;
  private running = false;
  /** Entre o pedido de parada e o M5 final: nada novo entra na fila. */
  private aborting = false;

  /** Pedido de desligar o laser assim que o GRBL confirmar o Hold. */
  private spindleStopPending = false;
  /** 0x9E já enviado neste Hold (é alternância: mandar duas vezes religaria). */
  private spindleStopped = false;

  private wco: Position | null = null;
  private last: GrblStatus | null = null;

  constructor(
    private readonly link: SerialLink,
    options: GrblOptions = {},
  ) {
    super();
    this.pollMs = options.statusPollMs ?? STATUS_POLL_MS;
    link.on("line", (line) => this.onLine(line.trim()));
    link.on("close", () => this.onClose());
    link.on("error", (err) => this.emit("log", "error", `Serial: ${err.message}`));
  }

  get isOpen(): boolean {
    return this.link.isOpen;
  }

  get isRunning(): boolean {
    return this.running;
  }

  get lastStatus(): GrblStatus | null {
    return this.last;
  }

  async open(): Promise<void> {
    await this.link.open();
    this.resetLineState();
    this.startPolling();
    // reset suave para iniciar o GRBL em estado conhecido
    this.writeRaw(RT_RESET);
  }

  close(): void {
    this.stopPolling();
    this.link.close();
  }

  // ---------- comandos imediatos (fora da fila) ----------

  feedHold(): void {
    this.writeRaw(RT_HOLD);
  }

  cycleResume(): void {
    // Ao retomar, o GRBL religa o laser que o 0x9E tinha desligado.
    this.spindleStopPending = false;
    this.spindleStopped = false;
    this.writeRaw(RT_RESUME);
  }

  /**
   * Parada de segurança sem perder o trabalho: feed hold e, assim que o GRBL
   * estiver em Hold, desliga o laser com o override 0x9E. Um "M5" aqui não
   * adiantaria: ele entraria na fila e só rodaria depois de retomar.
   */
  safetyHold(): void {
    this.feedHold();
    // Espera um relatório novo com Hold (no máximo um ciclo de polling).
    if (!this.spindleStopped) this.spindleStopPending = true;
  }

  get isSpindleStopped(): boolean {
    return this.spindleStopped;
  }

  /** Reset suave: aborta o movimento atual e limpa o buffer do GRBL. */
  softReset(): void {
    this.writeRaw(RT_RESET);
    this.spindleStopPending = false;
    this.spindleStopped = false;
    // O GRBL descarta o que estava no buffer e não responde mais a essas linhas.
    this.resetLineState();
  }

  /** Linha única fora de trabalho (jog, home, unlock...). Recusada durante trabalho. */
  sendLine(line: string): boolean {
    if (this.aborting) return false;
    if (this.running) {
      this.emit("log", "warn", `Ignorado durante o trabalho: ${line}`);
      return false;
    }
    this.enqueue({ text: line.trim() });
    return true;
  }

  // ---------- trabalho com contagem de caracteres ----------

  /** Recebe as linhas já limpas (sem comentários nem linhas vazias). */
  startJob(lines: readonly string[]): boolean {
    if (this.running || this.aborting || lines.length === 0 || !this.isOpen) return false;
    this.total = lines.length;
    this.acked = 0;
    this.running = true;
    lines.forEach((text, i) => this.queue.push({ text, jobLine: i + 1 }));
    this.emitProgress();
    this.pump();
    return true;
  }

  /** Para com segurança: hold, reset e laser desligado. Funciona com ou sem trabalho. */
  abortJob(reason = "Parado pelo usuário."): void {
    const hadJob = this.running;
    this.aborting = true;
    this.feedHold();
    this.running = false;
    this.queue = [];
    if (hadJob) {
      this.emitProgress();
      this.emit("jobEnd", { outcome: "aborted", reason });
    }
    // pequeno atraso para o hold atuar antes do reset
    setTimeout(() => {
      this.softReset();
      setTimeout(() => {
        this.aborting = false;
        this.enqueue({ text: "M5" });
      }, 200);
    }, 100);
  }

  // ---------- internos ----------

  private applySpindleStop(): void {
    if (!this.spindleStopPending || this.spindleStopped) return;
    this.spindleStopPending = false;
    this.spindleStopped = true;
    this.writeRaw(RT_SPINDLE_STOP);
    this.emit("log", "warn", "Laser desligado (override 0x9E) com o trabalho em pausa.");
  }

  private enqueue(item: Queued): void {
    this.queue.push(item);
    this.pump();
  }

  private pump(): void {
    while (this.queue.length > 0 && this.isOpen) {
      const next = this.queue[0]!;
      const size = Buffer.byteLength(next.text) + 1;
      if (this.inFlightBytes + size > RX_BUFFER_SIZE) break;
      this.queue.shift();
      this.inFlight.push({ text: next.text, size, jobLine: next.jobLine });
      this.inFlightBytes += size;
      this.writeRaw(Buffer.from(next.text + "\n"));
    }
  }

  private onLine(line: string): void {
    if (!line) return;
    if (line === "ok") {
      this.onResponse();
    } else if (line.startsWith("error:")) {
      const sent = this.onResponse();
      const where = sent?.jobLine ? ` na linha ${sent.jobLine} (${sent.text})` : sent ? ` em "${sent.text}"` : "";
      this.emit("log", "error", `GRBL ${line}${where}`);
      if (this.running && sent?.jobLine !== undefined) {
        this.abortJob(`GRBL respondeu ${line}${where}.`);
      }
    } else if (line.startsWith("ALARM:")) {
      this.emit("log", "error", `GRBL ${line}`);
      if (this.running) this.abortJob(`GRBL entrou em alarme (${line}).`);
    } else if (line.startsWith("<")) {
      const status = parseStatus(line, this.wco);
      if (status) {
        if (status.wco) this.wco = status.wco;
        const { wco: _wco, ...rest } = status;
        this.last = rest;
        if (rest.state === "Hold") this.applySpindleStop();
        this.emit("status", rest);
      }
    } else if (line.startsWith("Grbl ")) {
      // Mensagem de boas-vindas após reset: o buffer do GRBL está vazio.
      this.resetLineState();
      if (this.running) {
        this.running = false;
        this.queue = [];
        this.emitProgress();
        this.emit("jobEnd", { outcome: "error", reason: "O GRBL reiniciou durante o trabalho." });
      }
      this.emit("log", "info", line);
    } else {
      this.emit("log", "info", line);
    }
  }

  /** Confirma a linha mais antiga em voo e devolve qual era. */
  private onResponse(): InFlight | undefined {
    const done = this.inFlight.shift();
    if (done) this.inFlightBytes -= done.size;
    if (done?.jobLine !== undefined && this.running) {
      this.acked += 1;
      this.emitProgress();
      if (this.acked === this.total) {
        this.running = false;
        this.emitProgress();
        this.emit("log", "info", "Trabalho concluído.");
        this.emit("jobEnd", { outcome: "completed", reason: "Trabalho concluído." });
        // garante laser desligado ao final
        this.queue.push({ text: "M5" });
      }
    }
    this.pump();
    return done;
  }

  private onClose(): void {
    this.stopPolling();
    const hadJob = this.running;
    this.running = false;
    this.queue = [];
    this.resetLineState();
    if (hadJob) {
      this.emitProgress();
      this.emit("jobEnd", { outcome: "error", reason: "A porta serial foi desconectada durante o trabalho." });
    }
    this.emit("closed");
  }

  private resetLineState(): void {
    this.inFlight = [];
    this.inFlightBytes = 0;
  }

  private emitProgress(): void {
    this.emit("progress", { sent: this.acked, total: this.total, running: this.running });
  }

  private writeRaw(data: Buffer): void {
    if (this.link.isOpen) this.link.write(data);
  }

  private startPolling(): void {
    this.stopPolling();
    this.pollTimer = setInterval(() => this.writeRaw(RT_STATUS), this.pollMs);
  }

  private stopPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }
}

export interface ParsedStatus extends GrblStatus {
  /** Deslocamento de coordenadas de trabalho, quando veio neste relatório. */
  wco?: Position;
}

/**
 * Ex.: <Idle|MPos:0.000,0.000,0.000|FS:0,0|WCO:10.000,5.000,0.000>
 * `knownWco` é o último WCO recebido (o GRBL só o envia de tempos em tempos).
 */
export function parseStatus(line: string, knownWco: Position | null = null): ParsedStatus | null {
  const m = /^<([A-Za-z]+)(?::\d+)?\|(.*)>$/.exec(line);
  if (!m) return null;
  const state = normalizeState(m[1]!);
  const fields = new Map<string, string>();
  for (const part of m[2]!.split("|")) {
    const i = part.indexOf(":");
    if (i > 0) fields.set(part.slice(0, i), part.slice(i + 1));
  }
  const wcoRaw = fields.get("WCO");
  const wco = wcoRaw !== undefined ? parsePosition(wcoRaw) : undefined;
  const offset = wco ?? knownWco;

  const mposRaw = fields.get("MPos");
  const wposRaw = fields.get("WPos");
  let mpos: Position;
  let wpos: Position | undefined;
  if (mposRaw !== undefined) {
    mpos = parsePosition(mposRaw);
    if (offset) wpos = subtract(mpos, offset);
  } else if (wposRaw !== undefined) {
    wpos = parsePosition(wposRaw);
    mpos = offset ? add(wpos, offset) : wpos;
  } else {
    mpos = { x: 0, y: 0, z: 0 };
  }

  const [feed = 0, spindle = 0] = (fields.get("FS") ?? fields.get("F") ?? "0,0").split(",").map(Number);
  const status: ParsedStatus = { state, mpos, feed, spindle };
  if (wpos) status.wpos = wpos;
  if (wco) status.wco = wco;
  return status;
}

function parsePosition(raw: string): Position {
  const [x = 0, y = 0, z = 0] = raw.split(",").map(Number);
  return { x, y, z };
}

function add(a: Position, b: Position): Position {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function subtract(a: Position, b: Position): Position {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

const KNOWN_STATES: readonly MachineState[] = ["Idle", "Run", "Hold", "Jog", "Alarm", "Door", "Check", "Home", "Sleep"];

function normalizeState(s: string): MachineState {
  return KNOWN_STATES.find((k) => k === s) ?? "Unknown";
}
