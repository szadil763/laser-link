import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Agent } from "../src/agent.js";
import { TestClient, openGrbl, sampleJob, testConfig } from "./helpers.js";

async function setup() {
  const { fake, grbl } = await openGrbl({ msPerLine: 10 });
  const agent = new Agent({ config: testConfig(), grbl, portLabel: "simulador" });
  return { fake, grbl, agent };
}

describe("Agent", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("recusa mensagens fora do protocolo", async () => {
    const { agent } = await setup();
    const c = new TestClient("a");
    agent.connect(c);
    agent.receive(c, { type: "laserOn" });
    agent.receive(c, null);
    agent.receive(c, { type: "jog", axis: "Z", distance: 1, feed: 100 });
    expect(c.of("error")).toHaveLength(3);
  });

  it("para o trabalho quando o único cliente desconecta", async () => {
    const { fake, grbl, agent } = await setup();
    const c = new TestClient("a");
    agent.connect(c);
    agent.receive(c, { type: "job", name: "teste.gcode", gcode: sampleJob(100).join("\n") });
    await vi.advanceTimersByTimeAsync(50);
    expect(grbl.isRunning).toBe(true);

    agent.disconnect(c);
    expect(fake.realtime.at(-1)).toBe("!");
    await vi.advanceTimersByTimeAsync(400);
    expect(fake.lines.at(-1)).toBe("M5");
  });
});
