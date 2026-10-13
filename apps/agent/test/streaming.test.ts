import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RX_BUFFER_SIZE, type JobEnd, type JobProgress } from "../src/grbl.js";
import { openGrbl, sampleJob } from "./helpers.js";

describe("streaming com contagem de caracteres", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("nunca passa de 127 bytes pendentes e entrega todas as linhas na ordem", async () => {
    const { fake, grbl } = await openGrbl({ msPerLine: 3 });
    const job = sampleJob(400);
    const ends: JobEnd[] = [];
    grbl.on("jobEnd", (e) => ends.push(e));

    expect(grbl.startJob(job)).toBe(true);
    await vi.advanceTimersByTimeAsync(400 * 3 + 100);

    expect(fake.overflowed).toBe(false);
    expect(fake.maxRxBytes).toBeLessThanOrEqual(RX_BUFFER_SIZE);
    expect(fake.maxRxBytes).toBeGreaterThan(RX_BUFFER_SIZE - 40); // o buffer é bem aproveitado
    expect(fake.lines.slice(0, job.length)).toEqual(job);
    expect(fake.lines.at(-1)).toBe("M5"); // laser desligado ao terminar
    expect(ends).toEqual([{ outcome: "completed", reason: "Trabalho concluído." }]);
    expect(grbl.isRunning).toBe(false);
  });

  it("informa o progresso linha a linha", async () => {
    const { grbl } = await openGrbl();
    const progress: JobProgress[] = [];
    grbl.on("progress", (p) => progress.push(p));
    grbl.startJob(sampleJob(5));
    await vi.advanceTimersByTimeAsync(50);
    expect(progress[0]).toEqual({ sent: 0, total: 5, running: true });
    expect(progress.at(-1)).toEqual({ sent: 5, total: 5, running: false });
  });

  it("conta bytes de linhas com acento como UTF-8", async () => {
    const { fake, grbl } = await openGrbl({ msPerLine: 5 });
    // 30 linhas de 1 + 60 bytes ("ç" ocupa 2 bytes) — 3 linhas já estourariam o buffer
    const job = Array.from({ length: 30 }, () => `G1 X1 ${"ç".repeat(27)}`);
    grbl.startJob(job);
    await vi.advanceTimersByTimeAsync(500);
    expect(fake.overflowed).toBe(false);
  });

  it("um ok atrasado de jog não conta como linha do trabalho", async () => {
    const { fake, grbl } = await openGrbl({ msPerLine: 20 });
    grbl.sendLine("$J=G91 G21 X10 F1000");
    // trabalho começa antes do ok do jog chegar
    expect(grbl.startJob(sampleJob(60))).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(fake.overflowed).toBe(false);
    expect(fake.lines[0]).toBe("$J=G91 G21 X10 F1000");
  });

  it("recusa um segundo trabalho e arquivos vazios", async () => {
    const { grbl } = await openGrbl({ msPerLine: 10 });
    expect(grbl.startJob([])).toBe(false);
    expect(grbl.startJob(sampleJob(20))).toBe(true);
    expect(grbl.startJob(sampleJob(20))).toBe(false);
  });

  it("para o trabalho em error:N e informa a linha", async () => {
    const { fake, grbl } = await openGrbl({ respond: (l) => (l === "G1 X3 Y3" ? "error:33" : "ok") });
    const ends: JobEnd[] = [];
    grbl.on("jobEnd", (e) => ends.push(e));
    const job = ["G21", "G1 X1 Y1 F1000", "G1 X2 Y2", "G1 X3 Y3", "G1 X4 Y4", "G1 X5 Y5"];
    grbl.startJob(job);
    await vi.advanceTimersByTimeAsync(1000);
    expect(ends).toHaveLength(1);
    expect(ends[0]!.outcome).toBe("aborted");
    expect(ends[0]!.reason).toContain("error:33 na linha 4");
    expect(fake.realtime).toEqual(["0x18", "!", "0x18"]);
    expect(fake.lines.at(-1)).toBe("M5");
  });

  it("para o trabalho em ALARM:N", async () => {
    const { fake, grbl } = await openGrbl({ respond: (_l, i) => (i === 10 ? "ALARM:1" : "ok") });
    const ends: JobEnd[] = [];
    grbl.on("jobEnd", (e) => ends.push(e));
    grbl.startJob(sampleJob(50));
    await vi.advanceTimersByTimeAsync(1000);
    expect(ends.map((e) => e.outcome)).toEqual(["aborted"]);
    expect(ends[0]!.reason).toContain("ALARM:1");
    expect(grbl.isRunning).toBe(false);
    expect(fake.realtime).toContain("!");
  });

  it("encerra o trabalho com erro se a serial cair", async () => {
    const { fake, grbl } = await openGrbl({ msPerLine: 10 });
    const ends: JobEnd[] = [];
    grbl.on("jobEnd", (e) => ends.push(e));
    grbl.startJob(sampleJob(100));
    await vi.advanceTimersByTimeAsync(50);
    fake.unplug();
    expect(ends.map((e) => e.outcome)).toEqual(["error"]);
    expect(grbl.isRunning).toBe(false);
  });
});
