import { randomUUID, timingSafeEqual } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import type { ServerMessage } from "@laserlink/shared";
import { Agent, type ClientConn } from "./agent.js";
import { loadConfig } from "./config.js";
import { Grbl } from "./grbl.js";
import { JobLog } from "./job-log.js";
import { NodeSerialLink, type SerialLink } from "./serial-link.js";
import { FakeGrbl } from "./sim/fake-grbl.js";

const config = loadConfig();
const simulated = config.serialPort === "sim";
const link: SerialLink = simulated ? new FakeGrbl({ msPerLine: 30 }) : new NodeSerialLink(config.serialPort, config.baudRate);
const grbl = new Grbl(link);
const jobLog = new JobLog(config.logDir);
const agent = new Agent({ config, grbl, jobLog, portLabel: simulated ? "simulador" : config.serialPort });

function tokenOk(given: string | null): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(config.token);
  return a.length === b.length && timingSafeEqual(a, b);
}

const wss = new WebSocketServer({ port: config.wsPort });

wss.on("connection", (ws, req) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (!tokenOk(url.searchParams.get("token"))) {
    ws.close(4401, "token inválido");
    return;
  }
  const client: ClientConn = {
    id: randomUUID(),
    send(msg: ServerMessage) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    },
  };
  agent.connect(client);

  ws.on("message", (data) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString());
    } catch {
      parsed = null;
    }
    agent.receive(client, parsed);
  });
  ws.on("close", () => agent.disconnect(client));
  ws.on("error", () => ws.close());
});

async function main(): Promise<void> {
  try {
    await grbl.open();
    console.log(
      simulated ? "Modo simulador: GRBL falso, nenhuma máquina conectada." : `GRBL conectado em ${config.serialPort} @ ${config.baudRate}`,
    );
  } catch (err) {
    console.error(`Falha ao abrir ${config.serialPort}:`, (err as Error).message);
    process.exit(1);
  }
  console.log(`LaserLink agente ouvindo em ws://0.0.0.0:${config.wsPort}`);
}

process.on("SIGINT", () => {
  agent.shutdown();
  setTimeout(() => process.exit(0), 500);
});

void main();
