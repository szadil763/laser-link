import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Agent } from "../src/agent.js";
import { Grbl, LASER_OFF_CONFIRM_MS } from "../src/grbl.js";
import { FakeGrbl, type FakeGrblOptions } from "../src/sim/fake-grbl.js";
import { TestClient, openGrbl, sampleJob, testConfig } from "./helpers.js";

async function setup(options: FakeGrblOptions = {}) {
  const { fake, grbl } = await openGrbl({ msPerLine: 20, ...options });
  const agent = new Agent({ config: testConfig(), grbl, portLabel: "simulador" });
  const owner = new TestClient("dono");
  agent.connect(owner);
  agent.receive(owner, { type: "job", name: "t.gcode", gcode: sampleJob(400).join("\n"), confirmLaserOn: true });
  await vi.advanceTimersByTimeAsync(200);
  return { fake, grbl, agent, owner };
}

const logs = (c: TestClient): string[] => c.of("log").map((m) => m.text);

describe("pausa de segurança: laser apagado e conferido", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("perda de conexão: o GRBL confirma o laser apagado e o trabalho fica pausado (dá para retomar)", async () => {
    const { fake, grbl, agent } = await setup();
    const phone = new TestClient("celular");
    agent.connect(phone);
    expect(fake.laserLit).toBe(true);
    const rt = fake.realtime.length;
    agent.disconnect(agent["clients"].get("dono")!.conn);
    await vi.advanceTimersByTimeAsync(600);
    expect(fake.state).toBe("Hold");
    expect(fake.laserLit).toBe(false);
    expect(grbl.isLaserOffConfirmed).toBe(true);
    expect(logs(phone).some((t) => t.includes("conferido"))).toBe(true);
    await vi.advanceTimersByTimeAsync(LASER_OFF_CONFIRM_MS + 500);
    expect(fake.realtime.slice(rt)).not.toContain("0x18"); // sem reset: o trabalho continua guardado
    expect(agent.jobInfo?.state).toBe("connectionLost");
    agent.shutdown();
  });

  it("placa que ignora o 0x9E (laser continua aceso): cancela com reset em até 2 s", async () => {
    const { fake, grbl, agent } = await setup({ ignoreSpindleStop: true });
    const phone = new TestClient("celular");
    agent.connect(phone);
    const rt = fake.realtime.length;
    agent.disconnect(agent["clients"].get("dono")!.conn);
    await vi.advanceTimersByTimeAsync(400);
    expect(fake.state).toBe("Hold");
    expect(fake.laserLit).toBe(true); // a placa ignorou o pedido
    await vi.advanceTimersByTimeAsync(LASER_OFF_CONFIRM_MS + 600);
    expect(fake.realtime.slice(rt)).toContain("0x18");
    expect(fake.laserLit).toBe(false);
    expect(grbl.isRunning).toBe(false);
    expect(agent.jobInfo).toBeNull();
    expect(phone.of("jobEnded").at(-1)?.result.reason).toMatch(/Parada de segurança/);
    agent.shutdown();
  });

  it("botão Pausar também apaga o laser; Retomar religa (com confirmação)", async () => {
    const { fake, agent, owner } = await setup();
    agent.receive(owner, { type: "hold" });
    await vi.advanceTimersByTimeAsync(600);
    expect(fake.realtime).toContain("0x9E");
    expect(fake.laserLit).toBe(false);
    expect(agent.jobInfo?.state).toBe("paused");
    agent.receive(owner, { type: "resume", confirmLaserOn: true });
    await vi.advanceTimersByTimeAsync(200);
    expect(fake.state).toBe("Run");
    expect(fake.laserLit).toBe(true);
    agent.shutdown();
  });
});

describe("modo laser do GRBL ($32)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("com $32=0, recusa trabalho e avisa; depois de ligar o modo laser, aceita", async () => {
    const fake = new FakeGrbl({ msPerLine: 5, laserMode: false });
    const grbl = new Grbl(fake, { statusPollMs: 100 });
    const agent = new Agent({ config: testConfig(), grbl, portLabel: "simulador" });
    await agent.start();
    await vi.advanceTimersByTimeAsync(50);
    const c = new TestClient("a");
    agent.connect(c);
    expect(c.of("hello")[0]!.laserMode).toBe(false);
    agent.receive(c, { type: "job", name: "t.gcode", gcode: sampleJob(10).join("\n"), confirmLaserOn: true });
    expect(c.of("error").at(-1)?.message).toMatch(/modo laser/);
    expect(grbl.isRunning).toBe(false);
    agent.receive(c, { type: "setLaserMode" });
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.laserMode).toBe(true);
    expect(c.of("machine").at(-1)?.laserMode).toBe(true);
    agent.receive(c, { type: "job", name: "t.gcode", gcode: sampleJob(10).join("\n"), confirmLaserOn: true });
    expect(grbl.isRunning).toBe(true);
    agent.shutdown();
  });
});
