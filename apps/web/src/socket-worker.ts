// O WebSocket com o agente mora aqui, fora da página. Assim o sinal de vida (ping) continua
// saindo mesmo quando a página está ocupada (desenho grande, geração de G-code, aba em
// segundo plano). Página travada ≠ pessoa ausente: o agente só pausa se o socket cair
// ou se este processo parar de mandar sinal.
import type { SocketCommand, SocketEvent } from "./connection.js";

const ctx = self as unknown as { postMessage(msg: SocketEvent): void; onmessage: ((e: MessageEvent<SocketCommand>) => void) | null };

let ws: WebSocket | null = null;
let timer: ReturnType<typeof setInterval> | undefined;

function stopPing(): void {
  if (timer !== undefined) clearInterval(timer);
  timer = undefined;
}

ctx.onmessage = (e) => {
  const cmd = e.data;
  if (cmd.cmd === "open") {
    stopPing();
    ws?.close();
    let sock: WebSocket;
    try {
      sock = new WebSocket(cmd.url);
    } catch {
      ctx.postMessage({ ev: "invalid" });
      return;
    }
    ws = sock;
    sock.onopen = () => {
      if (ws !== sock) return;
      ctx.postMessage({ ev: "open" });
      const ping = (): void => {
        if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ type: "ping", t: Date.now() }));
      };
      ping();
      timer = setInterval(ping, cmd.pingMs);
    };
    sock.onmessage = (m) => {
      if (ws === sock) ctx.postMessage({ ev: "message", data: String(m.data) });
    };
    sock.onclose = (c) => {
      if (ws !== sock) return;
      stopPing();
      ws = null;
      ctx.postMessage({ ev: "close", code: c.code });
    };
  } else if (cmd.cmd === "send") {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(cmd.data);
  } else if (cmd.cmd === "close") {
    stopPing();
    const sock = ws;
    ws = null;
    sock?.close();
  }
};
