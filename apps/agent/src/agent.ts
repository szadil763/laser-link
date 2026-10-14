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
import { checkGcode, stripComment, type CheckContext } from "./gcode-check.js";
import type { Grbl, JobEnd, JobProgress } from "./grbl.js";
import type { JobLog } from "./job-log.js";
import type { MaterialStore } from "./materials.js";
import { frameGcode } from "@laserlink/gcode";

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
  jobLog?: JobLog;
  materials?: MaterialStore;
  /** Intervalo entre tentativas de reabrir a serial. Padrão: 2 s. */
  serialRetryMs?: number;
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
const PROGRESS_INTERVAL_MS = 100;

/** Remove comentários, linhas vazias e delimitadores % do G-code. */
export function cleanGcode(gcode: string): string[] {
  return gcode
    .split(/\r?\n/)
    .map(stripComment)
    .filter((l) => l.length > 0 && l !== "%");
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
  private readonly jobLog: JobLog | null;
  private readonly materials: MaterialStore | null;
  private readonly ticker: NodeJS.Timeout;
  private readonly serialRetryMs: number;
  private serialTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private lastResult: JobResult | null = null;

  private job: ActiveJob | null = null;
  /** Desde quando não há nenhum cliente vivo com o trabalho pausado por perda de conexão. */
  private orphanSince: number | null = null;

  constructor(options: AgentOptions) {
    this.config = options.config;
    this.grbl = options.grbl;
    this.portLabel = options.portLabel;
    this.jobLog = options.jobLog ?? null;
    this.materials = options.materials ?? null;
    this.serialRetryMs = options.serialRetryMs ?? 2000;
    this.recoverUnfinishedJobs();

    const grbl = this.grbl;
    grbl.on("status", (s) => this.broadcast({ type: "status", ...s }));
    grbl.on("log", (level, text) => this.broadcast({ type: "log", level, text }));
    grbl.on("progress", (p) => this.onProgress(p));
    grbl.on("jobEnd", (e) => this.onJobEnd(e));
    grbl.on("closed", () => {
      this.broadcast({ type: "serial", connected: false });
      this.broadcast({ type: "log", level: "error", text: "Laser desconectada (porta serial fechada). Tentando reconectar…" });
      this.scheduleSerialOpen();
    });

    this.ticker = setInterval(() => this.tick(), TICK_MS);
  }

  get clientCount(): number {
    return this.clients.size;
  }

  /** Estado do trabalho visto por `clientId` (muda só o campo ownedByYou). */
  jobInfoFor(clientId: string | null): JobInfo | null {
    const j = this.job;
    if (!j) return null;
    const info: JobInfo = {
      id: j.id,
      name: j.name,
      startedAt: new Date(j.startedAt).toISOString(),
      sent: j.sent,
      total: j.total,
      state: j.state,
      ownedByYou: clientId !== null && j.ownerId === clientId,
    };
    if (j.reason) info.reason = j.reason;
    return info;
  }

  get jobInfo(): JobInfo | null {
    return this.jobInfoFor(null);
  }

  connect(client: ClientConn): void {
    this.clients.set(client.id, { conn: client, lastSeen: Date.now() });
    client.send({
      type: "hello",
      version: PROTOCOL_VERSION,
      port: this.portLabel,
      connected: this.grbl.isOpen,
      job: this.jobInfoFor(client.id),
      reconnectGraceSec: this.config.reconnectGraceSec,
      limits: {
        maxSpindle: this.config.maxSpindle,
        workArea: this.config.workArea,
        framePower: this.config.framePower,
        frameFeed: this.config.frameFeed,
      },
      lastResult: this.lastResult,
    });
    const last = this.grbl.lastStatus;
    if (last) client.send({ type: "status", ...last });
    if (this.materials) client.send({ type: "materials", materials: this.materials.all });
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

  /**
   * Abre a serial e mantém aberta: se falhar ou cair, tenta de novo a cada
   * `serialRetryMs`. Depois de reconectar, o agente nunca retoma trabalho sozinho.
   */
  async start(): Promise<void> {
    await this.openSerial();
  }

  /** Encerramento do processo: para qualquer trabalho em andamento. */
  shutdown(): void {
    this.stopped = true;
    clearInterval(this.ticker);
    if (this.progressTimer) clearTimeout(this.progressTimer);
    if (this.serialTimer) clearTimeout(this.serialTimer);
    this.serialTimer = null;
    if (this.grbl.isRunning) this.grbl.abortJob("Agente encerrado.");
  }

  private async openSerial(): Promise<void> {
    this.serialTimer = null;
    if (this.stopped || this.grbl.isOpen) return;
    try {
      await this.grbl.open();
      this.broadcast({ type: "serial", connected: true });
      this.broadcast({ type: "log", level: "info", text: `Laser conectada (${this.portLabel}).` });
      console.log(`Serial aberta: ${this.portLabel}`);
    } catch (err) {
      console.warn(`Não foi possível abrir ${this.portLabel}: ${(err as Error).message}. Nova tentativa em ${this.serialRetryMs / 1000} s.`);
      this.scheduleSerialOpen();
    }
  }

  private scheduleSerialOpen(): void {
    if (this.stopped || this.serialTimer) return;
    this.serialTimer = setTimeout(() => void this.openSerial(), this.serialRetryMs);
  }

  /** Trabalho que começou e não terminou (agente encerrado ou PC desligado): registra e avisa quem conectar. */
  private recoverUnfinishedJobs(): void {
    if (!this.jobLog) return;
    for (const job of this.jobLog.findUnfinished()) {
      const result: JobResult = {
        name: job.name,
        startedAt: job.startedAt,
        endedAt: new Date().toISOString(),
        outcome: "interrupted",
        reason: "O agente foi encerrado ou o computador da laser desligou durante o trabalho.",
      };
      this.jobLog.write({
        event: "end",
        id: job.id,
        name: job.name,
        startedAt: job.startedAt,
        at: result.endedAt,
        outcome: result.outcome,
        reason: result.reason,
        sent: 0,
        total: job.lines,
      });
      this.lastResult = result;
    }
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
      case "frame": {
        const s = msg.laser === "min" ? this.config.framePower : 0;
        const label = msg.laser === "min" ? `Enquadrar (laser em S${s})` : "Enquadrar (laser desligado)";
        this.startJob(client, label, frameGcode(msg.bounds, { feed: this.config.frameFeed, s }));
        break;
      }
      case "materialsSave":
        if (!this.materials) {
          client.send({ type: "error", message: "Este agente não guarda materiais." });
          break;
        }
        try {
          this.materials.save(msg.materials);
          this.broadcast({ type: "materials", materials: this.materials.all });
          this.broadcast({ type: "log", level: "info", text: `Biblioteca de materiais salva (${msg.materials.length} materiais).` });
        } catch (err) {
          client.send({ type: "error", message: `Não foi possível salvar os materiais: ${(err as Error).message}` });
        }
        break;
    }
  }

  private startJob(client: ClientConn, name: string, gcode: string): void {
    if (this.job || this.grbl.isRunning) {
      client.send({ type: "error", message: "Já existe um trabalho em andamento." });
      return;
    }
    if (!this.grbl.isReady) {
      client.send({
        type: "error",
        message: this.grbl.isOpen
          ? "A laser está reiniciando. Tente de novo em alguns segundos."
          : "A laser não está conectada ao agente. Confira o cabo USB.",
      });
      return;
    }
    const lines = cleanGcode(gcode);
    if (lines.length === 0) {
      client.send({ type: "error", message: "O arquivo não tem nenhuma linha de G-code." });
      return;
    }
    const check = checkGcode(gcode, this.config, this.checkContext());
    if (check.problems.length > 0) {
      client.send({ type: "jobRejected", name, problems: check.problems, bounds: check.bounds });
      this.jobLog?.write({
        event: "rejected",
        name,
        at: new Date().toISOString(),
        problems: check.problems.length,
        first: check.problems[0]!.message,
      });
      this.broadcast({ type: "log", level: "warn", text: `Trabalho recusado: ${name} (${check.problems.length} problema(s)).` });
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
    this.jobLog?.write({ event: "start", id: this.job.id, name, at: new Date(this.job.startedAt).toISOString(), lines: lines.length });
    this.broadcast({ type: "log", level: "info", text: `Iniciando: ${name}` });
    this.broadcastJob();
  }

  private checkContext(): CheckContext {
    const status = this.grbl.lastStatus;
    const ctx: CheckContext = {};
    if (status?.wpos) {
      ctx.start = { x: status.wpos.x, y: status.wpos.y };
      ctx.workOffset = { x: status.mpos.x - status.wpos.x, y: status.mpos.y - status.wpos.y };
    }
    return ctx;
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

  private lastProgressAt = 0;
  private progressTimer: NodeJS.Timeout | null = null;
  private pendingProgress: JobProgress | null = null;

  /** No máximo 10 avisos de progresso por segundo (o GRBL confirma centenas de linhas por segundo). */
  private onProgress(p: JobProgress): void {
    if (this.job) {
      this.job.sent = p.sent;
      this.job.total = p.total;
    }
    const now = Date.now();
    const flush = (): void => {
      if (this.progressTimer) clearTimeout(this.progressTimer);
      this.progressTimer = null;
      const msg = this.pendingProgress;
      this.pendingProgress = null;
      if (!msg) return;
      this.lastProgressAt = Date.now();
      this.broadcast({ type: "progress", ...msg });
    };
    this.pendingProgress = p;
    if (!p.running || p.sent === 0 || now - this.lastProgressAt >= PROGRESS_INTERVAL_MS) flush();
    else this.progressTimer ??= setTimeout(flush, PROGRESS_INTERVAL_MS - (now - this.lastProgressAt));
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
    this.jobLog?.write({
      event: "end",
      id: job.id,
      name: job.name,
      startedAt: result.startedAt,
      at: result.endedAt,
      outcome: result.outcome,
      reason: result.reason,
      sent: job.sent,
      total: job.total,
    });
    this.lastResult = result;
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
    for (const c of this.clients.values()) c.conn.send({ type: "job", job: this.jobInfoFor(c.conn.id) });
  }

  private broadcast(msg: ServerMessage): void {
    for (const c of this.clients.values()) c.conn.send(msg);
  }
}
