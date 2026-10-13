import type { ClientMessage, ServerMessage } from "@laserlink/shared";

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Elemento #${id} não encontrado`);
  return el as T;
};

const urlInput = $<HTMLInputElement>("url");
const tokenInput = $<HTMLInputElement>("token");
const logEl = $("log");

let ws: WebSocket | null = null;

try {
  urlInput.value = localStorage.getItem("laserlink.url") ?? "";
} catch {
  /* armazenamento indisponível */
}

function log(text: string): void {
  logEl.textContent += `${new Date().toLocaleTimeString("pt-BR")}  ${text}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

function send(msg: ClientMessage): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    log("Não conectado.");
    return;
  }
  ws.send(JSON.stringify(msg));
}

function onMessage(msg: ServerMessage): void {
  switch (msg.type) {
    case "hello":
      log(`Agente v${msg.version} · porta ${msg.port} · GRBL ${msg.connected ? "conectado" : "desconectado"}`);
      break;
    case "status":
      $("state").textContent = msg.state;
      $("x").textContent = msg.mpos.x.toFixed(3);
      $("y").textContent = msg.mpos.y.toFixed(3);
      break;
    case "log":
      log(`[${msg.level}] ${msg.text}`);
      break;
    case "progress": {
      const bar = $<HTMLProgressElement>("progress");
      bar.max = Math.max(1, msg.total);
      bar.value = msg.sent;
      break;
    }
    case "error":
      log(`ERRO: ${msg.message}`);
      break;
  }
}

$("connect").addEventListener("click", () => {
  ws?.close();
  const base = urlInput.value.trim();
  if (!base || !tokenInput.value) {
    log("Informe a URL e o token.");
    return;
  }
  try {
    localStorage.setItem("laserlink.url", base);
  } catch {
    /* ignorar */
  }
  ws = new WebSocket(`${base}/?token=${encodeURIComponent(tokenInput.value)}`);
  ws.onopen = () => log("Conectado.");
  ws.onclose = (e) => log(e.code === 4401 ? "Token inválido." : "Desconectado.");
  ws.onerror = () => log("Falha na conexão.");
  ws.onmessage = (e) => onMessage(JSON.parse(e.data as string) as ServerMessage);
});

document.querySelectorAll<HTMLButtonElement>(".jog button").forEach((btn) => {
  btn.addEventListener("click", () => {
    const axis = btn.dataset.axis === "Y" ? "Y" : "X";
    const dir = Number(btn.dataset.dir);
    const step = Number($<HTMLInputElement>("step").value);
    const feed = Number($<HTMLInputElement>("feed").value);
    send({ type: "jog", axis, distance: dir * step, feed });
  });
});

$("home").addEventListener("click", () => send({ type: "home" }));
$("origin").addEventListener("click", () => send({ type: "setOrigin" }));
$("unlock").addEventListener("click", () => send({ type: "unlock" }));
$("hold").addEventListener("click", () => send({ type: "hold" }));
$("resume").addEventListener("click", () => send({ type: "resume" }));
$("stop").addEventListener("click", () => send({ type: "stop" }));

$("start").addEventListener("click", async () => {
  const file = $<HTMLInputElement>("file").files?.[0];
  if (!file) {
    log("Escolha um arquivo G-code.");
    return;
  }
  const ok = window.confirm(
    `Iniciar "${file.name}"?\n\nConfirme que a área está livre, a exaustão ligada e que há alguém presente ou câmera ao vivo.`,
  );
  if (!ok) return;
  send({ type: "job", name: file.name, gcode: await file.text() });
});
