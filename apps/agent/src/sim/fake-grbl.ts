import { EventEmitter } from "node:events";
import type { MachineState, Position } from "@laserlink/shared";
import { RX_BUFFER_SIZE } from "../grbl.js";
import type { SerialLink, SerialLinkEvents } from "../serial-link.js";

/** Resposta do simulador a uma linha: "ok", "error:N" ou "ALARM:N". */
export type FakeResponse = "ok" | `error:${number}` | `ALARM:${number}`;

export interface FakeGrblOptions {
  /** Tempo para "executar" cada linha. 0 = na próxima volta do event loop. */
  msPerLine?: number;
  /** Decide a resposta de cada linha recebida. Padrão: sempre "ok". */
  respond?: (line: string, index: number) => FakeResponse;
  /** Se a primeira abertura deve falhar (para testar a reconexão). */
  failOpens?: number;
}

const BANNER = "Grbl 1.1h ['$' for help]";

/**
 * GRBL falso que imita o que importa para o agente:
 * - buffer de RX de 127 bytes (registra estouro em `overflowed`);
 * - comandos de tempo real `?`, `!`, `~`, `0x18` e `0x9E` fora do buffer;
 * - "ok" / "error:N" / "ALARM:N" por linha e relatórios <Estado|MPos:...|FS:...>.
 */
export class FakeGrbl extends EventEmitter<SerialLinkEvents> implements SerialLink {
  private open_ = false;
  private rx = ""; // bytes recebidos e ainda não executados
  private timer: NodeJS.Timeout | null = null;
  private lineIndex = 0;
  private failOpens: number;

  // estado da máquina simulada
  state: MachineState = "Idle";
  mpos: Position = { x: 0, y: 0, z: 0 };
  wco: Position = { x: 0, y: 0, z: 0 };
  feed = 0;
  spindle = 0;
  /** Laser desligado pelo override de tempo real 0x9E (só vale em Hold). */
  spindleStopped = false;
  private absolute = true;
  private sValue = 0;
  private laserOn = false;

  // registros para os testes
  /** Linhas recebidas, na ordem, sem o "\n". */
  readonly lines: string[] = [];
  /** Comandos de tempo real recebidos, exceto "?". */
  readonly realtime: string[] = [];
  /** Maior ocupação do buffer de RX observada, em bytes. */
  maxRxBytes = 0;
  /** Verdadeiro se alguém mandou mais de 127 bytes sem esperar "ok". */
  overflowed = false;

  private readonly msPerLine: number;
  private readonly respond: (line: string, index: number) => FakeResponse;

  constructor(options: FakeGrblOptions = {}) {
    super();
    this.msPerLine = options.msPerLine ?? 0;
    this.respond = options.respond ?? (() => "ok");
    this.failOpens = options.failOpens ?? 0;
  }

  get isOpen(): boolean {
    return this.open_;
  }

  get rxBytes(): number {
    return Buffer.byteLength(this.rx);
  }

  open(): Promise<void> {
    if (this.failOpens > 0) {
      this.failOpens -= 1;
      return Promise.reject(new Error("Porta não encontrada (simulador)."));
    }
    this.open_ = true;
    return Promise.resolve();
  }

  close(): void {
    if (!this.open_) return;
    this.open_ = false;
    this.clearTimer();
    this.rx = "";
    this.emit("close");
  }

  /** Simula o cabo USB sendo desconectado. */
  unplug(): void {
    this.close();
  }

  write(data: Buffer): void {
    if (!this.open_) return;
    for (const byte of data) {
      if (!this.handleRealtime(byte)) this.receive(String.fromCharCode(byte));
    }
    this.schedule();
  }

  // ---------- tempo real ----------

  private handleRealtime(byte: number): boolean {
    switch (byte) {
      case 0x3f: // ?
        this.reply(this.statusReport());
        return true;
      case 0x21: // !
        this.realtime.push("!");
        if (this.state === "Run" || this.state === "Jog") this.state = "Hold";
        return true;
      case 0x7e: // ~
        this.realtime.push("~");
        if (this.state === "Hold") {
          this.spindleStopped = false;
          this.state = this.rx.length > 0 ? "Run" : "Idle";
          this.schedule();
        }
        return true;
      case 0x18: // reset suave
        this.realtime.push("0x18");
        this.softReset();
        return true;
      case 0x9e: // parar spindle/laser (override), só em Hold
        this.realtime.push("0x9E");
        if (this.state === "Hold") this.spindleStopped = !this.spindleStopped;
        return true;
      default:
        return byte >= 0x80; // outros overrides: aceitos e ignorados
    }
  }

  private softReset(): void {
    const wasMoving = this.state === "Run" || this.state === "Jog" || this.state === "Hold";
    this.clearTimer();
    this.rx = "";
    this.laserOn = false;
    this.spindle = 0;
    this.spindleStopped = false;
    this.absolute = true;
    // Reset com movimento em andamento perde a posição: o GRBL real entra em ALARM:3.
    this.state = wasMoving ? "Alarm" : this.state === "Alarm" ? "Alarm" : "Idle";
    this.reply(BANNER);
    if (wasMoving) this.reply("ALARM:3");
  }

  // ---------- buffer de linhas ----------

  private receive(ch: string): void {
    this.rx += ch;
    const used = this.rxBytes;
    if (used > this.maxRxBytes) this.maxRxBytes = used;
    if (used > RX_BUFFER_SIZE) this.overflowed = true;
  }

  private schedule(): void {
    if (this.timer || !this.open_) return;
    if (this.state === "Hold") return;
    if (!this.rx.includes("\n")) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.executeNext();
      this.schedule();
    }, this.msPerLine);
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private executeNext(): void {
    if (this.state === "Hold" || !this.open_) return;
    const nl = this.rx.indexOf("\n");
    if (nl < 0) return;
    const line = this.rx.slice(0, nl).trim();
    this.rx = this.rx.slice(nl + 1);
    this.lines.push(line);
    const index = this.lineIndex++;

    // Em alarme, o GRBL só aceita $X, $H e comandos $ de consulta.
    if (this.state === "Alarm" && !line.startsWith("$")) {
      this.reply("error:9");
      return;
    }
    const response = this.respond(line, index);
    if (response.startsWith("ALARM:")) {
      this.state = "Alarm";
      this.rx = "";
      this.laserOn = false;
      this.spindle = 0;
      this.reply(response);
      return;
    }
    if (response === "ok") this.apply(line);
    this.reply(response);
    if (this.state === "Run" && !this.rx.includes("\n")) this.state = "Idle";
  }

  /** Atualiza a posição e o laser simulados (subconjunto suficiente do G-code). */
  private apply(line: string): void {
    const upper = line.toUpperCase();
    if (upper === "$X") {
      if (this.state === "Alarm") this.state = "Idle";
      return;
    }
    if (upper === "$H") {
      this.mpos = { x: 0, y: 0, z: 0 };
      this.state = "Idle";
      return;
    }
    const jog = upper.startsWith("$J=");
    const body = jog ? upper.slice(3) : upper;
    const words = new Map<string, number[]>();
    for (const m of body.matchAll(/([A-Z])\s*([-+]?\d*\.?\d+)/g)) {
      const list = words.get(m[1]!) ?? [];
      list.push(Number(m[2]));
      words.set(m[1]!, list);
    }
    const g = words.get("G") ?? [];
    const relative = g.includes(91) ? true : g.includes(90) ? false : !this.absolute;
    if (!jog) {
      if (g.includes(90)) this.absolute = true;
      if (g.includes(91)) this.absolute = false;
    }
    if (g.includes(10) && words.get("L")?.[0] === 20) {
      // G10 L20 P1 X0 Y0: a posição atual vira a origem de trabalho
      this.wco = { ...this.wco, x: this.mpos.x - (words.get("X")?.[0] ?? 0), y: this.mpos.y - (words.get("Y")?.[0] ?? 0) };
      return;
    }
    const m = words.get("M") ?? [];
    if (m.includes(3) || m.includes(4)) this.laserOn = true;
    if (m.includes(5)) this.laserOn = false;
    const s = words.get("S")?.[0];
    if (s !== undefined) this.sValue = s;
    const f = words.get("F")?.[0];
    if (f !== undefined) this.feed = f;
    const x = words.get("X")?.[0];
    const y = words.get("Y")?.[0];
    if (x !== undefined || y !== undefined) {
      this.state = jog ? "Jog" : "Run";
      if (relative) {
        this.mpos = { ...this.mpos, x: this.mpos.x + (x ?? 0), y: this.mpos.y + (y ?? 0) };
      } else {
        this.mpos = {
          ...this.mpos,
          x: x !== undefined ? x + this.wco.x : this.mpos.x,
          y: y !== undefined ? y + this.wco.y : this.mpos.y,
        };
      }
      if (jog) this.state = "Idle";
    }
    this.spindle = this.laserOn ? this.sValue : 0;
  }

  // ---------- respostas ----------

  private statusReport(): string {
    const state = this.state === "Hold" ? "Hold:0" : this.state;
    const p = this.mpos;
    const w = this.wco;
    const spindle = this.state === "Hold" && this.spindleStopped ? 0 : this.spindle;
    return `<${state}|MPos:${p.x.toFixed(3)},${p.y.toFixed(3)},${p.z.toFixed(3)}|FS:${this.feed},${spindle}|WCO:${w.x.toFixed(3)},${w.y.toFixed(3)},${w.z.toFixed(3)}>`;
  }

  private reply(line: string): void {
    // Assíncrono, como uma serial de verdade.
    setImmediate(() => {
      if (this.open_) this.emit("line", line);
    });
  }
}
