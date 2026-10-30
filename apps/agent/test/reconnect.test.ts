import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Agent } from "../src/agent.js";
import { Grbl } from "../src/grbl.js";
import { JobLog } from "../src/job-log.js";
import { FakeGrbl } from "../src/sim/fake-grbl.js";
import { TestClient, sampleJob, testConfig } from "./helpers.js";

describe("reconexão", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("tenta abrir a serial de novo até conseguir", async () => {
    const fake = new FakeGrbl({ failOpens: 2 });
    const grbl = new Grbl(fake, { statusPollMs: 100 });
    const agent = new Agent({ config: testConfig(), grbl, portLabel: "sim", serialRetryMs: 1000 });
    const c = new TestClient("a");
    agent.connect(c);
    await agent.start();
    expect(grbl.isOpen).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(grbl.isOpen).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(grbl.isOpen).toBe(true);
    expect(c.of("serial")).toEqual([{ type: "serial", connected: true }]);
    agent.shutdown();
  });

  it("cabo desconectado no meio do trabalho: encerra com erro, avisa e reabre sem retomar", async () => {
    const fake = new FakeGrbl({ msPerLine: 10 });
    const grbl = new Grbl(fake, { statusPollMs: 100 });
    const agent = new Agent({ config: testConfig(), grbl, portLabel: "sim", serialRetryMs: 1000 });
    await agent.start();
    await vi.advanceTimersByTimeAsync(5);
    const c = new TestClient("a");
    agent.connect(c);
    agent.receive(c, { type: "job", name: "a.gcode", gcode: sampleJob(200).join("\n"), confirmLaserOn: true });
    await vi.advanceTimersByTimeAsync(100);

    fake.unplug();
    expect(c.of("serial").at(-1)).toEqual({ type: "serial", connected: false });
    expect(c.of("jobEnded")[0]?.result.outcome).toBe("error");

    const linesBefore = fake.lines.length;
    agent.receive(c, { type: "ping", t: 1 });
    await vi.advanceTimersByTimeAsync(1100);
    expect(grbl.isOpen).toBe(true);
    expect(c.of("serial").at(-1)).toEqual({ type: "serial", connected: true });
    expect(grbl.isRunning).toBe(false);
    agent.receive(c, { type: "ping", t: 2 });
    await vi.advanceTimersByTimeAsync(500);
    // nada do trabalho foi reenviado (só a leitura das configurações, $$)
    expect(fake.lines.slice(linesBefore).filter((l) => l !== "$$")).toEqual([]);
    agent.shutdown();
  });

  it("quem conecta depois vê o resultado do trabalho cancelado enquanto estava fora", async () => {
    const fake = new FakeGrbl({ msPerLine: 10 });
    const grbl = new Grbl(fake, { statusPollMs: 100 });
    const agent = new Agent({ config: testConfig({ reconnectGraceSec: 5 }), grbl, portLabel: "sim" });
    await agent.start();
    await vi.advanceTimersByTimeAsync(5);
    const owner = new TestClient("a");
    agent.connect(owner);
    agent.receive(owner, { type: "job", name: "longo.gcode", gcode: sampleJob(500).join("\n"), confirmLaserOn: true });
    await vi.advanceTimersByTimeAsync(100);
    agent.disconnect(owner);
    await vi.advanceTimersByTimeAsync(6000);

    const later = new TestClient("b");
    agent.connect(later);
    const hello = later.of("hello")[0]!;
    expect(hello.job).toBeNull();
    expect(hello.lastResult).toMatchObject({ name: "longo.gcode", outcome: "aborted" });
    expect(hello.lastResult?.reason).toContain("Ninguém reconectou");
    agent.shutdown();
  });

  it("agente reiniciado durante um trabalho avisa no hello e fecha o registro no log", async () => {
    const dir = mkdtempSync(join(tmpdir(), "laserlink-rec-"));
    try {
      const log = new JobLog(dir);
      log.write({ event: "start", id: "x1", name: "caiu.gcode", at: "2026-10-13T12:00:00.000Z", lines: 300 });

      const grbl = new Grbl(new FakeGrbl(), { statusPollMs: 100 });
      const agent = new Agent({ config: testConfig(), grbl, portLabel: "sim", jobLog: log });
      const c = new TestClient("a");
      agent.connect(c);
      expect(c.of("hello")[0]!.lastResult).toMatchObject({ name: "caiu.gcode", outcome: "interrupted" });
      expect(log.findUnfinished()).toEqual([]);
      agent.shutdown();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
