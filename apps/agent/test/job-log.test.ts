import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Agent } from "../src/agent.js";
import { JobLog } from "../src/job-log.js";
import { TestClient, openGrbl, sampleJob, testConfig } from "./helpers.js";

let dir: string;

describe("JobLog", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "laserlink-log-"));
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  it("grava início e fim de cada trabalho com horário e resultado", async () => {
    vi.useFakeTimers();
    const log = new JobLog(dir);
    const { grbl } = await openGrbl();
    const agent = new Agent({ config: testConfig(), grbl, portLabel: "sim", jobLog: log });
    const c = new TestClient("a");
    agent.connect(c);
    agent.receive(c, { type: "job", name: "placa.gcode", gcode: sampleJob(20).join("\n"), confirmLaserOn: true });
    for (let i = 0; i < 5; i++) {
      agent.receive(c, { type: "ping", t: i });
      await vi.advanceTimersByTimeAsync(200);
    }
    agent.shutdown();

    const records = log.read();
    expect(records.map((r) => r.event)).toEqual(["start", "end"]);
    const [start, end] = records;
    expect(start).toMatchObject({ event: "start", name: "placa.gcode", lines: 20 });
    expect(end).toMatchObject({ event: "end", name: "placa.gcode", outcome: "completed", sent: 20, total: 20 });
    if (end?.event === "end") expect(Date.parse(end.at)).not.toBeNaN();
    expect(log.findUnfinished()).toEqual([]);
  });

  it("registra trabalhos recusados", async () => {
    vi.useFakeTimers();
    const log = new JobLog(dir);
    const { grbl } = await openGrbl();
    const agent = new Agent({ config: testConfig(), grbl, portLabel: "sim", jobLog: log });
    const c = new TestClient("a");
    agent.connect(c);
    agent.receive(c, { type: "job", name: "forte.gcode", gcode: "M4 S9999\nG1 X1 F100", confirmLaserOn: true });
    agent.shutdown();
    expect(log.read()).toEqual([expect.objectContaining({ event: "rejected", name: "forte.gcode", problems: 1 })]);
  });

  it("encontra trabalhos que começaram e não terminaram e ignora linha corrompida", () => {
    const log = new JobLog(dir);
    log.write({ event: "start", id: "1", name: "a.gcode", at: "2026-01-01T10:00:00.000Z", lines: 10 });
    log.write({
      event: "end",
      id: "1",
      name: "a.gcode",
      startedAt: "2026-01-01T10:00:00.000Z",
      at: "2026-01-01T10:05:00.000Z",
      outcome: "completed",
      reason: "ok",
      sent: 10,
      total: 10,
    });
    log.write({ event: "start", id: "2", name: "b.gcode", at: "2026-01-01T11:00:00.000Z", lines: 99 });
    appendFileSync(log.file, '{"event":"end","id":"2","na'); // queda de energia no meio da escrita
    expect(log.findUnfinished()).toEqual([{ id: "2", name: "b.gcode", startedAt: "2026-01-01T11:00:00.000Z", lines: 99 }]);
  });
});
