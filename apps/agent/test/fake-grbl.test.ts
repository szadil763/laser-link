import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeGrbl } from "../src/sim/fake-grbl.js";

function collect(fake: FakeGrbl): string[] {
  const out: string[] = [];
  fake.on("line", (l) => out.push(l));
  return out;
}

describe("FakeGrbl", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("responde ok por linha e relatório de status no ?", async () => {
    const fake = new FakeGrbl();
    const out = collect(fake);
    await fake.open();
    fake.write(Buffer.from("G0 X10 Y5\n"));
    await vi.advanceTimersByTimeAsync(5);
    fake.write(Buffer.from("?"));
    await vi.advanceTimersByTimeAsync(5);
    expect(out[0]).toBe("ok");
    expect(out[1]).toMatch(/^<Idle\|MPos:10\.000,5\.000,0\.000\|FS:/);
  });

  it("devolve error:N e ALARM:N quando configurado", async () => {
    const fake = new FakeGrbl({ respond: (l) => (l === "BAD" ? "error:20" : l === "BOOM" ? "ALARM:1" : "ok") });
    const out = collect(fake);
    await fake.open();
    fake.write(Buffer.from("BAD\nBOOM\nG1 X1\n"));
    await vi.advanceTimersByTimeAsync(10);
    expect(out).toEqual(["error:20", "ALARM:1"]);
    expect(fake.state).toBe("Alarm");
  });

  it("registra estouro do buffer de 127 bytes", async () => {
    const fake = new FakeGrbl({ msPerLine: 50 });
    await fake.open();
    fake.write(Buffer.from(`${"G1 X1 Y1 F1000".padEnd(63, " ")}\n`.repeat(3)));
    expect(fake.overflowed).toBe(true);
    expect(fake.maxRxBytes).toBe(192);
  });

  it("segura a execução em Hold e desliga o laser com 0x9E", async () => {
    const fake = new FakeGrbl({ msPerLine: 10 });
    await fake.open();
    fake.write(Buffer.from("M4 S500\nG1 X10 F1000\nG1 X20\nG1 X30\n"));
    await vi.advanceTimersByTimeAsync(25);
    fake.write(Buffer.from("!"));
    fake.write(Buffer.from([0x9e]));
    const before = fake.lines.length;
    await vi.advanceTimersByTimeAsync(100);
    expect(fake.state).toBe("Hold");
    expect(fake.spindleStopped).toBe(true);
    expect(fake.lines.length).toBe(before);
    fake.write(Buffer.from("~"));
    await vi.advanceTimersByTimeAsync(100);
    expect(fake.lines.at(-1)).toBe("G1 X30");
  });

  it("reset durante movimento gera ALARM:3", async () => {
    const fake = new FakeGrbl({ msPerLine: 10 });
    const out = collect(fake);
    await fake.open();
    fake.write(Buffer.from("G1 X10 F100\nG1 X20\n"));
    await vi.advanceTimersByTimeAsync(12);
    fake.write(Buffer.from([0x18]));
    await vi.advanceTimersByTimeAsync(5);
    expect(out).toContain("ALARM:3");
    expect(fake.rxBytes).toBe(0);
  });
});
