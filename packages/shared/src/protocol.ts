export type Axis = "X" | "Y";

/** O cliente envia `ping` neste intervalo. */
export const HEARTBEAT_INTERVAL_MS = 2000;
/** Sem mensagem do dono do trabalho por este tempo, o agente pausa e desliga o laser. */
export const HEARTBEAT_TIMEOUT_MS = 6000;

export type ClientMessage =
  | { type: "jog"; axis: Axis; distance: number; feed: number }
  | { type: "home" }
  | { type: "setOrigin" }
  | { type: "hold" }
  /** Retomar religa o laser: a UI precisa ter pedido confirmação. */
  | { type: "resume"; confirmLaserOn: true }
  | { type: "stop" }
  | { type: "unlock" }
  /** Iniciar liga o laser: a UI precisa ter pedido confirmação. */
  | { type: "job"; name: string; gcode: string; confirmLaserOn: true }
  | { type: "ping"; t: number };

export interface Position {
  x: number;
  y: number;
  z: number;
}

export type MachineState =
  | "Idle"
  | "Run"
  | "Hold"
  | "Jog"
  | "Alarm"
  | "Door"
  | "Check"
  | "Home"
  | "Sleep"
  | "Unknown";

/**
 * - `running`: executando.
 * - `paused`: pausado pelo usuário.
 * - `connectionLost`: pausado e com laser desligado porque o cliente sumiu.
 */
export type JobState = "running" | "paused" | "connectionLost";

export interface JobInfo {
  id: string;
  name: string;
  /** ISO 8601 */
  startedAt: string;
  sent: number;
  total: number;
  state: JobState;
  /** Por que o trabalho foi pausado, quando `state` é `connectionLost`. */
  reason?: string;
}

export type JobOutcome = "completed" | "aborted" | "error";

export interface JobResult {
  name: string;
  startedAt: string;
  endedAt: string;
  outcome: JobOutcome;
  reason: string;
}

export type ServerMessage =
  | {
      type: "hello";
      version: string;
      port: string;
      connected: boolean;
      job: JobInfo | null;
      /** Segundos que o agente espera alguém reconectar antes de cancelar um trabalho pausado. */
      reconnectGraceSec: number;
    }
  | { type: "status"; state: MachineState; mpos: Position; wpos?: Position; feed: number; spindle: number }
  | { type: "log"; level: "info" | "warn" | "error"; text: string }
  | { type: "progress"; sent: number; total: number; running: boolean }
  | { type: "job"; job: JobInfo | null }
  | { type: "jobEnded"; result: JobResult }
  | { type: "pong"; t: number }
  | { type: "error"; message: string };

export const PROTOCOL_VERSION = "0.2.0";
