import { EventEmitter } from "node:events";
import type { JobOutcome, MachineState, Position } from "@laserlink/shared";
import type { SerialLink } from "./serial-link.js";

export const RX_BUFFER_SIZE = 127; // buffer de RX do GRBL 1.1
const STATUS_POLL_MS = 200;
/** Se o GRBL não mandar a mensagem de boas-vindas depois do reset, segue assim mesmo após este tempo. */
const READY_TIMEOUT_MS = 3000;

// Comandos de tempo real: vão direto para a serial, fora da fila de linhas.
const RT_STATUS = Buffer.from("?");
const RT_HOLD = Buffer.from("!");
const RT_RESUME = Buffer.from("~");
const RT_RESET = Buffer.from([0x18]);
const RT_SPINDLE_STOP = Buffer.from([0x9e]); // override: liga/desliga o laser, só vale em Hold

/** Tempo para o GRBL confirmar a pausa (Hold) depois do "!". */
export const HOLD_CONFIRM_MS = 3000;
/** Tempo para o GRBL confirmar o laser desligado depois do 0x9E. Sem confirmação: reset. */
export const LASER_OFF_CONFIRM_MS = 2000;

export interface GrblStatus {
  state: MachineState;
  mpos: Position;
  /** Posição de trabalho (MPos − WCO). Só existe depois do primeiro WCO recebido. */
  wpos?: Position;
  feed: number;
  spindle: number;
  /**
   * Laser (spindle) aceso segundo o campo "A:" do GRBL 1.1. Só vem nos relatórios que trazem
   * os overrides ("Ov:"); sem eles, fica indefinido.
   */
  laserOn?: boolean;
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
  /** Configurações lidas com $$ (só o que interessa ao agente). */
  settings: [{ laserMode: boolean | null }];
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
  /** Falso entre um reset e a mensagem "Grbl 1.1…": linhas enviadas nesse intervalo seriam descartadas. */
  private ready = false;
  private readyTimer?: NodeJS.Timeout;
  /** Entre o pedido de parada e o M5 final: nada novo entra na fila. */
  private aborting = false;

  /** Pedido de desligar o laser assim que o GRBL confirmar o Hold. */
  private spindleStopPending = false;
  /** 0x9E já enviado neste Hold (é alternância: mandar duas vezes religaria). */
  private spindleStopped = false;
  /**
   * Conferência da parada de segurança: esperando o Hold, esperando o laser apagar ou já conferido.
   * Se o prazo vencer sem confirmação, o trabalho é cancelado com reset (o reset sempre corta o laser).
   */
  private safety: { stage: "waitHold" | "waitOff" | "confirmed"; timer?: NodeJS.Timeout } | null = null;
  /** $32 do GRBL (modo laser). null = ainda não lido ou o firmware não tem. */
  private laserModeSetting: boolean | null = null;

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

  /** Serial aberta e GRBL pronto para receber linhas. */
  get isReady(): boolean {
    return this.isOpen && this.ready;
  }

  get lastStatus(): GrblStatus | null {
    return this.last;
  }

  /** Modo laser do GRBL ($32). null = desconhecido. */
  get laserMode(): boolean | null {
    return this.laserModeSetting;
  }

  /** Pede as configurações ($$). Só fora de trabalho. */
  readSettings(): void {
    if (!this.running && !this.aborting) this.enqueue({ text: "$$" });
  }

  async open(): Promise<void> {
    await this.link.open();
    this.resetLineState();
    this.startPolling();
    // reset suave para iniciar o GRBL em estado conhecido
    this.writeRaw(RT_RESET);
    this.waitReady();
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
    this.clearSafety();
    this.writeRaw(RT_RESUME);
  }

  /**
   * Parada de segurança sem perder o trabalho: feed hold e, assim que o GRBL
   * estiver em Hold, desliga o laser com o override 0x9E. Um "M5" aqui não
   * adiantaria: ele entraria na fila e só rodaria depois de retomar.
   */
  safetyHold(): void {
    this.feedHold();
    if (this.spindleStopped) return;
    // Espera um relatório novo com Hold (no máximo um ciclo de polling) para mandar o 0x9E.
    this.spindleStopPending = true;
    if (!this.safety) this.armSafety("waitHold", HOLD_CONFIRM_MS, "o GRBL não confirmou a pausa");
  }

  /** O laser foi desligado e o GRBL confirmou (FS com potência 0 ou "A:" sem laser). */
  get isLaserOffConfirmed(): boolean {
    return this.safety?.stage === "confirmed";
  }

  private armSafety(stage: "waitHold" | "waitOff", ms: number, why: string): void {
    if (this.safety?.timer) clearTimeout(this.safety.timer);
    const timer = setTimeout(() => {
      if (this.safety?.stage !== stage) return;
      this.safety = null;
      this.emit("log", "error", `Parada de segurança: ${why} em ${ms / 1000} s. Cancelando com reset para garantir o laser desligado.`);
      this.abortJob(`Parada de segurança: ${why}. O trabalho foi cancelado com reset, que corta o laser.`);
    }, ms);
    this.safety = { stage, timer };
  }

  private clearSafety(): void {
    if (this.safety?.timer) clearTimeout(this.safety.timer);
    this.safety = null;
  }

  /** Relatório em Hold depois do 0x9E: o laser apagou? */
  private checkLaserOff(s: GrblStatus): void {
    if (this.safety?.stage !== "waitOff") return;
    if (s.laserOn === false || s.spindle === 0) {
      this.clearSafety();
      this.safety = { stage: "confirmed" };
      this.emit("log", "info", "Laser desligado e conferido com o trabalho em pausa.");
    }
  }

  get isSpindleStopped(): boolean {
    return this.spindleStopped;
  }

  /** Reset suave: aborta o movimento atual e limpa o buffer do GRBL. */
  softReset(): void {
    this.writeRaw(RT_RESET);
    this.waitReady();
    this.spindleStopPending = false;
    this.spindleStopped = false;
    this.clearSafety();
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
    if (this.running || this.aborting || lines.length === 0 || !this.isReady) return false;
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
    this.emit("log", "warn", "Pausa: pedido para desligar o laser (0x9E). Conferindo…");
    this.armSafety("waitOff", LASER_OFF_CONFIRM_MS, "o laser não confirmou que desligou");
  }

  private waitReady(): void {
    this.ready = false;
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = setTimeout(() => {
      this.readyTimer = undefined;
      if (this.ready || !this.isOpen) return;
      this.emit("log", "warn", "O GRBL não respondeu ao reset com a mensagem de boas-vindas. Seguindo assim mesmo.");
      this.markReady();
    }, READY_TIMEOUT_MS);
  }

  private markReady(): void {
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = undefined;
    this.ready = true;
    this.pump();
  }

  private enqueue(item: Queued): void {
    this.queue.push(item);
    this.pump();
  }

  private pump(): void {
    while (this.queue.length > 0 && this.isReady) {
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
        if (rest.state === "Hold") {
          // confere primeiro: o relatório que dispara o 0x9E é anterior a ele
          this.checkLaserOff(rest);
          this.applySpindleStop();
        }
        this.emit("status", rest);
      }
    } else if (line.startsWith("Grbl ")) {
      // Mensagem de boas-vindas após reset: o buffer do GRBL está vazio.
      const unexpected = this.ready;
      this.resetLineState();
      if (unexpected && this.running) {
        this.running = false;
        this.queue = [];
        this.emitProgress();
        this.emit("jobEnd", { outcome: "error", reason: "O GRBL reiniciou durante o trabalho." });
      }
      this.emit("log", "info", line);
      this.markReady();
    } else if (/^\$\d+=/.test(line)) {
      // resposta do $$: guarda o que interessa e não enche o registro
      const m = /^\$32=(\d+)/.exec(line);
      if (m) {
        this.laserModeSetting = m[1] === "1";
        this.emit("settings", { laserMode: this.laserModeSetting });
      }
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
    this.clearSafety();
    this.ready = false;
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = undefined;
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
  // "A:S" (horário) ou "A:C" (anti-horário) = laser aceso. Com "Ov:" e sem "A:", tudo apagado.
  const acc = fields.get("A");
  if (acc !== undefined) status.laserOn = /[SC]/.test(acc);
  else if (fields.has("Ov")) status.laserOn = false;
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
