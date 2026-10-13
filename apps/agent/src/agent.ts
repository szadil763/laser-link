import { PROTOCOL_VERSION, parseClientMessage, type ClientMessage, type ServerMessage } from "@laserlink/shared";
import type { AgentConfig } from "./config.js";
import type { Grbl } from "./grbl.js";

/** Um cliente já autenticado. O transporte (WebSocket) fica fora desta classe. */
export interface ClientConn {
  readonly id: string;
  send(msg: ServerMessage): void;
}

export interface AgentOptions {
  config: AgentConfig;
  grbl: Grbl;
  /** Nome exibido da porta serial (ex.: COM3 ou "simulador"). */
  portLabel: string;
}

/** Remove comentários e linhas vazias do G-code. */
export function cleanGcode(gcode: string): string[] {
  return gcode
    .split(/\r?\n/)
    .map((l) => l.replace(/;.*$/, "").replace(/\(.*?\)/g, "").trim())
    .filter((l) => l.length > 0);
}

/**
 * Regras do agente: roteia mensagens dos clientes para o GRBL
 * e aplica as paradas de segurança.
 */
export class Agent {
  private readonly clients = new Map<string, ClientConn>();
  private readonly config: AgentConfig;
  private readonly grbl: Grbl;
  private readonly portLabel: string;

  constructor(options: AgentOptions) {
    this.config = options.config;
    this.grbl = options.grbl;
    this.portLabel = options.portLabel;

    const grbl = this.grbl;
    grbl.on("status", (s) => this.broadcast({ type: "status", ...s }));
    grbl.on("log", (level, text) => this.broadcast({ type: "log", level, text }));
    grbl.on("progress", (p) => this.broadcast({ type: "progress", ...p }));
    grbl.on("closed", () => this.broadcast({ type: "error", message: "Porta serial fechada." }));
  }

  get clientCount(): number {
    return this.clients.size;
  }

  connect(client: ClientConn): void {
    this.clients.set(client.id, client);
    client.send({ type: "hello", version: PROTOCOL_VERSION, port: this.portLabel, connected: this.grbl.isOpen });
    const last = this.grbl.lastStatus;
    if (last) client.send({ type: "status", ...last });
  }

  disconnect(client: ClientConn): void {
    if (!this.clients.delete(client.id)) return;
    this.safetyStopIfOrphaned();
  }

  /** `data` é o JSON já decodificado (ou null se não era JSON). */
  receive(client: ClientConn, data: unknown): void {
    const msg = parseClientMessage(data);
    if (!msg) {
      client.send({ type: "error", message: "Mensagem inválida." });
      return;
    }
    this.handle(client, msg);
  }

  /** Encerramento do processo: para qualquer trabalho em andamento. */
  shutdown(): void {
    if (this.grbl.isRunning) this.grbl.abortJob("Agente encerrado.");
  }

  private handle(client: ClientConn, msg: ClientMessage): void {
    const grbl = this.grbl;
    switch (msg.type) {
      case "jog": {
        const feed = Math.min(Math.max(1, msg.feed), this.config.maxFeed);
        const dist = Math.max(-1000, Math.min(1000, msg.distance));
        grbl.sendLine(`$J=G91 G21 ${msg.axis}${dist.toFixed(3)} F${feed.toFixed(0)}`);
        break;
      }
      case "home":
        grbl.sendLine("$H");
        break;
      case "setOrigin":
        grbl.sendLine("G10 L20 P1 X0 Y0");
        break;
      case "hold":
        grbl.feedHold();
        break;
      case "resume":
        grbl.cycleResume();
        break;
      case "stop":
        grbl.abortJob("Parado pelo usuário.");
        break;
      case "unlock":
        grbl.sendLine("$X");
        break;
      case "job":
        if (!grbl.startJob(cleanGcode(msg.gcode))) {
          client.send({ type: "error", message: "Não foi possível iniciar (trabalho em andamento ou arquivo vazio)." });
        } else {
          this.broadcast({ type: "log", level: "info", text: `Iniciando: ${msg.name}` });
        }
        break;
    }
  }

  /** Segurança: sem nenhum cliente conectado e com trabalho rodando, pausa e desliga o laser. */
  private safetyStopIfOrphaned(): void {
    if (this.clients.size === 0 && this.grbl.isRunning) {
      this.grbl.abortJob("Cliente desconectou durante o trabalho.");
    }
  }

  private broadcast(msg: ServerMessage): void {
    for (const c of this.clients.values()) c.send(msg);
  }
}
