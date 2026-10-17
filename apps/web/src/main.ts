import "./styles.css";
import { PROTOCOL_VERSION, type JobInfo, type JobResult, type QueueItem, type ServerMessage } from "@laserlink/shared";
import { chime } from "./chime.js";
import { confirmDialog } from "./confirm-dialog.js";
import { Connection, type LinkState } from "./connection.js";
import { Workspace } from "./prepare/workspace.js";
import { JobPreview } from "./preview.js";
import { bedTheme, setBedTheme } from "./theme.js";
import type { Point } from "@laserlink/gcode";

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
let queue: QueueItem[] = [];
/** G-code dos trabalhos que esta aba guardou na fila, para a pré-visualização quando forem iniciados. */
const queuedGcode = new Map<string, string>();
const soundInput = $<HTMLInputElement>("sound-on");
const rememberInput = $<HTMLInputElement>("remember-token");
/** Token da última tentativa de conexão; só é salvo quando o agente aceita (mensagem hello). */
let pendingToken: string | null = null;

/** Aberta pelo próprio agente (http://IP:8787), o endereço do WebSocket é o mesmo host. */
const servedByAgent = location.protocol === "http:" && location.port !== "5173";
try {
  urlInput.value = localStorage.getItem("laserlink.url") ?? (servedByAgent ? `ws://${location.host}` : "");
  // "Lembrar" (padrão): token no localStorage deste navegador. Sem lembrar: só nesta aba (sessionStorage).
  rememberInput.checked = localStorage.getItem("laserlink.remember") !== "off";
  tokenInput.value = localStorage.getItem("laserlink.token") ?? sessionStorage.getItem("laserlink.token") ?? "";
  soundInput.checked = localStorage.getItem("laserlink.sound") !== "off";
} catch {
  /* armazenamento indisponível */
}
soundInput.addEventListener("change", () => {
  try {
    localStorage.setItem("laserlink.sound", soundInput.checked ? "on" : "off");
  } catch {
    /* ignorar */
  }
});

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

// ---------- janelas: Camadas, Máquina, Fila e Registro numa coluna só ----------
const SIDE_TABS = [
  ["st-layers", "sp-layers"],
  ["st-machine", "sp-machine"],
  ["st-queue", "sp-queue"],
  ["st-log", "sp-log"],
] as const;
type SideTab = (typeof SIDE_TABS)[number][0];
function showSide(tabId: SideTab): void {
  for (const [t, panel] of SIDE_TABS) {
    $(t).setAttribute("aria-selected", String(t === tabId));
    $(panel).hidden = t !== tabId;
  }
  if (tabId === "st-log") logEl.scrollTop = logEl.scrollHeight;
}
for (const [t] of SIDE_TABS) $(t).addEventListener("click", () => showSide(t));

/** Ampliada, a janela cobre a mesa (só no computador) e mostra tudo sem rolar. A mesa não muda de tamanho. */
function setSideWide(wide: boolean): void {
  $("side").classList.toggle("wide", wide);
  $("side-wide").setAttribute("aria-pressed", String(wide));
  $("side-wide").title = wide ? "Reduzir a janela (Esc)" : "Ampliar a janela sobre a mesa (Esc volta)";
  markOverflow();
}
const sideIsWide = (): boolean => $("side").classList.contains("wide");
$("side-wide").addEventListener("click", () => setSideWide(!sideIsWide()));
// destaca o botão de ampliar quando a janela ativa não cabe inteira na coluna
const sideBody = document.querySelector<HTMLElement>(".side-body")!;
function markOverflow(): void {
  $("side-wide").classList.toggle("more", !sideIsWide() && sideBody.scrollHeight > sideBody.clientHeight + 4);
}
new ResizeObserver(markOverflow).observe(sideBody);
for (const [, panel] of SIDE_TABS) new ResizeObserver(markOverflow).observe($(panel));

/** Abre uma janela pelo menu ou atalho: troca a aba e, no celular, rola até ela. */
function openWindow(tabId: SideTab): void {
  showSide(tabId);
  if (!window.matchMedia("(min-width: 980px) and (min-height: 560px)").matches) {
    $("side").scrollIntoView({ behavior: "smooth", block: "start" });
  }
  $(tabId).focus();
}
$("win-menu").addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-win]");
  if (!btn) return;
  $<HTMLDetailsElement>("win-menu").open = false;
  const v = btn.dataset.win;
  if (v === "wide") setSideWide(!sideIsWide());
  else openWindow(v as SideTab);
});
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && sideIsWide() && !document.querySelector("dialog[open]")) {
    setSideWide(false);
    return;
  }
  if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  const n = "01234".indexOf(e.key);
  if (n < 0) return;
  e.preventDefault();
  if (n === 0) setSideWide(!sideIsWide());
  else openWindow(SIDE_TABS[n - 1][0]);
});

// ---------- mesa: Desenho ou Na máquina ----------
type View = "design" | "machine";
function showView(view: View): void {
  const design = view === "design";
  $("view-design").setAttribute("aria-selected", String(design));
  $("view-machine").setAttribute("aria-selected", String(!design));
  $("p-box").hidden = !design;
  $("p-legend").hidden = !design;
  $("c-box").hidden = design;
  $("c-legend").hidden = design;
  if (design) workspace.shown();
}
$("view-design").addEventListener("click", () => showView("design"));
$("stage-clear").addEventListener("click", () => {
  if (!$("p-box").hidden) return void workspace.clear();
  if (currentJob) return toast("Há um trabalho em andamento: a mesa mostra o progresso dele. Pare ou espere terminar para limpar.");
  preview.clear();
  $<HTMLInputElement>("file").value = "";
});
$("view-machine").addEventListener("click", () => showView("machine"));

// ---------- mesa clara ou escura ----------
function renderBedTheme(): void {
  const light = bedTheme() === "light";
  $("bed-theme-label").textContent = light ? "Mesa escura" : "Mesa clara";
  $("bed-theme").setAttribute("aria-label", light ? "Trocar para mesa escura" : "Trocar para mesa clara");
}
$("bed-theme").addEventListener("click", () => {
  setBedTheme(bedTheme() === "light" ? "dark" : "light");
  renderBedTheme();
});
renderBedTheme();

function showCursor(mm: Point | null): void {
  $("sb-cursor").textContent = mm ? `Cursor: X ${mm[0].toFixed(1)} Y ${mm[1].toFixed(1)} mm` : "Cursor: —";
}

const preview = new JobPreview({ x: 400, y: 400 }, showCursor);
const workspace = new Workspace({
  confirm: confirmDialog,
  toast,
  send: (msg) => conn.send(msg),
  isConnected: () => conn.state === "connected" || conn.state === "unstable",
  onJobSent: (name, gcode) => {
    $("rejected").hidden = true;
    preview.load(name, gcode);
    showView("machine");
    toast(`"${name}" enviado ao agente. Acompanhe na mesa "Na máquina".`);
  },
  onQueued: (name, gcode) => {
    $("rejected").hidden = true;
    queuedGcode.set(name, gcode);
  },
  onCursor: showCursor,
});

const LINK_LABELS: Record<LinkState, [string, "ok" | "warn" | "bad"]> = {
  connected: ["Conectado", "ok"],
  unstable: ["Conexão instável", "warn"],
  connecting: ["Conectando…", "warn"],
  reconnecting: ["Reconectando…", "warn"],
  disconnected: ["Desconectado", "bad"],
};

/** Guarda o token que o agente aceitou: no computador ou só na aba, conforme a opção. */
function saveToken(token: string): void {
  try {
    if (rememberInput.checked) {
      localStorage.setItem("laserlink.token", token);
      sessionStorage.removeItem("laserlink.token");
    } else {
      sessionStorage.setItem("laserlink.token", token);
      localStorage.removeItem("laserlink.token");
    }
  } catch {
    /* armazenamento indisponível */
  }
}

function renderLinkState(state: LinkState): void {
  const badge = $("link-badge");
  const [label, level] = LINK_LABELS[state];
  badge.textContent = label;
  badge.dataset.level = level;
  // conectado, a seção Conexão se recolhe e deixa espaço para o resto da janela Máquina
  $("conn-sum").textContent = label;
  const conn = $<HTMLDetailsElement>("conn-box");
  if (state === "connected") conn.open = false;
  else if (state === "disconnected") conn.open = true;
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
  $("dock-job").hidden = !job;
  // com trabalho rodando, o resumo e o enquadrar só ocupam espaço
  $("sendbar").classList.toggle("job-on", job !== null);
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
  renderQueue();
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

// ---------- fila ----------

function fmtDuration(sec: number): string {
  if (sec < 60) return `${Math.max(1, Math.round(sec))} s`;
  const m = Math.round(sec / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
}

function button(text: string, onClick: () => void, opts: { label?: string; cls?: string; disabled?: boolean } = {}): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = text;
  if (opts.label) b.setAttribute("aria-label", opts.label);
  if (opts.cls) b.className = opts.cls;
  b.disabled = opts.disabled ?? false;
  b.addEventListener("click", onClick);
  return b;
}

function renderQueue(): void {
  const list = $("queue-list");
  $("queue-empty").hidden = queue.length > 0;
  $("queue-count").textContent = queue.length ? `(${queue.length})` : "";
  const busy = currentJob !== null;
  list.replaceChildren(
    ...queue.map((item, i) => {
      const li = document.createElement("li");
      const name = document.createElement("div");
      name.className = "q-name";
      name.textContent = item.name;
      const meta = document.createElement("div");
      meta.className = "q-meta";
      const size = item.bounds ? ` · ${(item.bounds.maxX - item.bounds.minX).toFixed(0)} × ${(item.bounds.maxY - item.bounds.minY).toFixed(0)} mm` : "";
      meta.textContent = `~${fmtDuration(item.estimatedSec)} · ${item.lines} linhas${size}`;
      const row = document.createElement("div");
      row.className = "row";
      row.append(
        button("Iniciar", () => void startQueued(item), {
          cls: "warn",
          disabled: busy,
          label: busy ? `Iniciar ${item.name} (espere o trabalho atual terminar)` : `Iniciar ${item.name}`,
        }),
        button("↑", () => conn.send({ type: "queueMove", id: item.id, index: i - 1 }), { label: `Subir ${item.name}`, disabled: i === 0 }),
        button("↓", () => conn.send({ type: "queueMove", id: item.id, index: i + 1 }), { label: `Descer ${item.name}`, disabled: i === queue.length - 1 }),
        button("Tirar da fila", () => void removeQueued(item)),
      );
      li.append(name, meta, row);
      return li;
    }),
  );
  renderNext();
}

async function startQueued(item: QueueItem): Promise<void> {
  const ok = await confirmDialog(
    `Iniciar "${item.name}"?`,
    `Isto liga o laser. Tempo estimado: ${fmtDuration(item.estimatedSec)}.\n\nTroque o material se precisar, confira a origem, a área livre e a exaustão ligada, e mantenha alguém presente ou câmera ao vivo.\n\nMantenha esta aba aberta: se ela fechar ou perder a conexão, o agente pausa o trabalho.`,
    "Iniciar e ligar o laser",
  );
  if (!ok) return;
  $("rejected").hidden = true;
  if (conn.send({ type: "queueStart", id: item.id, confirmLaserOn: true })) {
    hideDone();
    const gcode = queuedGcode.get(item.name);
    if (gcode) preview.load(item.name, gcode);
    showView("machine");
  }
}

async function removeQueued(item: QueueItem): Promise<void> {
  if (await confirmDialog(`Tirar "${item.name}" da fila?`, "O arquivo sai do agente. Para cortar depois, envie de novo.", "Tirar da fila")) {
    conn.send({ type: "queueRemove", id: item.id });
  }
}

// ---------- aviso de fim de trabalho ----------

const TITLE = document.title;

function hideDone(): void {
  $("done-banner").hidden = true;
  document.title = TITLE;
}

/** Mostra o próximo da fila no aviso, se ele estiver aberto. */
function renderNext(): void {
  const next = queue[0];
  const canStart = next !== undefined && currentJob === null;
  $("done-next").hidden = !next;
  $("done-next").textContent = next ? `Próximo da fila: ${next.name} (~${fmtDuration(next.estimatedSec)}). Ele só começa quando você confirmar.` : "";
  $("done-start-next").hidden = !canStart;
}

function announceEnd(result: JobResult): void {
  // Enquadrar também termina como trabalho, mas não precisa de aviso.
  if (result.name.startsWith("Enquadrar")) return;
  const ok = result.outcome === "completed";
  const banner = $("done-banner");
  banner.dataset.outcome = ok ? "ok" : "bad";
  $("done-title").textContent = ok ? `Trabalho concluído: ${result.name}` : `Trabalho ${OUTCOME_LABELS[result.outcome]}: ${result.name}`;
  $("done-text").textContent = ok
    ? `Terminou às ${new Date(result.endedAt).toLocaleTimeString("pt-BR")}. Espere a fumaça sair antes de abrir a tampa.`
    : result.reason;
  renderNext();
  banner.hidden = false;
  document.title = `${ok ? "✔ Concluído" : "⚠ Parou"} · ${TITLE}`;
  if (soundInput.checked) chime(ok ? "ok" : "bad");
}

$("done-close").addEventListener("click", hideDone);
$("done-start-next").addEventListener("click", () => {
  const next = queue[0];
  if (next) void startQueued(next);
});

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
      // o agente só manda o hello depois de aceitar o token
      if (pendingToken) {
        saveToken(pendingToken);
        pendingToken = null;
      }
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
    case "queue":
      queue = msg.items;
      renderQueue();
      break;
    case "jobEnded":
      renderResult(msg.result);
      announceEnd(msg.result);
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
      toast(msg.message);
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
  } catch {
    /* ignorar */
  }
  pendingToken = tokenInput.value;
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
if (urlInput.value && tokenInput.value) {
  pendingToken = tokenInput.value;
  conn.connect(urlInput.value.trim(), tokenInput.value);
}

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
// ---------- origem do trabalho ----------
const ANCHOR_NAMES: Record<string, string> = {
  tl: "o canto de cima, à esquerda,",
  tc: "o meio de cima",
  tr: "o canto de cima, à direita,",
  ml: "o meio da esquerda",
  mc: "o centro",
  mr: "o meio da direita",
  bl: "o canto de baixo, à esquerda,",
  bc: "o meio de baixo",
  br: "o canto de baixo, à direita,",
};
let anchor = "bl";
try {
  anchor = localStorage.getItem("laserlink.anchor") ?? "bl";
} catch {
  /* armazenamento indisponível */
}
function showAnchor(): void {
  for (const b of $("origin-anchor").querySelectorAll<HTMLButtonElement>("button[data-a]")) b.setAttribute("aria-pressed", String(b.dataset.a === anchor));
}
showAnchor();
$("origin-anchor").addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-a]");
  if (!btn?.dataset.a) return;
  anchor = btn.dataset.a;
  showAnchor();
  try {
    localStorage.setItem("laserlink.anchor", anchor);
  } catch {
    /* armazenamento indisponível */
  }
});
$("origin").addEventListener("click", () => {
  if (conn.send({ type: "setOrigin" })) toast("Origem definida: o carrinho agora é o canto 0,0 da mesa.");
  else toast("Sem conexão com o agente. Conecte na seção Conexão e tente de novo.");
});
$("origin-design").addEventListener("click", () => {
  const pt = workspace.anchorPoint(anchor);
  if (!pt) return toast("Não há desenho na mesa. Desenhe ou importe algo e tente de novo.");
  const [x, y] = pt.p;
  if (conn.send({ type: "setOrigin", x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000 })) {
    toast(`Origem definida: o carrinho agora é ${ANCHOR_NAMES[anchor]} ${pt.what} (X${x.toFixed(1)} Y${y.toFixed(1)}). Use Enquadrar para conferir antes de cortar.`);
  } else toast("Sem conexão com o agente. Conecte na seção Conexão e tente de novo.");
});
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
  if (conn.send({ type: "job", name: file.name, gcode, confirmLaserOn: true })) {
    preview.load(file.name, gcode);
    showView("machine");
  }
});

$("enqueue").addEventListener("click", async () => {
  const file = $<HTMLInputElement>("file").files?.[0];
  if (!file) {
    log("Escolha um arquivo G-code.");
    return;
  }
  $("rejected").hidden = true;
  const gcode = await file.text();
  if (conn.send({ type: "queueAdd", name: file.name, gcode })) {
    queuedGcode.set(file.name, gcode);
    toast(`"${file.name}" enviado para a fila. O agente confere antes de guardar.`);
  }
});

// arquivo escolhido: mostra a trajetória antes de iniciar
$<HTMLInputElement>("file").addEventListener("change", async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (file) {
    preview.load(file.name, await file.text());
    showView("machine");
  }
});

$("rejected-close").addEventListener("click", () => ($("rejected").hidden = true));

// Sem endereço ou token salvos: começa pela aba Máquina, onde fica a conexão.
if (!urlInput.value || !tokenInput.value) showSide("st-machine");

rememberInput.addEventListener("change", () => {
  try {
    localStorage.setItem("laserlink.remember", rememberInput.checked ? "on" : "off");
  } catch {
    /* ignorar */
  }
  // já conectado: move o token salvo para o lugar certo agora
  if (tokenInput.value && (conn.state === "connected" || conn.state === "unstable")) saveToken(tokenInput.value);
});
$("forget-token").addEventListener("click", () => {
  try {
    localStorage.removeItem("laserlink.token");
    sessionStorage.removeItem("laserlink.token");
  } catch {
    /* ignorar */
  }
  tokenInput.value = "";
  toast("Token apagado deste navegador. Na próxima vez, cole o token de novo.");
});
