import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Agent } from "../src/agent.js";
import { ProjectInbox } from "../src/projects.js";
import { TestClient, openGrbl, testConfig } from "./helpers.js";

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.name=Teste", "-c", "user.email=teste@exemplo", ...args], { cwd, encoding: "utf8" });

let dir = "";
let remote = "";
let clone = "";

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "laserlink-projetos-"));
  remote = join(dir, "remoto.git");
  clone = join(dir, "clone");
  git(dir, "init", "-q", "--bare", remote);
  // quem publica: um repositório à parte, com o ramo projetos
  const pub = join(dir, "publica");
  git(dir, "init", "-q", "-b", "projetos", pub);
  mkdirSync(join(pub, "projetos"));
  writeFileSync(join(pub, "projetos", "placa.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="50mm" height="20mm" viewBox="0 0 50 20"><rect x="1" y="1" width="48" height="18" stroke="red" fill="none"/></svg>');
  writeFileSync(join(pub, "projetos", "leia-me.txt"), "não é projeto");
  git(pub, "add", ".");
  git(pub, "commit", "-q", "-m", "Placa da porta da sala 3");
  git(pub, "push", "-q", remote, "projetos");
  // o computador da laser: clone do repositório (sem o ramo projetos baixado)
  git(dir, "init", "-q", clone);
  git(clone, "remote", "add", "origin", remote);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("ProjectInbox", () => {
  it("busca o ramo, lista só .laserlink/.svg/.dxf com a descrição do commit e lê o arquivo", async () => {
    const inbox = new ProjectInbox({ repoDir: clone, remote: "origin", branch: "projetos" });
    const r = await inbox.refresh();
    expect(r.error).toBeUndefined();
    expect(r.items.map((i) => i.name)).toEqual(["placa.svg"]);
    expect(r.items[0]).toMatchObject({ kind: "svg", description: "Placa da porta da sala 3" });
    const { content } = await inbox.read("projetos/placa.svg");
    expect(content).toContain("<rect");
    await expect(inbox.read("projetos/leia-me.txt")).rejects.toThrow(/lista/);
    await expect(inbox.read("../laserlink.config.json")).rejects.toThrow(/lista/);
    // a pasta de trabalho do clone não muda
    expect(git(clone, "status", "--porcelain")).toBe("");
  });

  it("sem o ramo no GitHub, responde com um aviso claro", async () => {
    const inbox = new ProjectInbox({ repoDir: clone, remote: "origin", branch: "nao-existe" });
    const fresh = mkdtempSync(join(tmpdir(), "laserlink-vazio-"));
    git(fresh, "init", "-q");
    git(fresh, "remote", "add", "origin", remote);
    const r = await new ProjectInbox({ repoDir: fresh, remote: "origin", branch: "nao-existe" }).refresh();
    expect(r.items).toEqual([]);
    expect(r.error).toMatch(/nenhum projeto/i);
    expect(inbox).toBeTruthy();
    rmSync(fresh, { recursive: true, force: true });
  });

  it("o agente responde projectsList e projectGet", async () => {
    vi.useFakeTimers();
    const { grbl } = await openGrbl();
    vi.useRealTimers();
    const projects = new ProjectInbox({ repoDir: clone, remote: "origin", branch: "projetos" });
    const agent = new Agent({ config: testConfig(), grbl, portLabel: "simulador", projects });
    const c = new TestClient("a");
    agent.connect(c);
    agent.receive(c, { type: "projectsList" });
    await expect.poll(() => c.of("projects").length, { timeout: 10000 }).toBe(1);
    agent.receive(c, { type: "projectGet", path: "projetos/placa.svg" });
    await expect.poll(() => c.of("projectFile").length, { timeout: 10000 }).toBe(1);
    expect(c.of("projectFile")[0]!.entry.name).toBe("placa.svg");
    agent.shutdown();
  });
});
