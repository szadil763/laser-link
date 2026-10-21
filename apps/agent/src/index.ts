import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type { ServerMessage } from "@laserlink/shared";
import { Agent, type ClientConn } from "./agent.js";
import { loadConfig } from "./config.js";
import { Grbl } from "./grbl.js";
import { JobLog } from "./job-log.js";
import { MaterialStore } from "./materials.js";
import { ProjectInbox } from "./projects.js";
import { NodeSerialLink, type SerialLink } from "./serial-link.js";
import { FakeGrbl } from "./sim/fake-grbl.js";
import { createStaticHandler } from "./static.js";

const config = loadConfig();
const simulated = config.serialPort === "sim";
const link: SerialLink = simulated ? new FakeGrbl({ msPerLine: 30 }) : new NodeSerialLink(config.serialPort, config.baudRate);
const grbl = new Grbl(link);
const jobLog = new JobLog(config.logDir);
const materials = new MaterialStore(config.dataDir);
const projects = config.projects ? new ProjectInbox(config.projects) : undefined;
const agent = new Agent({ config, grbl, jobLog, materials, projects, portLabel: simulated ? "simulador" : config.serialPort });

function tokenOk(given: string | null): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(config.token);
  return a.length === b.length && timingSafeEqual(a, b);
}

// A mesma porta serve a interface (arquivos estáticos, sem segredos) e o WebSocket (com token).
const server = createServer(createStaticHandler(config.webDir));
const wss = new WebSocketServer({ server });

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

server.on("error", (err) => {
  console.error(`Não foi possível escutar em ${config.host}:${config.wsPort}: ${err.message}`);
  process.exit(1);
});

server.listen(config.wsPort, config.host, () => {
  console.log(`LaserLink agente em http://${config.host}:${config.wsPort} (interface e WebSocket)`);
  if (simulated) console.log("Modo simulador: GRBL falso, nenhuma máquina conectada.");
  void agent.start();
});

function shutdown(): void {
  agent.shutdown();
  setTimeout(() => process.exit(0), 500);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
