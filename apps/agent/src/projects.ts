import { execFile } from "node:child_process";
import type { ProjectEntry, ProjectKind } from "@laserlink/shared";

/**
 * Projetos recebidos: arquivos (.laserlink, .svg, .dxf) que alguém (por exemplo o Claude)
 * publica na pasta `projetos/` do ramo `projetos` do repositório no GitHub.
 *
 * O agente só BUSCA (git fetch para uma referência própria) e lê os arquivos dessa referência:
 * não muda o código, não mexe na pasta de trabalho e nenhuma porta é aberta.
 */
export interface ProjectsConfig {
  /** Pasta do repositório do LaserLink (onde está o .git). */
  repoDir: string;
  /** Remoto do git (nome, como "origin", ou URL). Padrão: origin. */
  remote: string;
  /** Ramo com os projetos. Padrão: projetos. */
  branch: string;
  /** Token do GitHub só de leitura, para repositório privado (opcional). */
  token?: string;
}

export type GitRunner = (args: string[], options: { cwd: string; timeoutMs: number }) => Promise<string>;

const LOCAL_REF = "refs/laserlink/projetos";
const MAX_FILES = 80;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const PATH_RE = /^projetos\/[^\0\r\n]+\.(laserlink|svg|dxf)$/i;

export const runGit: GitRunner = (args, { cwd, timeoutMs }) =>
  new Promise((resolvePromise, reject) => {
    execFile("git", args, { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: MAX_FILE_BYTES * 2, encoding: "utf8" }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()));
      else resolvePromise(stdout);
    });
  });

function kindOf(path: string): ProjectKind {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return ext === "svg" ? "svg" : ext === "dxf" ? "dxf" : "laserlink";
}

/** Traduz os erros mais comuns do git para algo que a pessoa consiga resolver. */
function friendly(err: Error): string {
  const m = err.message;
  if (/ENOENT|not recognized|não é reconhecido/i.test(m)) return "O Git não está instalado no computador da laser.";
  if (/couldn't find remote ref|could not find remote ref|não encontr/i.test(m)) return "Ainda não há nenhum projeto publicado (o ramo projetos não existe no GitHub).";
  if (/Authentication|could not read Username|403|401|Repository not found/i.test(m)) {
    return "O GitHub recusou o acesso. Se o repositório é privado, coloque um token de leitura em projects.token no laserlink.config.json.";
  }
  if (/Could not resolve host|unable to access|timed out|ETIMEDOUT|SIGTERM/i.test(m)) return "Sem acesso ao GitHub agora. Confira a internet do computador da laser.";
  return `O Git falhou: ${m.split("\n")[0]}`;
}

export class ProjectInbox {
  private known = new Map<string, ProjectEntry>();
  private busy: Promise<{ items: ProjectEntry[]; error?: string }> | null = null;

  constructor(
    private readonly config: ProjectsConfig,
    private readonly git: GitRunner = runGit,
  ) {}

  private base(): string[] {
    // o serviço roda com outro usuário do Windows: sem isso o Git recusa a pasta ("dubious ownership")
    const args = ["-c", "safe.directory=*"];
    if (this.config.token) {
      const basic = Buffer.from(`x-access-token:${this.config.token}`).toString("base64");
      args.push("-c", `http.extraHeader=Authorization: Basic ${basic}`);
    }
    return args;
  }

  private run(args: string[], timeoutMs = 15000): Promise<string> {
    return this.git([...this.base(), ...args], { cwd: this.config.repoDir, timeoutMs });
  }

  /** Busca o ramo no GitHub e lista os projetos. Se a busca falhar, lista o que já tinha baixado antes (com o erro). */
  refresh(): Promise<{ items: ProjectEntry[]; error?: string }> {
    this.busy ??= (async () => {
      let error: string | undefined;
      try {
        await this.run(["fetch", "--no-tags", this.config.remote, `+refs/heads/${this.config.branch}:${LOCAL_REF}`], 60000);
      } catch (err) {
        error = friendly(err as Error);
      }
      let items: ProjectEntry[] = [];
      try {
        items = await this.list();
      } catch {
        // nada baixado ainda: fica só o erro da busca
        if (!error) error = "Ainda não há nenhum projeto publicado.";
      }
      return error ? { items, error } : { items };
    })().finally(() => {
      this.busy = null;
    });
    return this.busy;
  }

  private async list(): Promise<ProjectEntry[]> {
    const tree = await this.run(["ls-tree", "-r", "-l", "-z", LOCAL_REF, "--", "projetos/"]);
    const files: Array<{ path: string; size: number }> = [];
    for (const rec of tree.split("\0")) {
      // <modo> blob <hash> <tamanho>\t<caminho>
      const m = /^\d+ blob [0-9a-f]+\s+(\d+)\t(.+)$/.exec(rec);
      if (m && PATH_RE.test(m[2]!)) files.push({ path: m[2]!, size: Number(m[1]) });
    }
    const items: ProjectEntry[] = [];
    for (const f of files) {
      // data e mensagem do último commit que mexeu no arquivo: a mensagem é a descrição
      let date = "";
      let description = "";
      try {
        const log = await this.run(["log", "-1", "--format=%cI%x00%s", LOCAL_REF, "--", f.path]);
        [date = "", description = ""] = log.trim().split("\0");
      } catch {
        /* sem histórico (clone raso): segue sem data */
      }
      const name = f.path.slice("projetos/".length);
      items.push({ path: f.path, name, kind: kindOf(f.path), size: f.size, date, description });
    }
    items.sort((a, b) => b.date.localeCompare(a.date) || a.name.localeCompare(b.name));
    const shown = items.slice(0, MAX_FILES);
    this.known = new Map(shown.map((i) => [i.path, i]));
    return shown;
  }

  /** Conteúdo de um projeto da última lista (outros caminhos são recusados). */
  async read(path: string): Promise<{ entry: ProjectEntry; content: string }> {
    const entry = this.known.get(path);
    if (!entry || !PATH_RE.test(path)) throw new Error("Esse projeto não está na lista. Clique em Buscar novos e tente de novo.");
    if (entry.size > MAX_FILE_BYTES) throw new Error(`${entry.name} tem mais de 8 MB: grande demais para abrir por aqui.`);
    const content = await this.run(["show", `${LOCAL_REF}:${path}`]);
    return { entry, content };
  }
}
