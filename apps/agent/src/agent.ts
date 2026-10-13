import { randomUUID } from "node:crypto";
import {
  HEARTBEAT_TIMEOUT_MS,
  PROTOCOL_VERSION,
  parseClientMessage,
  type ClientMessage,
  type JobInfo,
  type JobResult,
  type JobState,
  type ServerMessage,
} from "@laserlink/shared";
import type { AgentConfig } from "./config.js";
import type { Grbl, JobEnd, JobProgress } from "./grbl.js";

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

interface ClientEntry {
  conn: ClientConn;
  lastSeen: number;
}

interface ActiveJob {
  id: string;
  name: string;
  startedAt: number;
  /** Cliente cujo heartbeat protege o trabalho. Null depois de uma perda de conexão. */
  ownerId: string | null;
  state: JobState;
  reason?: string;
  sent: number;
  total: number;
}

const TICK_MS = 500;

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
 *
 * Perda de conexão durante um trabalho (o dono desconecta ou fica mudo por
 * HEARTBEAT_TIMEOUT_MS): feed hold + laser desligado (0x9E). O trabalho fica
 * pausado esperando alguém decidir. Se nenhum cliente vivo aparecer em
 * `reconnectGraceSec`, o trabalho é cancelado (hold, reset e M5).
 */
export class Agent {
  private readonly clients = new Map<string, ClientEntry>();
  private readonly config: AgentConfig;
  private readonly grbl: Grbl;
  private readonly portLabel: string;
  private readonly ticker: NodeJS.Timeout;

  private job: ActiveJob | null = null;
  /** Desde quando não há nenhum cliente vivo com o trabalho pausado por perda de conexão. */
  private orphanSince: number | null = null;

  constructor(options: AgentOptions) {
    this.config = options.config;
    this.grbl = options.grbl;
    this.portLabel = options.portLabel;

    const grbl = this.grbl;
    grbl.on("status", (s) => this.broadcast({ type: "status", ...s }));
    grbl.on("log", (level, text) => this.broadcast({ type: "log", level, text }));
    grbl.on("progress", (p) => this.onProgress(p));
    grbl.on("jobEnd", (e) => this.onJobEnd(e));
    grbl.on("closed", () => this.broadcast({ type: "error", message: "Porta serial fechada." }));

    this.ticker = setInterval(() => this.tick(), TICK_MS);
  }

  get clientCount(): number {
    return this.clients.size;
  }

  get jobInfo(): JobInfo | null {
    const j = this.job;
    if (!j) return null;
    const info: JobInfo = {
      id: j.id,
      name: j.name,
      startedAt: new Date(j.startedAt).toISOString(),
      sent: j.sent,
      total: j.total,
      state: j.state,
    };
    if (j.reason) info.reason = j.reason;
    return info;
  }

  connect(client: ClientConn): void {
    this.clients.set(client.id, { conn: client, lastSeen: Date.now() });
    client.send({
      type: "hello",
      version: PROTOCOL_VERSION,
      port: this.portLabel,
      connected: this.grbl.isOpen,
      job: this.jobInfo,
      reconnectGraceSec: this.config.reconnectGraceSec,
    });
    const last = this.grbl.lastStatus;
    if (last) client.send({ type: "status", ...last });
  }

  disconnect(client: ClientConn): void {
    if (!this.clients.delete(client.id)) return;
    if (this.job && this.job.ownerId === client.id) {
      this.connectionLost("O computador que iniciou o trabalho desconectou.");
    }
  }

  /** `data` é o JSON já decodificado (ou null se não era JSON). */
  receive(client: ClientConn, data: unknown): void {
    const entry = this.clients.get(client.id);
    if (entry) entry.lastSeen = Date.now();
    const msg = parseClientMessage(data);
    if (!msg) {
      client.send({ type: "error", message: "Mensagem inválida." });
      return;
    }
    this.handle(client, msg);
  }

  /** Encerramento do processo: para qualquer trabalho em andamento. */
  shutdown(): void {
    clearInterval(this.ticker);
    if (this.grbl.isRunning) this.grbl.abortJob("Agente encerrado.");
  }

  private handle(client: ClientConn, msg: ClientMessage): void {
    const grbl = this.grbl;
    switch (msg.type) {
      case "ping":
        client.send({ type: "pong", t: msg.t });
        break;
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
        if (this.job?.state === "running") this.setJobState("paused");
        break;
      case "resume":
        grbl.cycleResume();
        if (this.job) {
          // Quem retoma passa a ser o dono: o heartbeat dele protege o trabalho daqui em diante.
          this.job.ownerId = client.id;
          this.orphanSince = null;
          this.setJobState("running");
        }
        break;
      case "stop":
        grbl.abortJob("Parado pelo usuário.");
        break;
      case "unlock":
        grbl.sendLine("$X");
        break;
      case "job":
        this.startJob(client, msg.name, msg.gcode);
        break;
    }
  }

  private startJob(client: ClientConn, name: string, gcode: string): void {
    if (this.job || this.grbl.isRunning) {
      client.send({ type: "error", message: "Já existe um trabalho em andamento." });
      return;
    }
    if (!this.grbl.isOpen) {
      client.send({ type: "error", message: "A laser não está conectada ao agente. Confira o cabo USB." });
      return;
    }
    const lines = cleanGcode(gcode);
    if (lines.length === 0) {
      client.send({ type: "error", message: "O arquivo não tem nenhuma linha de G-code." });
      return;
    }
    this.job = {
      id: randomUUID(),
      name,
      startedAt: Date.now(),
      ownerId: client.id,
      state: "running",
      sent: 0,
      total: lines.length,
    };
    if (!this.grbl.startJob(lines)) {
      this.job = null;
      client.send({ type: "error", message: "O GRBL não aceitou o trabalho agora. Tente de novo em alguns segundos." });
      return;
    }
    this.broadcast({ type: "log", level: "info", text: `Iniciando: ${name}` });
    this.broadcastJob();
  }

  private connectionLost(reason: string): void {
    const job = this.job;
    if (!job || job.state === "connectionLost") return;
    this.grbl.safetyHold();
    job.ownerId = null;
    job.reason = reason;
    this.orphanSince = this.hasLiveClient() ? null : Date.now();
    this.setJobState("connectionLost");
    this.broadcast({ type: "log", level: "warn", text: `Trabalho pausado e laser desligado: ${reason}` });
  }

  private tick(): void {
    const job = this.job;
    if (!job) return;
    const now = Date.now();
    if (job.state !== "connectionLost") {
      const owner = job.ownerId ? this.clients.get(job.ownerId) : undefined;
      if (!owner) {
        this.connectionLost("O computador que iniciou o trabalho desconectou.");
      } else if (now - owner.lastSeen > HEARTBEAT_TIMEOUT_MS) {
        this.connectionLost(`Sem sinal do computador que iniciou o trabalho por ${HEARTBEAT_TIMEOUT_MS / 1000} s.`);
      }
      return;
    }
    // Pausado por perda de conexão: se alguém está olhando, espera a decisão dessa pessoa.
    if (this.hasLiveClient()) {
      this.orphanSince = null;
      return;
    }
    this.orphanSince ??= now;
    if (now - this.orphanSince >= this.config.reconnectGraceSec * 1000) {
      this.grbl.abortJob(`Ninguém reconectou em ${this.config.reconnectGraceSec} s após a perda de conexão.`);
    }
  }

  private hasLiveClient(): boolean {
    const now = Date.now();
    for (const c of this.clients.values()) {
      if (now - c.lastSeen <= HEARTBEAT_TIMEOUT_MS) return true;
    }
    return false;
  }

  private onProgress(p: JobProgress): void {
    if (this.job) {
      this.job.sent = p.sent;
      this.job.total = p.total;
    }
    this.broadcast({ type: "progress", ...p });
  }

  private onJobEnd(end: JobEnd): void {
    const job = this.job;
    this.job = null;
    this.orphanSince = null;
    if (!job) return;
    const result: JobResult = {
      name: job.name,
      startedAt: new Date(job.startedAt).toISOString(),
      endedAt: new Date().toISOString(),
      outcome: end.outcome,
      reason: end.reason,
    };
    this.broadcast({ type: "jobEnded", result });
    this.broadcastJob();
  }

  private setJobState(state: JobState): void {
    if (!this.job) return;
    this.job.state = state;
    if (state !== "connectionLost") delete this.job.reason;
    this.broadcastJob();
  }

  private broadcastJob(): void {
    this.broadcast({ type: "job", job: this.jobInfo });
  }

  private broadcast(msg: ServerMessage): void {
    for (const c of this.clients.values()) c.conn.send(msg);
  }
}
