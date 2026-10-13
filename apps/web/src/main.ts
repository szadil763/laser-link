import { PROTOCOL_VERSION, type JobInfo, type JobResult, type ServerMessage } from "@laserlink/shared";
import { Connection, type LinkState } from "./connection.js";

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Elemento #${id} não encontrado`);
  return el as T;
};

const urlInput = $<HTMLInputElement>("url");
const tokenInput = $<HTMLInputElement>("token");
const logEl = $("log");

let reconnectGraceSec = 60;
let currentJob: JobInfo | null = null;
/** Este navegador iniciou ou retomou o trabalho atual (o heartbeat dele protege o trabalho). */
let ownJob = false;
let wakeLock: WakeLockSentinel | null = null;

try {
  urlInput.value = localStorage.getItem("laserlink.url") ?? "";
} catch {
  /* armazenamento indisponível */
}

function log(text: string): void {
  logEl.textContent += `${new Date().toLocaleTimeString("pt-BR")}  ${text}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

const conn = new Connection({
  onMessage,
  onState: renderLinkState,
  onLog: log,
});

const LINK_LABELS: Record<LinkState, [string, "ok" | "warn" | "bad"]> = {
  connected: ["Conectado", "ok"],
  unstable: ["Conexão instável", "warn"],
  connecting: ["Conectando…", "warn"],
  disconnected: ["Desconectado", "bad"],
};

function renderLinkState(state: LinkState): void {
  const badge = $("link-badge");
  const [label, level] = LINK_LABELS[state];
  badge.textContent = label;
  badge.dataset.level = level;
}

function renderSerial(connected: boolean): void {
  const badge = $("serial-badge");
  badge.textContent = connected ? "Laser conectada" : "Laser desconectada";
  badge.dataset.level = connected ? "ok" : "bad";
}

const STATE_LABELS: Record<JobInfo["state"], string> = {
  running: "em andamento",
  paused: "pausado",
  connectionLost: "pausado por perda de conexão",
};

function renderJob(job: JobInfo | null): void {
  currentJob = job;
  if (!job) ownJob = false;
  $("job-line").textContent = job
    ? `${job.name}: ${STATE_LABELS[job.state]} (${job.sent}/${job.total} linhas)`
    : "Nenhum trabalho em andamento.";
  const bar = $<HTMLProgressElement>("progress");
  bar.max = Math.max(1, job?.total ?? 1);
  bar.value = job?.sent ?? 0;

  const alert = $("job-alert");
  alert.hidden = job?.state !== "connectionLost";
  if (job?.state === "connectionLost") {
    $("job-alert-text").textContent = `"${job.name}" foi pausado com o laser desligado. Motivo: ${job.reason ?? "perda de conexão"}`;
    $("job-alert-hint").textContent =
      `Confira a máquina antes de retomar. Se nenhum computador estiver conectado por ${reconnectGraceSec} s, o agente cancela o trabalho.`;
  }
  void updateWakeLock();
}

const OUTCOME_LABELS: Record<JobResult["outcome"], string> = {
  completed: "concluído",
  aborted: "cancelado",
  error: "interrompido por erro",
};

function renderResult(result: JobResult): void {
  const el = $("last-result");
  el.hidden = false;
  const at = new Date(result.endedAt).toLocaleTimeString("pt-BR");
  el.textContent = `Último trabalho: ${result.name}, ${OUTCOME_LABELS[result.outcome]} às ${at}. ${result.reason}`;
}

/** Mantém a tela do celular acesa enquanto este aparelho protege um trabalho. */
async function updateWakeLock(): Promise<void> {
  const want = ownJob && currentJob?.state === "running" && document.visibilityState === "visible";
  try {
    if (want && !wakeLock && "wakeLock" in navigator) {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => {
        wakeLock = null;
      });
    } else if (!want && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch {
    /* sem suporte ou negado: segue sem */
  }
}
document.addEventListener("visibilitychange", () => void updateWakeLock());

function onMessage(msg: ServerMessage): void {
  switch (msg.type) {
    case "hello":
      if (msg.version !== PROTOCOL_VERSION) {
        log(`Aviso: agente usa protocolo ${msg.version} e esta interface ${PROTOCOL_VERSION}. Atualize os dois.`);
      }
      log(`Agente v${msg.version} · porta ${msg.port} · GRBL ${msg.connected ? "conectado" : "desconectado"}`);
      reconnectGraceSec = msg.reconnectGraceSec;
      renderSerial(msg.connected);
      $("limits").textContent =
        `Limites do agente: área ${msg.limits.workArea.x} × ${msg.limits.workArea.y} mm a partir da origem, potência até S${msg.limits.maxSpindle}.`;
      renderJob(msg.job);
      if (msg.job?.state === "connectionLost") log(`Atenção: "${msg.job.name}" está pausado por perda de conexão.`);
      break;
    case "status":
      $("state").textContent = msg.state;
      $("x").textContent = (msg.wpos ?? msg.mpos).x.toFixed(3);
      $("y").textContent = (msg.wpos ?? msg.mpos).y.toFixed(3);
      break;
    case "log":
      log(`[${msg.level}] ${msg.text}`);
      break;
    case "progress":
      if (currentJob) renderJob({ ...currentJob, sent: msg.sent, total: msg.total });
      break;
    case "job":
      renderJob(msg.job);
      break;
    case "jobEnded":
      renderResult(msg.result);
      log(`Trabalho ${OUTCOME_LABELS[msg.result.outcome]}: ${msg.result.reason}`);
      break;
    case "jobRejected": {
      $("rejected").hidden = false;
      $("rejected-title").textContent = `"${msg.name}" foi recusado. Nada foi enviado à laser. Corrija o arquivo ou os limites do agente:`;
      const list = $("rejected-list");
      list.replaceChildren(
        ...msg.problems.map((p) => {
          const li = document.createElement("li");
          li.textContent = p.line > 0 ? `Linha ${p.line} (${p.text}): ${p.message}` : p.message;
          return li;
        }),
      );
      if (msg.bounds) {
        const b = msg.bounds;
        const li = document.createElement("li");
        li.textContent = `O trabalho ocupa de X${b.minX.toFixed(1)} Y${b.minY.toFixed(1)} a X${b.maxX.toFixed(1)} Y${b.maxY.toFixed(1)} mm.`;
        list.append(li);
      }
      log(`Trabalho recusado: ${msg.name} (${msg.problems.length} problema(s)).`);
      break;
    }
    case "pong":
      break;
    case "error":
      log(`ERRO: ${msg.message}`);
      break;
  }
}

function confirmResume(): boolean {
  return window.confirm(
    "Retomar religa o laser.\n\nConfirme que a peça não se moveu, a área está livre, a exaustão está ligada e que há alguém presente ou câmera ao vivo.",
  );
}

function resume(): void {
  if (!confirmResume()) return;
  if (conn.send({ type: "resume", confirmLaserOn: true })) ownJob = true;
}

$("connect").addEventListener("click", () => {
  const base = urlInput.value.trim();
  if (!base || !tokenInput.value) {
    log("Informe o endereço do agente e o token.");
    return;
  }
  try {
    localStorage.setItem("laserlink.url", base);
  } catch {
    /* ignorar */
  }
  conn.connect(base, tokenInput.value);
});
$("disconnect").addEventListener("click", () => conn.disconnect());

document.querySelectorAll<HTMLButtonElement>(".jog button").forEach((btn) => {
  btn.addEventListener("click", () => {
    const axis = btn.dataset.axis === "Y" ? "Y" : "X";
    const dir = Number(btn.dataset.dir);
    const step = Number($<HTMLInputElement>("step").value);
    const feed = Number($<HTMLInputElement>("feed").value);
    conn.send({ type: "jog", axis, distance: dir * step, feed });
  });
});

$("home").addEventListener("click", () => conn.send({ type: "home" }));
$("origin").addEventListener("click", () => conn.send({ type: "setOrigin" }));
$("unlock").addEventListener("click", () => conn.send({ type: "unlock" }));
$("hold").addEventListener("click", () => conn.send({ type: "hold" }));
$("resume").addEventListener("click", resume);
$("alert-resume").addEventListener("click", resume);
$("stop").addEventListener("click", () => conn.send({ type: "stop" }));
$("alert-cancel").addEventListener("click", () => {
  if (window.confirm("Cancelar o trabalho? Ele não poderá ser retomado.")) conn.send({ type: "stop" });
});

$("start").addEventListener("click", async () => {
  const file = $<HTMLInputElement>("file").files?.[0];
  if (!file) {
    log("Escolha um arquivo G-code.");
    return;
  }
  const ok = window.confirm(
    `Iniciar "${file.name}"? Isto liga o laser.\n\nConfirme que a área está livre, a exaustão ligada e que há alguém presente ou câmera ao vivo.\n\nMantenha esta aba aberta: se ela fechar ou perder a conexão, o agente pausa o trabalho.`,
  );
  if (!ok) return;
  $("rejected").hidden = true;
  if (conn.send({ type: "job", name: file.name, gcode: await file.text(), confirmLaserOn: true })) ownJob = true;
});
