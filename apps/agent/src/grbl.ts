import { EventEmitter } from "node:events";
import { ReadlineParser, SerialPort } from "serialport";
import type { MachineState, Position } from "@laserlink/shared";

const RX_BUFFER_SIZE = 127; // buffer de RX do GRBL 1.1
const STATUS_POLL_MS = 200;

export interface GrblStatus {
  state: MachineState;
  mpos: Position;
  feed: number;
  spindle: number;
}

interface GrblEvents {
  status: [GrblStatus];
  log: ["info" | "warn" | "error", string];
  progress: [{ sent: number; total: number; running: boolean }];
  closed: [];
}

export class Grbl extends EventEmitter<GrblEvents> {
  private port: SerialPort;
  private pollTimer?: NodeJS.Timeout;

  // estado do job
  private queue: string[] = [];
  private pending: number[] = []; // tamanhos (bytes) das linhas enviadas e ainda sem "ok"
  private total = 0;
  private acked = 0;
  private running = false;

  constructor(path: string, baudRate: number) {
    super();
    this.port = new SerialPort({ path, baudRate, autoOpen: false });
    const parser = this.port.pipe(new ReadlineParser({ delimiter: "\n" }));
    parser.on("data", (line: string) => this.onLine(line.trim()));
    this.port.on("close", () => {
      this.stopPolling();
      this.running = false;
      this.emit("closed");
    });
    this.port.on("error", (err) => this.emit("log", "error", `Serial: ${err.message}`));
  }

  get isOpen(): boolean {
    return this.port.isOpen;
  }

  get isRunning(): boolean {
    return this.running;
  }

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.port.open((err) => {
        if (err) return reject(err);
        this.startPolling();
        // reset suave para iniciar o GRBL em estado conhecido
        this.writeRaw(Buffer.from([0x18]));
        resolve();
      });
    });
  }

  close(): void {
    this.stopPolling();
    if (this.port.isOpen) this.port.close();
  }

  // ---------- comandos imediatos (fora da fila) ----------

  feedHold(): void {
    this.writeRaw(Buffer.from("!"));
  }

  cycleResume(): void {
    this.writeRaw(Buffer.from("~"));
  }

  /** Reset suave: aborta o movimento atual e limpa o buffer do GRBL. */
  softReset(): void {
    this.writeRaw(Buffer.from([0x18]));
  }

  /** Linha única fora de trabalho (jog, home, unlock...). Recusada durante job. */
  sendLine(line: string): boolean {
    if (this.running) {
      this.emit("log", "warn", `Ignorado durante o trabalho: ${line}`);
      return false;
    }
    this.writeRaw(Buffer.from(line.trim() + "\n"));
    return true;
  }

  // ---------- job com contagem de caracteres ----------

  startJob(gcode: string): boolean {
    if (this.running) return false;
    const lines = gcode
      .split(/\r?\n/)
      .map((l) => l.replace(/;.*$/, "").replace(/\(.*?\)/g, "").trim())
      .filter((l) => l.length > 0);
    if (lines.length === 0) return false;
    this.queue = lines;
    this.pending = [];
    this.total = lines.length;
    this.acked = 0;
    this.running = true;
    this.emitProgress();
    this.pump();
    return true;
  }

  /** Para o job com segurança: hold, reset e laser desligado. */
  abortJob(): void {
    this.feedHold();
    this.queue = [];
    this.pending = [];
    this.running = false;
    this.emitProgress();
    // pequeno atraso para o hold atuar antes do reset
    setTimeout(() => {
      this.softReset();
      setTimeout(() => this.writeRaw(Buffer.from("M5\n")), 200);
    }, 100);
  }

  // ---------- internos ----------

  private pump(): void {
    while (this.running && this.queue.length > 0) {
      const next = this.queue[0]!;
      const size = next.length + 1;
      const inFlight = this.pending.reduce((a, b) => a + b, 0);
      if (inFlight + size > RX_BUFFER_SIZE) break;
      this.queue.shift();
      this.pending.push(size);
      this.writeRaw(Buffer.from(next + "\n"));
    }
  }

  private onLine(line: string): void {
    if (!line) return;
    if (line === "ok") {
      this.onAck();
    } else if (line.startsWith("error:")) {
      this.emit("log", "error", line);
      this.onAck();
      if (this.running) {
        this.emit("log", "error", "Trabalho interrompido por erro do GRBL.");
        this.abortJob();
      }
    } else if (line.startsWith("ALARM:")) {
      this.emit("log", "error", line);
      if (this.running) this.abortJob();
    } else if (line.startsWith("<")) {
      const status = parseStatus(line);
      if (status) this.emit("status", status);
    } else {
      this.emit("log", "info", line);
    }
  }

  private onAck(): void {
    if (this.pending.length > 0) this.pending.shift();
    if (!this.running) return;
    this.acked += 1;
    this.emitProgress();
    if (this.queue.length === 0 && this.pending.length === 0) {
      this.running = false;
      this.emitProgress();
      this.emit("log", "info", "Trabalho concluído.");
      // garante laser desligado ao final
      this.writeRaw(Buffer.from("M5\n"));
    } else {
      this.pump();
    }
  }

  private emitProgress(): void {
    this.emit("progress", { sent: this.acked, total: this.total, running: this.running });
  }

  private writeRaw(data: Buffer): void {
    if (this.port.isOpen) this.port.write(data);
  }

  private startPolling(): void {
    this.pollTimer = setInterval(() => this.writeRaw(Buffer.from("?")), STATUS_POLL_MS);
  }

  private stopPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }
}

/** Ex.: <Idle|MPos:0.000,0.000,0.000|FS:0,0> */
export function parseStatus(line: string): GrblStatus | null {
  const m = /^<([A-Za-z]+)(?::\d+)?\|(.*)>$/.exec(line);
  if (!m) return null;
  const state = normalizeState(m[1]!);
  const fields = new Map<string, string>();
  for (const part of m[2]!.split("|")) {
    const i = part.indexOf(":");
    if (i > 0) fields.set(part.slice(0, i), part.slice(i + 1));
  }
  const posRaw = fields.get("MPos") ?? fields.get("WPos") ?? "0,0,0";
  const [x = 0, y = 0, z = 0] = posRaw.split(",").map(Number);
  const [feed = 0, spindle = 0] = (fields.get("FS") ?? fields.get("F") ?? "0,0").split(",").map(Number);
  return { state, mpos: { x, y, z }, feed, spindle };
}

function normalizeState(s: string): MachineState {
  const known: MachineState[] = ["Idle", "Run", "Hold", "Jog", "Alarm", "Door", "Check", "Home", "Sleep"];
  return (known.find((k) => k === s) ?? "Unknown") as MachineState;
}
