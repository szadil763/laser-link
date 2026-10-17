export type Axis = "X" | "Y";

/** O cliente envia `ping` neste intervalo. */
export const HEARTBEAT_INTERVAL_MS = 2000;
/** Sem mensagem do dono do trabalho por este tempo, o agente pausa e desliga o laser. */
export const HEARTBEAT_TIMEOUT_MS = 6000;

export type ClientMessage =
  | { type: "jog"; axis: Axis; distance: number; feed: number }
  | { type: "home" }
  /**
   * A posição atual do cabeçote vira a origem de trabalho. Sem `x`/`y`: vira X0 Y0.
   * Com `x`/`y`: vira esse ponto (ex.: o centro do desenho), dentro da área útil.
   */
  | { type: "setOrigin"; x?: number; y?: number }
  | { type: "hold" }
  /** Retomar religa o laser: a UI precisa ter pedido confirmação. */
  | { type: "resume"; confirmLaserOn: true }
  | { type: "stop" }
  | { type: "unlock" }
  /** Iniciar liga o laser: a UI precisa ter pedido confirmação. */
  | { type: "job"; name: string; gcode: string; confirmLaserOn: true }
  | { type: "ping"; t: number }
  /**
   * Percorre o retângulo do trabalho. `laser: "off"` não liga o laser;
   * `"min"` usa a potência mínima do agente (framePower) e exige confirmação.
   */
  | { type: "frame"; bounds: FrameBounds; laser: "off" }
  | { type: "frame"; bounds: FrameBounds; laser: "min"; confirmLaserOn: true }
  | { type: "materialsSave"; materials: Material[] }
  /** Guarda um trabalho na fila do agente. Não liga o laser: o agente só confere e guarda. */
  | { type: "queueAdd"; name: string; gcode: string }
  | { type: "queueRemove"; id: string }
  /** Muda a posição de um trabalho na fila (0 = próximo). */
  | { type: "queueMove"; id: string; index: number }
  /** Inicia um trabalho da fila. Liga o laser: a UI precisa ter pedido confirmação. */
  | { type: "queueStart"; id: string; confirmLaserOn: true };

/** Limites da fila do agente. */
export const QUEUE_MAX_ITEMS = 20;
export const QUEUE_MAX_NAME = 120;

/**
 * Trabalho guardado na fila. O G-code fica só no agente (na memória);
 * a fila nunca inicia um trabalho sozinha.
 */
export interface QueueItem {
  id: string;
  name: string;
  /** Linhas de G-code depois de limpar comentários. */
  lines: number;
  /** ISO 8601 */
  addedAt: string;
  /** Tempo estimado em segundos (aproximado). */
  estimatedSec: number;
  bounds: JobBounds | null;
}

export interface FrameBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export type MaterialMode = "cut" | "line" | "fill" | "detail" | "raster";

/** Configuração de um material para uma operação. */
export interface MaterialPreset {
  mode: MaterialMode;
  /** mm/min */
  speed: number;
  /** 0–100 % */
  power: number;
  passes: number;
  /** mm, só corte */
  kerf?: number;
  /** mm, preenchido e detalhado */
  interval?: number;
}

export interface Material {
  id: string;
  name: string;
  /** mm */
  thickness: number;
  notes?: string;
  presets: MaterialPreset[];
}

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
  /** Este cliente é o dono: o heartbeat dele protege o trabalho. */
  ownedByYou: boolean;
  /** Por que o trabalho foi pausado, quando `state` é `connectionLost`. */
  reason?: string;
}

/** `interrupted`: o agente foi encerrado ou o PC desligou durante o trabalho. */
export type JobOutcome = "completed" | "aborted" | "error" | "interrupted";

export interface JobResult {
  name: string;
  startedAt: string;
  endedAt: string;
  outcome: JobOutcome;
  reason: string;
}

/** Motivo de recusa de uma linha do G-code. `line` é 1…n (0 = resumo). */
export interface JobProblem {
  line: number;
  text: string;
  message: string;
}

/** Retângulo percorrido pelo cabeçote, em mm, coordenadas de trabalho. */
export interface JobBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** Limites configurados no agente (laserlink.config.json). */
export interface AgentLimits {
  maxSpindle: number;
  workArea: { x: number; y: number };
  /** S usado em "Enquadrar com potência mínima". */
  framePower: number;
  /** mm/min do enquadramento. */
  frameFeed: number;
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
      limits: AgentLimits;
      /** Último trabalho encerrado, para quem reconecta saber o que aconteceu enquanto estava fora. */
      lastResult: JobResult | null;
    }
  | { type: "status"; state: MachineState; mpos: Position; wpos?: Position; feed: number; spindle: number }
  | { type: "log"; level: "info" | "warn" | "error"; text: string }
  | { type: "progress"; sent: number; total: number; running: boolean }
  | { type: "job"; job: JobInfo | null }
  | { type: "jobEnded"; result: JobResult }
  | { type: "jobRejected"; name: string; problems: JobProblem[]; bounds: JobBounds | null }
  | { type: "serial"; connected: boolean }
  | { type: "materials"; materials: Material[] }
  /** Fila inteira: enviada ao conectar e a cada mudança. */
  | { type: "queue"; items: QueueItem[] }
  | { type: "pong"; t: number }
  | { type: "error"; message: string };

export const PROTOCOL_VERSION = "0.5.0";
