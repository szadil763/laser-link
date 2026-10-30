import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Area, MachineLimits } from "./gcode-check.js";

export interface AgentConfig {
  serialPort: string;
  baudRate: number;
  wsPort: number;
  /** Endereço onde o agente escuta. "0.0.0.0" = todas as interfaces; use o IP do Tailscale para restringir. */
  host: string;
  token: string;
  maxFeed: number;
  /** Segundos esperando alguém reconectar antes de cancelar um trabalho pausado por perda de conexão. */
  reconnectGraceSec: number;
  /** Maior potência aceita no G-code (S). Use o mesmo valor do $30 do GRBL. */
  maxSpindle: number;
  /** Área útil em mm a partir da origem de trabalho. */
  workArea: Area;
  /** Opcional: curso da máquina em coordenadas de máquina (só faz sentido com homing). */
  machineLimits?: MachineLimits;
  /** Pasta dos logs de trabalho. Padrão: apps/agent/logs. */
  logDir: string;
  /** Interface compilada servida pelo agente. Padrão: apps/web/dist. */
  webDir: string;
  /** Pasta da biblioteca de materiais. Padrão: apps/agent/data. */
  dataDir: string;
  /** S do "Enquadrar com potência mínima" (padrão 1% de maxSpindle). */
  framePower: number;
  /** mm/min do enquadramento. */
  frameFeed: number;
  /**
   * Projetos recebidos (ramo do GitHub com arquivos para abrir na interface).
   * null = desligado. Padrão: remoto origin, ramo projetos, na pasta do próprio LaserLink.
   */
  projects: { repoDir: string; remote: string; branch: string; token?: string } | null;
}

/** Raiz do repositório do LaserLink (apps/agent/src ou dist → três pastas acima). */
const DEFAULT_REPO_DIR = fileURLToPath(new URL("../../../", import.meta.url));

/** apps/agent/logs, tanto rodando de src/ (tsx) quanto de dist/ (node). */
const DEFAULT_LOG_DIR = fileURLToPath(new URL("../logs/", import.meta.url));
const DEFAULT_DATA_DIR = fileURLToPath(new URL("../data/", import.meta.url));
const DEFAULT_WEB_DIR = fileURLToPath(new URL("../../web/dist/", import.meta.url));

const DEFAULT_TOKEN = "TROQUE-POR-UM-TOKEN-LONGO-E-ALEATORIO";

export function loadConfig(): AgentConfig {
  const candidates = [
    ...(process.env.LASERLINK_CONFIG ? [resolve(process.env.LASERLINK_CONFIG)] : []),
    resolve(process.cwd(), "laserlink.config.json"),
    resolve(process.cwd(), "../../laserlink.config.json"),
  ];
  const path = candidates.find((p) => existsSync(p));
  if (!path) {
    throw new Error(
      "laserlink.config.json não encontrado. Copie apps/agent/laserlink.config.example.json para a raiz do projeto e edite.",
    );
  }
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<Omit<AgentConfig, "projects">> & {
    projects?: false | { repoDir?: string; remote?: string; branch?: string; token?: string };
  };
  const config: AgentConfig = {
    serialPort: raw.serialPort ?? "",
    baudRate: raw.baudRate ?? 115200,
    wsPort: raw.wsPort ?? 8787,
    host: raw.host ?? "0.0.0.0",
    token: raw.token ?? "",
    maxFeed: raw.maxFeed ?? 6000,
    reconnectGraceSec: raw.reconnectGraceSec ?? 60,
    maxSpindle: raw.maxSpindle ?? 1000,
    workArea: raw.workArea ?? { x: 0, y: 0 },
    logDir: raw.logDir ? resolve(path, "..", raw.logDir) : DEFAULT_LOG_DIR,
    webDir: raw.webDir ? resolve(path, "..", raw.webDir) : DEFAULT_WEB_DIR,
    dataDir: raw.dataDir ? resolve(path, "..", raw.dataDir) : DEFAULT_DATA_DIR,
    framePower: 0,
    frameFeed: raw.frameFeed ?? 3000,
    projects: null,
  };
  if (raw.projects !== false) {
    const p = raw.projects ?? {};
    config.projects = {
      repoDir: p.repoDir ? resolve(path, "..", p.repoDir) : DEFAULT_REPO_DIR,
      remote: p.remote ?? "origin",
      branch: p.branch ?? "projetos",
    };
    if (p.token) config.projects.token = p.token;
  }
  config.framePower = raw.framePower ?? Math.max(1, Math.round(config.maxSpindle * 0.01));
  if (raw.machineLimits) config.machineLimits = raw.machineLimits;
  if (!(config.maxSpindle > 0)) throw new Error("maxSpindle precisa ser maior que zero (use o valor do $30 do GRBL).");
  if (!(config.workArea.x > 0 && config.workArea.y > 0)) {
    throw new Error('Configure a área útil em mm, por exemplo "workArea": { "x": 400, "y": 400 }.');
  }
  if (!(config.framePower >= 0 && config.framePower <= config.maxSpindle * 0.1)) {
    throw new Error("framePower precisa ficar entre 0 e 10% de maxSpindle: o enquadramento só deve marcar de leve.");
  }
  if (!(config.frameFeed > 0)) throw new Error("frameFeed precisa ser maior que zero.");
  if (!config.serialPort) throw new Error('Configure serialPort (ex.: COM3, /dev/ttyUSB0 ou "sim" para o simulador).');
  if (!config.token || config.token === DEFAULT_TOKEN || config.token.length < 16) {
    throw new Error("Defina um token com pelo menos 16 caracteres em laserlink.config.json.");
  }
  return config;
}
