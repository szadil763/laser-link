import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { UpdateInfo, UpdateResult } from "@laserlink/shared";
import { runGit, type GitRunner } from "./projects.js";

/**
 * Atualização pelo app: confere no GitHub se há commits novos no ramo instalado e,
 * no PC da laser (serviço do Windows), dispara o script `atualizar-auto.ps1` numa
 * tarefa agendada. A tarefa roda fora do serviço: para o agente, instala, compila e
 * religa. O agente nunca troca os próprios arquivos com ele rodando (no Windows o
 * driver da porta serial fica preso enquanto o agente está aberto).
 */
export interface UpdaterConfig {
  /** Pasta do repositório do LaserLink (onde está o .git). */
  repoDir: string;
  /** Remoto do git (nome ou URL). Padrão: origin. */
  remote: string;
  /** Token do GitHub só de leitura, para repositório privado (o mesmo dos projetos). */
  token?: string;
  /** Onde o script grava o resultado (atualizacao.json). */
  dataDir: string;
}

export type CommandRunner = (file: string, args: string[]) => Promise<string>;

export const runCommand: CommandRunner = (file, args) =>
  new Promise((resolvePromise, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 30000, encoding: "utf8" }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || stdout || err.message).trim()));
      else resolvePromise(stdout);
    });
  });

/** Referência própria para a versão baixada: não mexe nos ramos nem na pasta de trabalho. */
export const UPDATE_REF = "refs/laserlink/atualizacao";
export const TASK_NAME = "LaserLink Atualizar";
const CACHE_MS = 10 * 60 * 1000;
/**
 * O script para o serviço nos primeiros segundos. Se o agente continua rodando depois disto,
 * a tarefa não começou (ou travou): o agente desiste e volta a aceitar trabalhos.
 */
export const START_TIMEOUT_MS = 3 * 60 * 1000;
/** "Last Result" do Agendador quando a tarefa ainda está rodando (0x41301). */
const TASK_RUNNING = "267009";
/** Resultado de atualização mais velho que isto não é mais mostrado a quem conecta. */
const RESULT_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const VERSION_FORMAT = ["--format=%h · %cd", "--date=format:%d/%m %H:%M"];

function friendly(err: Error): string {
  const m = err.message;
  if (/ENOENT|not recognized|não é reconhecido/i.test(m)) return "O Git não está instalado no computador da laser.";
  if (/couldn't find remote ref|could not find remote ref/i.test(m)) return "O ramo instalado não existe mais no GitHub. Use o Atualizar LaserLink no PC da laser.";
  if (/Authentication|could not read Username|403|401|Repository not found/i.test(m)) {
    return "O GitHub recusou o acesso. Se o repositório é privado, coloque um token de leitura em projects.token no laserlink.config.json.";
  }
  if (/Could not resolve host|unable to access|timed out|ETIMEDOUT|SIGTERM/i.test(m)) return "Sem acesso ao GitHub agora. Confira a internet do computador da laser.";
  return `O Git falhou: ${m.split("\n")[0]}`;
}

export interface UpdaterEnv {
  platform: NodeJS.Platform;
  /** Variáveis de ambiente (o serviço instalado define LASERLINK_SERVICE=1). */
  env: NodeJS.ProcessEnv;
}

export class Updater {
  readonly current: string;
  private cached: { at: number; info: UpdateInfo } | null = null;
  private busy: Promise<UpdateInfo> | null = null;
  private applying = false;
  private watchdog: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: UpdaterConfig,
    private readonly git: GitRunner = runGit,
    private readonly run: CommandRunner = runCommand,
    private readonly host: UpdaterEnv = { platform: process.platform, env: process.env },
    current?: string,
  ) {
    this.current = current ?? readVersion(config.repoDir);
  }

  get isApplying(): boolean {
    return this.applying;
  }

  private base(): string[] {
    // o serviço roda com outro usuário do Windows: sem isso o Git recusa a pasta ("dubious ownership")
    const args = ["-c", "safe.directory=*"];
    if (this.config.token) {
      const basic = Buffer.from(`x-access-token:${this.config.token}`).toString("base64");
      args.push("-c", `http.extraHeader=Authorization: Basic ${basic}`);
    }
    return args;
  }

  private g(args: string[], timeoutMs = 15000): Promise<string> {
    return this.git([...this.base(), ...args], { cwd: this.config.repoDir, timeoutMs });
  }

  /** Por que não dá para atualizar pelo app aqui (null = dá). */
  private applyBlocker(): string | null {
    if (this.host.platform !== "win32") {
      return "A atualização pelo app funciona no PC da laser (Windows, com o serviço LaserLink). Aqui, use git pull e npm run build.";
    }
    if (this.host.env.LASERLINK_SERVICE !== "1") {
      return "O serviço foi instalado antes desta função. Rode o Atualizar LaserLink no PC da laser uma vez; depois o botão passa a funcionar.";
    }
    if (!existsSync(this.scriptPath())) return "Não achei o script de atualização (scripts\\windows\\atualizar-auto.ps1). Use o Atualizar LaserLink no PC da laser.";
    return null;
  }

  private scriptPath(): string {
    return join(this.config.repoDir, "scripts", "windows", "atualizar-auto.ps1");
  }

  /** Confere no GitHub. Guarda a resposta por 10 minutos (`force` confere de novo). */
  check(force = false): Promise<UpdateInfo> {
    if (this.applying) return Promise.resolve(this.applyingInfo());
    if (!force && this.cached && Date.now() - this.cached.at < CACHE_MS) return Promise.resolve(this.cached.info);
    this.busy ??= this.doCheck()
      .then((info) => {
        this.cached = { at: Date.now(), info };
        return info;
      })
      .finally(() => {
        this.busy = null;
      });
    return this.busy;
  }

  private async doCheck(): Promise<UpdateInfo> {
    const blocker = this.applyBlocker();
    const fail = (reason: string): UpdateInfo => ({ state: "error", current: this.current, changes: [], canApply: false, reason });
    let branch: string;
    try {
      branch = (await this.g(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    } catch (err) {
      return fail(friendly(err as Error));
    }
    if (!branch || branch === "HEAD") return fail("A pasta do LaserLink não está num ramo do git. Use o Atualizar LaserLink no PC da laser.");
    try {
      await this.g(["fetch", "--no-tags", this.config.remote, `+refs/heads/${branch}:${UPDATE_REF}`], 60000);
    } catch (err) {
      return fail(friendly(err as Error));
    }
    const count = async (range: string): Promise<number> => Number((await this.g(["rev-list", "--count", range])).trim()) || 0;
    const behind = await count(`HEAD..${UPDATE_REF}`);
    if (behind === 0) return { state: "current", current: this.current, changes: [], canApply: false };
    const ahead = await count(`${UPDATE_REF}..HEAD`);
    const dirty = (await this.g(["status", "--porcelain", "--untracked-files=no"])).trim();
    const changes = (await this.g(["log", "-n", "15", "--format=%s", `HEAD..${UPDATE_REF}`])).split("\n").map((l) => l.trim()).filter(Boolean);
    const latest = (await this.g(["log", "-1", ...VERSION_FORMAT, UPDATE_REF])).trim();
    const slow = (await this.g(["diff", "--name-only", "HEAD", UPDATE_REF, "--", "package-lock.json"])).trim() !== "";
    let reason = blocker;
    if (!reason && ahead > 0) reason = "Este PC tem mudanças próprias no código (commits que não estão no GitHub). Use o Atualizar LaserLink no PC da laser.";
    if (!reason && dirty) reason = "Há arquivos do LaserLink alterados neste PC. Use o Atualizar LaserLink no PC da laser.";
    const info: UpdateInfo = { state: "available", current: this.current, latest, changes, canApply: !reason };
    if (slow) info.slow = true;
    if (reason) info.reason = reason;
    return info;
  }

  private applyingInfo(): UpdateInfo {
    return { state: "applying", current: this.current, changes: [], canApply: false };
  }

  /**
   * Confere de novo e dispara a atualização numa tarefa agendada (fora do serviço).
   * Quem chama garante que não há trabalho em andamento.
   */
  async apply(onStalled?: (message: string) => void): Promise<UpdateInfo> {
    if (this.applying) throw new Error("A atualização já está em andamento.");
    const info = await this.check(true);
    if (info.state === "current") throw new Error("O LaserLink já está na versão mais nova.");
    if (info.state !== "available") throw new Error(info.reason ?? "Não deu para conferir a versão nova.");
    if (!info.canApply) throw new Error(info.reason ?? "Não dá para atualizar pelo app neste computador.");
    this.applying = true;
    try {
      const command = `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${this.scriptPath()}"`;
      // tarefa de uma vez só, como SYSTEM (o mesmo usuário do serviço); /Run inicia agora
      await this.run("schtasks.exe", ["/Create", "/TN", TASK_NAME, "/TR", command, "/SC", "ONCE", "/ST", "23:59", "/RU", "SYSTEM", "/RL", "HIGHEST", "/F"]);
      await this.run("schtasks.exe", ["/Run", "/TN", TASK_NAME]);
    } catch (err) {
      this.applying = false;
      throw new Error(`Não consegui iniciar a atualização: ${(err as Error).message.split("\n")[0]}`);
    }
    this.cached = null;
    this.watchdog = setTimeout(() => {
      this.watchdog = null;
      void this.stalled().then((message) => onStalled?.(message));
    }, START_TIMEOUT_MS);
    this.watchdog.unref?.();
    return { ...info, state: "applying", canApply: false };
  }

  /** O agente continua de pé muito depois de pedir a atualização: encerra a tarefa e destrava. */
  private async stalled(): Promise<string> {
    let detail = "";
    try {
      const csv = (await this.run("schtasks.exe", ["/Query", "/TN", TASK_NAME, "/FO", "CSV", "/V", "/NH"])).trim().split(/\r?\n/)[0] ?? "";
      // colunas fixas (os nomes mudam com o idioma do Windows): 3 = estado, 5 = última execução, 6 = último resultado
      const f = csv.replace(/^"|"$/g, "").split('","');
      if (f[6] === TASK_RUNNING) {
        // rodando sem ter parado o agente: encerra antes de destravar, para ela não parar o agente no meio de um trabalho
        await this.run("schtasks.exe", ["/End", "/TN", TASK_NAME]).catch(() => "");
      }
      detail = ` Tarefa do Windows: ${f[3] ?? "?"}, última execução ${f[5] ?? "?"}, resultado ${f[6] ?? "?"}.`;
    } catch (err) {
      detail = ` Não achei a tarefa do Windows (${(err as Error).message.split("\n")[0]}).`;
    }
    this.applying = false;
    return (
      `A atualização não começou: depois de ${START_TIMEOUT_MS / 60000} minutos o agente continua na versão ${this.current}.${detail} ` +
      "O agente voltou a aceitar trabalhos. Use o Atualizar LaserLink no PC da laser e mande o arquivo apps\\agent\\logs\\atualizacao.log, se existir."
    );
  }

  /** Para o relógio da atualização (agente encerrando). */
  dispose(): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = null;
  }

  /** Resultado da última atualização pelo app, se foi há pouco. */
  lastResult(now = Date.now()): UpdateResult | null {
    const file = join(this.config.dataDir, "atualizacao.json");
    try {
      // o PowerShell 5 grava UTF-8 com BOM
      const v = JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, "")) as Partial<UpdateResult>;
      if (typeof v.ok !== "boolean" || typeof v.message !== "string" || typeof v.at !== "string") return null;
      const at = Date.parse(v.at);
      if (!Number.isFinite(at) || now - at > RESULT_MAX_AGE_MS || at - now > 60000) return null;
      return { ok: v.ok, message: v.message, version: typeof v.version === "string" ? v.version : this.current, at: v.at };
    } catch {
      return null;
    }
  }
}

/** Commit e data instalados (igual à versão que a interface mostra), ou "dev" sem git. */
export function readVersion(repoDir: string): string {
  try {
    return execFileSync("git", ["-c", "safe.directory=*", "log", "-1", ...VERSION_FORMAT], { cwd: repoDir, encoding: "utf8", timeout: 5000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).trim() || "dev";
  } catch {
    return "dev";
  }
}
