import { HEARTBEAT_INTERVAL_MS, type ClientMessage, type ServerMessage } from "@laserlink/shared";

/**
 * - `connected`: pong recente.
 * - `unstable`: socket aberto, mas sem pong há mais de UNSTABLE_AFTER_MS.
 * - `connecting` / `disconnected`.
 */
export type LinkState = "disconnected" | "connecting" | "connected" | "unstable";

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

  constructor(private readonly events: ConnectionEvents) {}

  get state(): LinkState {
    return this.state_;
  }

  connect(baseUrl: string, token: string): void {
    this.disconnect();
    this.setState("connecting");
    const ws = new WebSocket(`${baseUrl.replace(/\/+$/, "")}/?token=${encodeURIComponent(token)}`);
    this.ws = ws;
    ws.onopen = () => {
      this.lastPong = Date.now();
      this.setState("connected");
      this.events.onLog("Conectado.");
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
      this.setState("disconnected");
      this.events.onLog(e.code === 4401 ? "Token inválido. Confira o token no laserlink.config.json do agente." : "Desconectado.");
    };
  }

  disconnect(): void {
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
    this.ticker ??= new Worker(new URL("./tick-worker.ts", import.meta.url), { type: "module" });
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
