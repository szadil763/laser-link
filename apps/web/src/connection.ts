import { HEARTBEAT_INTERVAL_MS, type ClientMessage, type ServerMessage } from "@laserlink/shared";
// Worker embutido no bundle (blob): funciona servido pelo agente ou dentro de outras páginas.
import SocketWorker from "./socket-worker.ts?worker&inline";

/**
 * - `connected`: pong recente.
 * - `unstable`: socket aberto, mas sem pong há mais de UNSTABLE_AFTER_MS.
 * - `connecting`: primeira tentativa.
 * - `reconnecting`: caiu e está tentando de novo sozinho.
 * - `disconnected`: parado (a pessoa desconectou ou o token é inválido).
 */
export type LinkState = "disconnected" | "connecting" | "reconnecting" | "connected" | "unstable";

/** Página → worker do socket. */
export type SocketCommand = { cmd: "open"; url: string; pingMs: number } | { cmd: "send"; data: string } | { cmd: "close" };
/** Worker do socket → página. */
export type SocketEvent = { ev: "open" } | { ev: "message"; data: string } | { ev: "close"; code: number } | { ev: "invalid" };

/** Espera entre tentativas de reconexão: 1, 2, 4, 8 e depois 10 s. */
const BACKOFF_MS = [1000, 2000, 4000, 8000, 10000];

/** Sem pong por este tempo (dois pings perdidos), a conexão é considerada instável. */
const UNSTABLE_AFTER_MS = HEARTBEAT_INTERVAL_MS * 2 + 500;

export interface ConnectionEvents {
  onMessage(msg: ServerMessage): void;
  onState(state: LinkState): void;
  onLog(text: string): void;
}

/**
 * Conexão com o agente. O WebSocket e o ping ficam num Worker: se a página travar
 * (trabalho enorme, aba em segundo plano), o sinal de vida continua chegando ao agente.
 */
export class Connection {
  private readonly worker: Worker;
  private isOpen = false;
  private lastPong = 0;
  private state_: LinkState = "disconnected";
  private target: { url: string; token: string } | null = null;
  private attempt = 0;
  private retryTimer: number | undefined;
  private watchTimer: number | undefined;
  private opening: "connecting" | "reconnecting" = "connecting";

  constructor(private readonly events: ConnectionEvents) {
    this.worker = new SocketWorker();
    this.worker.onmessage = (e: MessageEvent<SocketEvent>) => this.onEvent(e.data);
  }

  get state(): LinkState {
    return this.state_;
  }

  /** Conecta e mantém conectado: se cair, reconecta sozinho até `disconnect()`. */
  connect(baseUrl: string, token: string): void {
    this.disconnect();
    this.target = { url: baseUrl.replace(/\/+$/, ""), token };
    this.attempt = 0;
    this.open("connecting");
  }

  private open(state: "connecting" | "reconnecting"): void {
    const target = this.target;
    if (!target) return;
    this.opening = state;
    this.setState(state);
    this.command({ cmd: "open", url: `${target.url}/?token=${encodeURIComponent(target.token)}`, pingMs: HEARTBEAT_INTERVAL_MS });
  }

  private onEvent(e: SocketEvent): void {
    if (e.ev === "invalid") {
      this.events.onLog("Endereço inválido. Use o formato ws://IP-DA-LASER:8787.");
      this.target = null;
      this.setState("disconnected");
    } else if (e.ev === "open") {
      if (!this.target) return;
      this.isOpen = true;
      this.attempt = 0;
      this.lastPong = Date.now();
      this.setState("connected");
      this.events.onLog(this.opening === "reconnecting" ? "Reconectado." : "Conectado.");
      this.startWatch();
    } else if (e.ev === "message") {
      const msg = JSON.parse(e.data) as ServerMessage;
      if (msg.type === "pong") {
        this.lastPong = Date.now();
        if (this.state_ === "unstable") this.setState("connected");
        return;
      }
      this.events.onMessage(msg);
    } else if (e.ev === "close") {
      this.isOpen = false;
      this.stopWatch();
      if (!this.target) return;
      if (e.code === 4401) {
        this.target = null;
        this.setState("disconnected");
        this.events.onLog("Token inválido. Confira o token no laserlink.config.json do agente.");
        return;
      }
      this.scheduleRetry();
    }
  }

  private scheduleRetry(): void {
    if (!this.target) return;
    const wait = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)]!;
    this.attempt += 1;
    if (this.attempt === 1) this.events.onLog("Conexão perdida. Tentando reconectar…");
    this.setState("reconnecting");
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = undefined;
      this.open("reconnecting");
    }, wait);
  }

  /** Para de vez (não reconecta). */
  disconnect(): void {
    this.target = null;
    if (this.retryTimer !== undefined) window.clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.stopWatch();
    this.isOpen = false;
    this.command({ cmd: "close" });
    this.setState("disconnected");
  }

  send(msg: ClientMessage): boolean {
    if (!this.isOpen) {
      this.events.onLog("Não conectado.");
      return false;
    }
    this.command({ cmd: "send", data: JSON.stringify(msg) });
    return true;
  }

  private command(cmd: SocketCommand): void {
    this.worker.postMessage(cmd);
  }

  /** Só para a interface: mostra "Conexão instável" quando os pongs atrasam. */
  private startWatch(): void {
    this.stopWatch();
    this.watchTimer = window.setInterval(() => {
      if (this.isOpen && Date.now() - this.lastPong > UNSTABLE_AFTER_MS && this.state_ === "connected") this.setState("unstable");
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopWatch(): void {
    if (this.watchTimer !== undefined) window.clearInterval(this.watchTimer);
    this.watchTimer = undefined;
  }

  private setState(state: LinkState): void {
    if (state === this.state_) return;
    this.state_ = state;
    this.events.onState(state);
  }
}
