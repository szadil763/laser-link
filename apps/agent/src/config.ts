import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface AgentConfig {
  serialPort: string;
  baudRate: number;
  wsPort: number;
  token: string;
  maxFeed: number;
}

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
  };
  if (!config.serialPort) throw new Error("Configure serialPort (ex.: COM3 ou /dev/ttyUSB0).");
  if (!config.token || config.token === DEFAULT_TOKEN || config.token.length < 16) {
    throw new Error("Defina um token com pelo menos 16 caracteres em laserlink.config.json.");
  }
  return config;
}
