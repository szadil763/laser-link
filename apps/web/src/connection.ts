import { HEARTBEAT_INTERVAL_MS, type ClientMessage, type ServerMessage } from "@laserlink/shared";
// Worker embutido no bundle (blob): funciona servido pelo agente ou dentro de outras páginas.
import TickWorker from "./tick-worker.ts?worker&inline";

/**
 * - `connected`: pong recente.
 * - `unstable`: socket aberto, mas sem pong há mais de UNSTABLE_AFTER_MS.
 * - `connecting`: primeira tentativa.
 * - `reconnecting`: caiu e está tentando de novo sozinho.
 * - `disconnected`: parado (a pessoa desconectou ou o token é inválido).
 */
export type LinkState = "disconnected" | "connecting" | "reconnecting" | "connected" | "unstable";

/** Espera entre tentativas de reconexão: 1, 2, 4, 8 e depois 10 s. */
const BACKOFF_MS = [1000, 2000, 4000, 8000, 10000];

/** Sem pong por este tempo (dois pings perdidos), a conexão é considerada instável. */
const UNSTABLE_AFTER_MS = HEARTBEAT_INTERVAL_MS * 2 + 500;

export interface ConnectionEvents {
  onMessage(msg: ServerMessage): void;
  onState(state: LinkState): void;
  onLog(text: string): void;
}

export class Connection {
  private ws: WebSocket | null = null;
  private ticker: Worker | null = null;
  private lastPong = 0;
  private state_: LinkState = "disconnected";
  private target: { url: string; token: string } | null = null;
  private attempt = 0;
  private retryTimer: number | undefined;

  constructor(private readonly events: ConnectionEvents) {}

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
    this.setState(state);
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${target.url}/?token=${encodeURIComponent(target.token)}`);
    } catch {
      this.events.onLog("Endereço inválido. Use o formato ws://IP-DA-LASER:8787.");
      this.target = null;
      this.setState("disconnected");
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.lastPong = Date.now();
      this.setState("connected");
      this.events.onLog(state === "reconnecting" ? "Reconectado." : "Conectado.");
      this.startPing();
    };
    ws.onmessage = (e) => {
      const msg = JSON.parse(String(e.data)) as ServerMessage;
      if (msg.type === "pong") {
        this.lastPong = Date.now();
        if (this.state_ === "unstable") this.setState("connected");
        return;
      }
      this.events.onMessage(msg);
    };
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.stopPing();
      this.ws = null;
      if (e.code === 4401) {
        this.target = null;
        this.setState("disconnected");
        this.events.onLog("Token inválido. Confira o token no laserlink.config.json do agente.");
        return;
      }
      this.scheduleRetry();
    };
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
    const ws = this.ws;
    this.ws = null;
    this.stopPing();
    if (ws) ws.close();
    this.setState("disconnected");
  }

  send(msg: ClientMessage): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.events.onLog("Não conectado.");
      return false;
    }
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  private startPing(): void {
    this.ticker ??= new TickWorker();
    this.ticker.onmessage = () => this.ping();
    this.ticker.postMessage(HEARTBEAT_INTERVAL_MS);
    this.ping();
  }

  private stopPing(): void {
    this.ticker?.postMessage(0);
  }

  private ping(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: "ping", t: Date.now() } satisfies ClientMessage));
    if (Date.now() - this.lastPong > UNSTABLE_AFTER_MS && this.state_ === "connected") this.setState("unstable");
  }

  private setState(state: LinkState): void {
    if (state === this.state_) return;
    this.state_ = state;
    this.events.onState(state);
  }
}
