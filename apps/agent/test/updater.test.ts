import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Agent } from "../src/agent.js";
import { TASK_NAME, Updater, type UpdaterEnv } from "../src/updater.js";
import { TestClient, openGrbl, sampleJob, testConfig } from "./helpers.js";

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.name=Teste", "-c", "user.email=teste@exemplo", ...args], { cwd, encoding: "utf8" });

const WINDOWS: UpdaterEnv = { platform: "win32", env: { LASERLINK_SERVICE: "1" } };

let dir = "";
let dev = "";
let laser = "";

/** Commit novo no "GitHub" (repositório de quem desenvolve). */
function publish(file: string, content: string, message: string): void {
  writeFileSync(join(dev, file), content);
  git(dev, "add", ".");
  git(dev, "commit", "-q", "-m", message);
  git(dev, "push", "-q", "origin", "fase-3");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "laserlink-atualizar-"));
  const remote = join(dir, "remoto.git");
  dev = join(dir, "dev");
  laser = join(dir, "laser");
  git(dir, "init", "-q", "--bare", remote);
  git(dir, "init", "-q", "-b", "fase-3", dev);
  git(dev, "remote", "add", "origin", remote);
  mkdirSync(join(dev, "scripts", "windows"), { recursive: true });
  writeFileSync(join(dev, "scripts", "windows", "atualizar-auto.ps1"), "# script\n");
  writeFileSync(join(dev, "package-lock.json"), "{}\n");
  publish("leia-me.txt", "v1\n", "Versão inicial");
  git(dir, "clone", "-q", "-b", "fase-3", remote, laser);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const updater = (host: UpdaterEnv = WINDOWS, run = vi.fn(async () => "")) =>
  new Updater({ repoDir: laser, remote: "origin", dataDir: join(laser, "dados") }, undefined, run, host);

describe("Updater", () => {
  it("sem commits novos: já está na versão mais nova", async () => {
    const info = await updater().check();
    expect(info).toMatchObject({ state: "current", canApply: false, changes: [] });
    expect(info.current).toMatch(/^[0-9a-f]{7,} · /);
  });

  it("com commits novos: lista o que mudou sem mexer na pasta de trabalho", async () => {
    publish("leia-me.txt", "v2\n", "Corrige materiais");
    publish("outro.txt", "x\n", "Preencher a mesa");
    const head = git(laser, "rev-parse", "HEAD");
    const info = await updater().check();
    expect(info).toMatchObject({ state: "available", canApply: true, changes: ["Preencher a mesa", "Corrige materiais"] });
    expect(info.slow).toBeUndefined();
    expect(info.latest).toMatch(/ · /);
    expect(git(laser, "rev-parse", "HEAD")).toBe(head);
    expect(git(laser, "status", "--porcelain")).toBe("");
  });

  it("pacotes novos (package-lock.json mudou): avisa que demora mais", async () => {
    publish("package-lock.json", '{"novo": true}\n', "Atualiza dependências");
    expect((await updater().check()).slow).toBe(true);
  });

  it("fora do serviço do Windows: mostra a versão nova mas não atualiza pelo app", async () => {
    publish("leia-me.txt", "v2\n", "Algo novo");
    const linux = await updater({ platform: "linux", env: {} }).check();
    expect(linux).toMatchObject({ state: "available", canApply: false });
    expect(linux.reason).toMatch(/PC da laser/);
    const old = await updater({ platform: "win32", env: {} }).check();
    expect(old.canApply).toBe(false);
    expect(old.reason).toMatch(/Atualizar LaserLink no PC da laser uma vez/);
  });

  it("mudanças locais no PC da laser: não atualiza pelo app", async () => {
    publish("leia-me.txt", "v2\n", "Algo novo");
    writeFileSync(join(laser, "leia-me.txt"), "mexido à mão\n");
    const dirty = await updater().check();
    expect(dirty.canApply).toBe(false);
    expect(dirty.reason).toMatch(/alterados/);
    git(laser, "commit", "-q", "-am", "commit local");
    const ahead = await updater().check();
    expect(ahead.canApply).toBe(false);
    expect(ahead.reason).toMatch(/mudanças próprias/);
  });

  it("aplicar: cria e inicia a tarefa agendada com o script, e trava novas tentativas", async () => {
    publish("leia-me.txt", "v2\n", "Algo novo");
    const run = vi.fn(async (_file: string, _args: string[]) => "");
    const u = updater(WINDOWS, run);
    const info = await u.apply();
    expect(info.state).toBe("applying");
    expect(u.isApplying).toBe(true);
    expect(run).toHaveBeenCalledTimes(2);
    const [file, create] = run.mock.calls[0]!;
    expect(file).toBe("schtasks.exe");
    expect(create).toEqual(expect.arrayContaining(["/Create", "/TN", TASK_NAME, "/RU", "SYSTEM"]));
    expect(create[create.indexOf("/TR") + 1]).toContain(join(laser, "scripts", "windows", "atualizar-auto.ps1"));
    expect(run.mock.calls[1]![1]).toEqual(["/Run", "/TN", TASK_NAME]);
    expect((await u.check(true)).state).toBe("applying");
    await expect(u.apply()).rejects.toThrow(/em andamento/);
  });

  it("aplicar sem versão nova ou sem poder: recusa sem criar a tarefa", async () => {
    const run = vi.fn(async () => "");
    await expect(updater(WINDOWS, run).apply()).rejects.toThrow(/mais nova/);
    publish("leia-me.txt", "v2\n", "Algo novo");
    await expect(updater({ platform: "linux", env: {} }, run).apply()).rejects.toThrow(/PC da laser/);
    expect(run).not.toHaveBeenCalled();
  });

  it("se o Windows recusar a tarefa, libera para tentar de novo", async () => {
    publish("leia-me.txt", "v2\n", "Algo novo");
    const u = updater(WINDOWS, vi.fn(async () => Promise.reject(new Error("Acesso negado."))));
    await expect(u.apply()).rejects.toThrow(/Acesso negado/);
    expect(u.isApplying).toBe(false);
  });

  it("lê o resultado da última atualização (com BOM) só se for recente", () => {
    const data = join(laser, "dados");
    mkdirSync(data);
    const at = new Date().toISOString();
    writeFileSync(join(data, "atualizacao.json"), `﻿${JSON.stringify({ ok: false, message: "npm ci falhou. Voltei para a versão anterior.", version: "abc1234", at })}`);
    expect(updater().lastResult()).toEqual({ ok: false, message: "npm ci falhou. Voltei para a versão anterior.", version: "abc1234", at });
    expect(updater().lastResult(Date.now() + 3 * 60 * 60 * 1000)).toBeNull();
  });
});

describe("Agent e atualização", () => {
  it("recusa atualizar com trabalho em andamento e recusa trabalho novo durante a atualização", async () => {
    publish("leia-me.txt", "v2\n", "Algo novo");
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval", "Date"] });
    const { grbl } = await openGrbl({ msPerLine: 50 });
    vi.useRealTimers();
    const u = updater();
    const agent = new Agent({ config: testConfig(), grbl, portLabel: "simulador", updater: u });
    const c = new TestClient("a");
    agent.connect(c);
    expect(c.of("hello")[0]).toMatchObject({ appVersion: u.current, lastUpdate: null });

    agent.receive(c, { type: "job", name: "t", gcode: sampleJob(200).join("\n"), confirmLaserOn: true });
    agent.receive(c, { type: "updateApply", confirmRestart: true });
    expect(c.of("error").at(-1)?.message).toMatch(/trabalho em andamento/);
    expect(u.isApplying).toBe(false);
    agent.receive(c, { type: "stop" });
    await expect.poll(() => grbl.isRunning, { timeout: 5000 }).toBe(false);
    await expect.poll(() => c.of("job").at(-1)?.job ?? null, { timeout: 5000 }).toBeNull();

    agent.receive(c, { type: "updateApply", confirmRestart: true });
    await expect.poll(() => c.of("update").at(-1)?.info.state, { timeout: 10000 }).toBe("applying");
    agent.receive(c, { type: "job", name: "t2", gcode: "G0 X1 Y1", confirmLaserOn: true });
    expect(c.of("error").at(-1)?.message).toMatch(/atualizando/);
    agent.shutdown();
  });

  it("updateApply sem confirmação é recusado", async () => {
    vi.useFakeTimers();
    const { grbl } = await openGrbl();
    vi.useRealTimers();
    const agent = new Agent({ config: testConfig(), grbl, portLabel: "simulador", updater: updater() });
    const c = new TestClient("a");
    agent.connect(c);
    agent.receive(c, { type: "updateApply" });
    expect(c.of("error").at(-1)?.message).toBe("Mensagem inválida.");
    agent.shutdown();
  });
});
