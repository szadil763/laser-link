// Publica um projeto (.svg, .dxf ou .laserlink) no ramo "projetos" do GitHub.
// Ele aparece na interface em Arquivo > Projetos recebidos. Não mexe no seu ramo atual
// nem na pasta de trabalho: monta o commit num índice temporário e empurra só esse ramo.
//
// Uso:
//   node scripts/publicar-projeto.mjs <arquivo> --descricao "o que é" [--nome nome-no-app.svg]
//   node scripts/publicar-projeto.mjs --remover nome.svg
//   node scripts/publicar-projeto.mjs --listar
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkSvg } from "./conferir-svg.mjs";

const REMOTE = process.env.LASERLINK_REMOTE ?? "origin";
const BRANCH = "projetos";
const LOCAL = "refs/laserlink/projetos";
const root = fileURLToPath(new URL("..", import.meta.url));

function git(args, env = {}) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

function fail(msg) {
  console.error(`Erro: ${msg}`);
  process.exit(1);
}

function fetchBranch() {
  try {
    git(["fetch", "--no-tags", REMOTE, `+refs/heads/${BRANCH}:${LOCAL}`]);
  } catch (err) {
    if (!/couldn't find remote ref|could not find remote ref/i.test(String(err.stderr ?? err.message))) throw err;
  }
  try {
    return git(["rev-parse", "--verify", "-q", LOCAL]);
  } catch {
    return null;
  }
}

/** Nome seguro para o arquivo na pasta projetos/. */
function safeName(name) {
  const clean = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/-+\./g, ".")
    .replace(/^-|-$/g, "");
  if (!/\.(svg|dxf|laserlink)$/i.test(clean)) fail("o arquivo precisa terminar em .svg, .dxf ou .laserlink.");
  return clean;
}

function push(commit) {
  let wait = 2000;
  for (let i = 0; ; i++) {
    try {
      git(["push", REMOTE, `${commit}:refs/heads/${BRANCH}`]);
      git(["update-ref", LOCAL, commit]);
      return;
    } catch (err) {
      if (i >= 4) throw err;
      execFileSync(process.execPath, ["-e", `setTimeout(()=>{}, ${wait})`]);
      wait *= 2;
    }
  }
}

function commitWith(parent, message, change) {
  const dir = mkdtempSync(join(tmpdir(), "laserlink-indice-"));
  const env = {
    GIT_INDEX_FILE: join(dir, "index"),
    GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? "LaserLink",
    GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? "laserlink@local",
    GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? "LaserLink",
    GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? "laserlink@local",
  };
  try {
    git(parent ? ["read-tree", parent] : ["read-tree", "--empty"], env);
    change(env);
    const tree = git(["write-tree"], env);
    return git(["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", message], env);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const parent = fetchBranch();

if (process.argv.includes("--listar")) {
  if (!parent) {
    console.log("Nenhum projeto publicado ainda.");
    process.exit(0);
  }
  const files = git(["ls-tree", "-r", "--name-only", LOCAL, "--", "projetos/"]).split("\n").filter(Boolean);
  for (const f of files) console.log(`${f}  —  ${git(["log", "-1", "--format=%cs %s", LOCAL, "--", f])}`);
  process.exit(0);
}

const remove = arg("--remover");
if (remove) {
  if (!parent) fail("não há projetos publicados.");
  const path = `projetos/${safeName(remove)}`;
  const commit = commitWith(parent, `Remove ${basename(path)}`, (env) => git(["update-index", "--force-remove", path], env));
  push(commit);
  console.log(`Removido: ${path}`);
  process.exit(0);
}

const file = process.argv[2];
if (!file || file.startsWith("--") || !existsSync(file)) fail("diga o arquivo. Ex.: node scripts/publicar-projeto.mjs painel.svg --descricao \"Painel da sala 3\"");
const description = (arg("--descricao") ?? "").trim();
if (!description) fail('use --descricao "o que é o projeto" (aparece na lista do app).');
const name = safeName(arg("--nome") ?? basename(file));
if (/\.svg$/i.test(name)) {
  const r = checkSvg(readFileSync(file, "utf8"), {});
  for (const w of r.warnings) console.warn(`Aviso: ${w}`);
  if (r.errors.length) fail(`o SVG tem problemas:\n- ${r.errors.join("\n- ")}`);
}
const path = `projetos/${name}`;
const commit = commitWith(parent, description, (env) => {
  const blob = git(["hash-object", "-w", file], env);
  git(["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`], env);
});
push(commit);
console.log(`Publicado: ${path}\nNo LaserLink: Arquivo > Projetos recebidos > Buscar novos.`);
