import { timingSafeEqual } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { PROTOCOL_VERSION, type ClientMessage, type ServerMessage } from "@laserlink/shared";
import { loadConfig } from "./config.js";
import { Grbl, type GrblStatus } from "./grbl.js";

const config = loadConfig();
const grbl = new Grbl(config.serialPort, config.baudRate);

const clients = new Set<WebSocket>();
let lastStatus: GrblStatus | null = null;

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(msg: ServerMessage): void {
  for (const ws of clients) send(ws, msg);
}

function tokenOk(given: string | null): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(config.token);
  return a.length === b.length && timingSafeEqual(a, b);
}

grbl.on("status", (s) => {
  lastStatus = s;
  broadcast({ type: "status", ...s });
});
grbl.on("log", (level, text) => broadcast({ type: "log", level, text }));
grbl.on("progress", (p) => broadcast({ type: "progress", ...p }));
grbl.on("closed", () => broadcast({ type: "error", message: "Porta serial fechada." }));

function handle(ws: WebSocket, msg: ClientMessage): void {
  switch (msg.type) {
    case "jog": {
      const feed = Math.min(Math.max(1, msg.feed), config.maxFeed);
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
      break;
    case "resume":
      grbl.cycleResume();
      break;
    case "stop":
      grbl.abortJob();
      break;
    case "unlock":
      grbl.sendLine("$X");
      break;
    case "job":
      if (!grbl.startJob(msg.gcode)) {
        send(ws, { type: "error", message: "Não foi possível iniciar (trabalho em andamento ou arquivo vazio)." });
      } else {
        broadcast({ type: "log", level: "info", text: `Iniciando: ${msg.name}` });
      }
      break;
  }
}

/** Segurança: sem nenhum cliente conectado e com trabalho rodando, pausa e desliga o laser. */
function safetyStopIfOrphaned(): void {
  if (clients.size === 0 && grbl.isRunning) {
    console.warn("[segurança] cliente desconectou durante o trabalho: hold + M5");
    grbl.abortJob();
  }
}

const wss = new WebSocketServer({ port: config.wsPort });

wss.on("connection", (ws, req) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (!tokenOk(url.searchParams.get("token"))) {
    ws.close(4401, "token inválido");
    return;
  }
  clients.add(ws);
  send(ws, { type: "hello", version: PROTOCOL_VERSION, port: config.serialPort, connected: grbl.isOpen });
  if (lastStatus) send(ws, { type: "status", ...lastStatus });

  ws.on("message", (data) => {
    try {
      handle(ws, JSON.parse(data.toString()) as ClientMessage);
    } catch {
      send(ws, { type: "error", message: "Mensagem inválida." });
    }
  });
  ws.on("close", () => {
    clients.delete(ws);
    safetyStopIfOrphaned();
  });
  ws.on("error", () => ws.close());
});

async function main(): Promise<void> {
  try {
    await grbl.open();
    console.log(`GRBL conectado em ${config.serialPort} @ ${config.baudRate}`);
  } catch (err) {
    console.error(`Falha ao abrir ${config.serialPort}:`, (err as Error).message);
    process.exit(1);
  }
  console.log(`LaserLink agente ouvindo em ws://0.0.0.0:${config.wsPort}`);
}

process.on("SIGINT", () => {
  if (grbl.isRunning) grbl.abortJob();
  setTimeout(() => process.exit(0), 500);
});

void main();
