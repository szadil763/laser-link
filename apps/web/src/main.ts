import "./styles.css";
import { PROTOCOL_VERSION, type JobInfo, type JobResult, type ServerMessage } from "@laserlink/shared";
import { confirmDialog } from "./confirm-dialog.js";
import { Connection, type LinkState } from "./connection.js";
import { Workspace } from "./prepare/workspace.js";
import { JobPreview } from "./preview.js";

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
let wakeLock: WakeLockSentinel | null = null;

/** Aberta pelo próprio agente (http://IP:8787), o endereço do WebSocket é o mesmo host. */
const servedByAgent = location.protocol === "http:" && location.port !== "5173";
try {
  urlInput.value = localStorage.getItem("laserlink.url") ?? (servedByAgent ? `ws://${location.host}` : "");
  // O token fica só nesta aba (sessionStorage): sobrevive a recarregar a página, não a fechar o navegador.
  tokenInput.value = sessionStorage.getItem("laserlink.token") ?? "";
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

let toastTimer: number | undefined;
function toast(text: string): void {
  const t = $("toast");
  t.textContent = text;
  t.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.hidden = true), 5000);
}

// ---------- abas ----------
const TABS = [
  ["tab-control", "view-control"],
  ["tab-prepare", "view-prepare"],
] as const;
function showTab(tabId: (typeof TABS)[number][0]): void {
  for (const [t, v] of TABS) {
    $(t).setAttribute("aria-selected", String(t === tabId));
    $(v).hidden = t !== tabId;
  }
  if (tabId === "tab-prepare") workspace.shown();
}
for (const [t] of TABS) $(t).addEventListener("click", () => showTab(t));

const preview = new JobPreview({ x: 400, y: 400 });
const workspace = new Workspace({
  confirm: confirmDialog,
  toast,
  send: (msg) => conn.send(msg),
  isConnected: () => conn.state === "connected" || conn.state === "unstable",
  onJobSent: (name, gcode) => {
    $("rejected").hidden = true;
    preview.load(name, gcode);
    showTab("tab-control");
    toast(`"${name}" enviado ao agente. Acompanhe aqui.`);
  },
});

const LINK_LABELS: Record<LinkState, [string, "ok" | "warn" | "bad"]> = {
  connected: ["Conectado", "ok"],
  unstable: ["Conexão instável", "warn"],
  connecting: ["Conectando…", "warn"],
  reconnecting: ["Reconectando…", "warn"],
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
  interrupted: "interrompido (o agente reiniciou)",
};

function renderResult(result: JobResult): void {
  const el = $("last-result");
  el.hidden = false;
  const at = new Date(result.endedAt).toLocaleTimeString("pt-BR");
  el.textContent = `Último trabalho: ${result.name}, ${OUTCOME_LABELS[result.outcome]} às ${at}. ${result.reason}`;
}

/** Mantém a tela do celular acesa enquanto este aparelho protege um trabalho. */
async function updateWakeLock(): Promise<void> {
  const want = currentJob?.ownedByYou === true && currentJob.state === "running" && document.visibilityState === "visible";
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
      if (msg.lastResult) renderResult(msg.lastResult);
      if (msg.lastResult && msg.lastResult.outcome !== "completed") {
        log(`Último trabalho: ${msg.lastResult.name}, ${OUTCOME_LABELS[msg.lastResult.outcome]}. ${msg.lastResult.reason}`);
      }
      $("limits").textContent =
        `Limites do agente: área ${msg.limits.workArea.x} × ${msg.limits.workArea.y} mm a partir da origem, potência até S${msg.limits.maxSpindle}.`;
      preview.setArea(msg.limits.workArea);
      workspace.setLimits(msg.limits);
      renderJob(msg.job);
      if (msg.job?.state === "connectionLost") log(`Atenção: "${msg.job.name}" está pausado por perda de conexão.`);
      break;
    case "status":
      $("state").textContent = msg.state;
      $("x").textContent = (msg.wpos ?? msg.mpos).x.toFixed(3);
      $("y").textContent = (msg.wpos ?? msg.mpos).y.toFixed(3);
      {
        const p = msg.wpos ?? msg.mpos;
        preview.setHead([p.x, p.y], msg.spindle);
        workspace.setHead([p.x, p.y]);
      }
      break;
    case "log":
      log(`[${msg.level}] ${msg.text}`);
      break;
    case "progress":
      if (currentJob) renderJob({ ...currentJob, sent: msg.sent, total: msg.total });
      preview.setProgress(msg.sent);
      break;
    case "materials":
      workspace.setMaterials(msg.materials);
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
    case "serial":
      renderSerial(msg.connected);
      break;
    case "pong":
      break;
    case "error":
      log(`ERRO: ${msg.message}`);
      break;
  }
}

async function resume(): Promise<void> {
  const ok = await confirmDialog(
    "Retomar o trabalho?",
    "Retomar religa o laser.\n\nConfirme que a peça não se moveu, a área está livre, a exaustão está ligada e que há alguém presente ou câmera ao vivo.",
    "Retomar e ligar o laser",
  );
  if (!ok) return;
  conn.send({ type: "resume", confirmLaserOn: true });
}

$("connect").addEventListener("click", () => {
  const base = urlInput.value.trim();
  if (!base || !tokenInput.value) {
    log("Informe o endereço do agente e o token.");
    return;
  }
  try {
    localStorage.setItem("laserlink.url", base);
    sessionStorage.setItem("laserlink.token", tokenInput.value);
  } catch {
    /* ignorar */
  }
  conn.connect(base, tokenInput.value);
});
$("disconnect").addEventListener("click", async () => {
  if (
    currentJob?.ownedByYou &&
    !(await confirmDialog("Desconectar?", "Desconectar pausa o trabalho em andamento e desliga o laser.", "Desconectar"))
  ) {
    return;
  }
  conn.disconnect();
});

// Reabriu a página com o token na aba: reconecta sozinho.
if (urlInput.value && tokenInput.value) conn.connect(urlInput.value.trim(), tokenInput.value);

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
$("resume").addEventListener("click", () => void resume());
$("alert-resume").addEventListener("click", () => void resume());
$("stop").addEventListener("click", () => conn.send({ type: "stop" }));
$("alert-cancel").addEventListener("click", () => {
  void confirmDialog("Cancelar o trabalho?", "Ele não poderá ser retomado.", "Cancelar trabalho", true).then((ok) => {
    if (ok) conn.send({ type: "stop" });
  });
});

$("start").addEventListener("click", async () => {
  const file = $<HTMLInputElement>("file").files?.[0];
  if (!file) {
    log("Escolha um arquivo G-code.");
    return;
  }
  const ok = await confirmDialog(
    `Iniciar "${file.name}"?`,
    "Isto liga o laser.\n\nConfirme que a área está livre, a exaustão ligada e que há alguém presente ou câmera ao vivo.\n\nMantenha esta aba aberta: se ela fechar ou perder a conexão, o agente pausa o trabalho.",
    "Iniciar e ligar o laser",
  );
  if (!ok) return;
  $("rejected").hidden = true;
  const gcode = await file.text();
  if (conn.send({ type: "job", name: file.name, gcode, confirmLaserOn: true })) preview.load(file.name, gcode);
});

// arquivo escolhido: mostra a trajetória antes de iniciar
$<HTMLInputElement>("file").addEventListener("change", async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (file) preview.load(file.name, await file.text());
});
