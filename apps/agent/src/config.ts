import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Area, MachineLimits } from "./gcode-check.js";

export interface AgentConfig {
  serialPort: string;
  baudRate: number;
  wsPort: number;
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
}

/** apps/agent/logs, tanto rodando de src/ (tsx) quanto de dist/ (node). */
const DEFAULT_LOG_DIR = fileURLToPath(new URL("../logs/", import.meta.url));

const DEFAULT_TOKEN = "TROQUE-POR-UM-TOKEN-LONGO-E-ALEATORIO";

export function loadConfig(): AgentConfig {
  const candidates = [
    resolve(process.cwd(), "laserlink.config.json"),
    resolve(process.cwd(), "../../laserlink.config.json"),
  ];
  const path = candidates.find((p) => existsSync(p));
  if (!path) {
    throw new Error(
      "laserlink.config.json não encontrado. Copie apps/agent/laserlink.config.example.json para a raiz do projeto e edite.",
    );
  }
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<AgentConfig>;
  const config: AgentConfig = {
    serialPort: raw.serialPort ?? "",
    baudRate: raw.baudRate ?? 115200,
    wsPort: raw.wsPort ?? 8787,
    token: raw.token ?? "",
    maxFeed: raw.maxFeed ?? 6000,
    reconnectGraceSec: raw.reconnectGraceSec ?? 60,
    maxSpindle: raw.maxSpindle ?? 1000,
    workArea: raw.workArea ?? { x: 0, y: 0 },
    logDir: raw.logDir ? resolve(path, "..", raw.logDir) : DEFAULT_LOG_DIR,
  };
  if (raw.machineLimits) config.machineLimits = raw.machineLimits;
  if (!(config.maxSpindle > 0)) throw new Error("maxSpindle precisa ser maior que zero (use o valor do $30 do GRBL).");
  if (!(config.workArea.x > 0 && config.workArea.y > 0)) {
    throw new Error('Configure a área útil em mm, por exemplo "workArea": { "x": 400, "y": 400 }.');
  }
  if (!config.serialPort) throw new Error('Configure serialPort (ex.: COM3, /dev/ttyUSB0 ou "sim" para o simulador).');
  if (!config.token || config.token === DEFAULT_TOKEN || config.token.length < 16) {
    throw new Error("Defina um token com pelo menos 16 caracteres em laserlink.config.json.");
  }
  return config;
}
