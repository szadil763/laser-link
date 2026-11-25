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
  /** Liga o modo laser do GRBL ($32=1). Não liga o laser: faz ele apagar em pausas e deslocamentos. */
  | { type: "setLaserMode" }
  /** Muda a posição de um trabalho na fila (0 = próximo). */
  | { type: "queueMove"; id: string; index: number }
  /** Inicia um trabalho da fila. Liga o laser: a UI precisa ter pedido confirmação. */
  | { type: "queueStart"; id: string; confirmLaserOn: true }
  /** Busca no GitHub os projetos publicados (ramo projetos) e devolve a lista. Não liga nada. */
  | { type: "projectsList" }
  /** Pede o conteúdo de um projeto da lista, para abrir na mesa. */
  | { type: "projectGet"; path: string }
  /** Confere no GitHub se há versão nova do LaserLink. Não muda nada. Sem `force`, vale a resposta dos últimos 10 minutos. */
  | { type: "updateCheck"; force?: true }
  /**
   * Baixa e instala a versão nova. O agente para por alguns minutos e volta sozinho.
   * Recusado com trabalho em andamento. A UI precisa ter pedido confirmação.
   */
  | { type: "updateApply"; confirmRestart: true };

export type ProjectKind = "laserlink" | "svg" | "dxf";

/** Projeto publicado na pasta projetos/ do ramo projetos. */
export interface ProjectEntry {
  /** Caminho no repositório, ex.: projetos/placa-da-porta.svg */
  path: string;
  /** Nome do arquivo, sem a pasta. */
  name: string;
  kind: ProjectKind;
  /** Bytes. */
  size: number;
  /** Data do último commit do arquivo (ISO 8601) ou "" se não houver. */
  date: string;
  /** Mensagem desse commit: o que o projeto é. */
  description: string;
}

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
  /** S que vale 100 %: o $30 lido da máquina (ou o maxSpindle do config, se ainda não leu). */
  maxSpindle: number;
  /** $31 da máquina (0 se não leu): o S de 1 % fica a partir daqui. */
  minSpindle: number;
  workArea: { x: number; y: number };
  /** S usado em "Enquadrar com potência mínima". */
  framePower: number;
  /** mm/min do enquadramento. */
  frameFeed: number;
}

/** Situação das atualizações do LaserLink. */
export interface UpdateInfo {
  /**
   * - `current`: já é a versão mais nova.
   * - `available`: há versão nova no GitHub.
   * - `applying`: atualizando (o agente vai parar e voltar).
   * - `error`: não deu para conferir (`reason` diz por quê).
   */
  state: "current" | "available" | "applying" | "error";
  /** Versão instalada: commit e data, ex.: "261667c · 24/11 18:34". */
  current: string;
  /** Versão nova, quando `available`. */
  latest?: string;
  /** O que mudou (títulos dos commits novos, do mais novo para o mais antigo; no máximo 15). */
  changes: string[];
  /** A versão nova instala pacotes novos: a atualização demora mais. */
  slow?: boolean;
  /** Dá para atualizar pelo app neste agente. */
  canApply: boolean;
  /** Erro da conferência ou por que não dá para atualizar pelo app. */
  reason?: string;
}

/** Resultado da última atualização feita pelo app (gravado pelo script do Windows). */
export interface UpdateResult {
  ok: boolean;
  message: string;
  /** Versão que ficou instalada. */
  version: string;
  /** ISO 8601 */
  at: string;
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
      /** $32 do GRBL (modo laser). null = não lido ainda ou firmware sem essa configuração. */
      laserMode: boolean | null;
      /** Versão do LaserLink instalada no agente (commit e data), ou "dev". */
      appVersion: string;
      /** Última atualização feita pelo app, se foi há pouco (para avisar quem conecta depois). */
      lastUpdate: UpdateResult | null;
    }
  | {
      type: "status";
      state: MachineState;
      mpos: Position;
      wpos?: Position;
      feed: number;
      spindle: number;
      laserOn?: boolean;
      /** Ajuste de potência do GRBL em % (campo Ov). 100 = sem ajuste. */
      spindleOverride?: number;
    }
  /** Configuração da máquina lida do GRBL ($$) e os limites que valem a partir dela. */
  | { type: "machine"; laserMode: boolean | null; limits: AgentLimits }
  | { type: "log"; level: "info" | "warn" | "error"; text: string }
  | { type: "progress"; sent: number; total: number; running: boolean }
  | { type: "job"; job: JobInfo | null }
  | { type: "jobEnded"; result: JobResult }
  | { type: "jobRejected"; name: string; problems: JobProblem[]; bounds: JobBounds | null }
  | { type: "serial"; connected: boolean }
  | { type: "materials"; materials: Material[] }
  /** Fila inteira: enviada ao conectar e a cada mudança. */
  | { type: "queue"; items: QueueItem[] }
  /** Lista de projetos publicados. `error`: a busca no GitHub falhou (a lista é a última baixada). */
  | { type: "projects"; items: ProjectEntry[]; error?: string }
  | { type: "projectFile"; entry: ProjectEntry; content: string }
  | { type: "update"; info: UpdateInfo }
  | { type: "pong"; t: number }
  | { type: "error"; message: string };

export const PROTOCOL_VERSION = "0.9.0";
