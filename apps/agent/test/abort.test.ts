import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobEnd } from "../src/grbl.js";
import { openGrbl, sampleJob } from "./helpers.js";

describe("abortJob", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("envia hold, depois reset e por fim M5", async () => {
    const { fake, grbl } = await openGrbl({ msPerLine: 10 });
    const ends: JobEnd[] = [];
    grbl.on("jobEnd", (e) => ends.push(e));
    grbl.startJob(sampleJob(200));
    await vi.advanceTimersByTimeAsync(100);
    const linesBefore = fake.lines.length;

    grbl.abortJob("teste");
    expect(fake.realtime.at(-1)).toBe("!"); // hold imediato
    expect(grbl.isRunning).toBe(false);
    expect(ends).toEqual([{ outcome: "aborted", reason: "teste" }]);

    await vi.advanceTimersByTimeAsync(100);
    expect(fake.realtime.at(-1)).toBe("0x18");
    expect(fake.rxBytes).toBe(0); // buffer do GRBL descartado

    await vi.advanceTimersByTimeAsync(300);
    // nenhuma linha do trabalho foi executada depois do hold; só o M5
    expect(fake.lines.slice(linesBefore)).toEqual(["M5"]);
  });

  it("não aceita trabalho nem jog enquanto a parada não termina", async () => {
    const { grbl } = await openGrbl({ msPerLine: 10 });
    grbl.startJob(sampleJob(50));
    grbl.abortJob();
    expect(grbl.startJob(sampleJob(5))).toBe(false);
    expect(grbl.sendLine("$J=G91 X1 F100")).toBe(false);
    await vi.advanceTimersByTimeAsync(400);
    expect(grbl.sendLine("$X")).toBe(true);
  });

  it("funciona sem trabalho em andamento (botão PARAR)", async () => {
    const { fake, grbl } = await openGrbl();
    const ends: JobEnd[] = [];
    grbl.on("jobEnd", (e) => ends.push(e));
    grbl.abortJob();
    await vi.advanceTimersByTimeAsync(400);
    expect(fake.realtime.slice(-2)).toEqual(["!", "0x18"]);
    expect(fake.lines.at(-1)).toBe("M5");
    expect(ends).toEqual([]);
  });
});
