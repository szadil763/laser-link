import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HEARTBEAT_TIMEOUT_MS } from "@laserlink/shared";
import { Agent } from "../src/agent.js";
import { TestClient, openGrbl, sampleJob, testConfig } from "./helpers.js";

async function setup(msPerLine = 10) {
  const { fake, grbl } = await openGrbl({ msPerLine });
  const agent = new Agent({ config: testConfig(), grbl, portLabel: "simulador" });
  return { fake, grbl, agent };
}

function startJob(agent: Agent, c: TestClient, lines = 300): void {
  agent.receive(c, { type: "job", name: "teste.gcode", gcode: sampleJob(lines).join("\n"), confirmLaserOn: true });
}

/** Avança o tempo mandando ping a cada 2 s, como a interface faz. */
async function keepAlive(agent: Agent, c: TestClient, ms: number): Promise<void> {
  for (let t = 0; t < ms; t += 2000) {
    agent.receive(c, { type: "ping", t });
    await vi.advanceTimersByTimeAsync(Math.min(2000, ms - t));
  }
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
    agent.shutdown();
  });

  it("não inicia trabalho nem retoma sem a confirmação de laser ligado", async () => {
    const { grbl, agent } = await setup();
    const c = new TestClient("a");
    agent.connect(c);
    agent.receive(c, { type: "job", name: "x", gcode: "G1 X1" });
    agent.receive(c, { type: "resume" });
    expect(grbl.isRunning).toBe(false);
    expect(c.of("error")).toHaveLength(2);
    agent.shutdown();
  });

  it("responde ping com pong", async () => {
    const { agent } = await setup();
    const c = new TestClient("a");
    agent.connect(c);
    agent.receive(c, { type: "ping", t: 42 });
    expect(c.of("pong")).toEqual([{ type: "pong", t: 42 }]);
    agent.shutdown();
  });

  it("com ping a cada 2 s o trabalho segue até o fim", async () => {
    const { grbl, agent } = await setup(30);
    const c = new TestClient("a");
    agent.connect(c);
    startJob(agent, c, 300);
    await keepAlive(agent, c, 12_000);
    expect(c.of("jobEnded").map((m) => m.result.outcome)).toEqual(["completed"]);
    expect(grbl.isRunning).toBe(false);
    agent.shutdown();
  });

  describe("perda de conexão", () => {
    it("desconectar o dono faz hold e desliga o laser com 0x9E, sem cancelar", async () => {
      const { fake, grbl, agent } = await setup();
      const owner = new TestClient("a");
      agent.connect(owner);
      startJob(agent, owner);
      await vi.advanceTimersByTimeAsync(100);

      agent.disconnect(owner);
      expect(fake.realtime.at(-1)).toBe("!");
      await vi.advanceTimersByTimeAsync(300); // próximo relatório com Hold
      expect(fake.realtime.at(-1)).toBe("0x9E");
      expect(fake.spindleStopped).toBe(true);
      expect(fake.state).toBe("Hold");
      expect(grbl.isRunning).toBe(true); // trabalho preservado
      expect(agent.jobInfo?.state).toBe("connectionLost");
      agent.shutdown();
    });

    it("dono mudo por 6 s faz hold, mesmo com o socket aberto", async () => {
      const { fake, agent } = await setup(30);
      const owner = new TestClient("a");
      agent.connect(owner);
      startJob(agent, owner);
      await vi.advanceTimersByTimeAsync(HEARTBEAT_TIMEOUT_MS - 1000);
      expect(agent.jobInfo?.state).toBe("running");
      await vi.advanceTimersByTimeAsync(1500);
      expect(agent.jobInfo?.state).toBe("connectionLost");
      expect(fake.realtime).toContain("!");
      expect(owner.of("log").some((m) => m.text.includes("Sem sinal"))).toBe(true);
      agent.shutdown();
    });

    it("outro cliente conectado não impede o hold quando o dono cai", async () => {
      const { agent } = await setup();
      const owner = new TestClient("pc");
      const phone = new TestClient("celular");
      agent.connect(owner);
      agent.connect(phone);
      startJob(agent, owner);
      await vi.advanceTimersByTimeAsync(100);
      agent.disconnect(owner);
      expect(agent.jobInfo?.state).toBe("connectionLost");
      expect(phone.of("job").at(-1)?.job?.state).toBe("connectionLost");
      expect(phone.of("job").at(-1)?.job?.ownedByYou).toBe(false);
      agent.shutdown();
    });

    it("cliente que reconecta vê o trabalho pausado e pode retomar", async () => {
      const { fake, grbl, agent } = await setup(30);
      const owner = new TestClient("a");
      agent.connect(owner);
      startJob(agent, owner, 200);
      await vi.advanceTimersByTimeAsync(100);
      agent.disconnect(owner);
      await vi.advanceTimersByTimeAsync(10_000);

      const back = new TestClient("b");
      agent.connect(back);
      const hello = back.of("hello")[0]!;
      expect(hello.job?.state).toBe("connectionLost");
      expect(hello.job?.reason).toContain("desconectou");

      agent.receive(back, { type: "resume", confirmLaserOn: true });
      expect(fake.realtime.at(-1)).toBe("~");
      expect(back.of("job").at(-1)?.job).toMatchObject({ state: "running", ownedByYou: true });
      expect(grbl.isSpindleStopped).toBe(false);
      await keepAlive(agent, back, 10_000);
      expect(back.of("jobEnded").map((m) => m.result.outcome)).toEqual(["completed"]);
      agent.shutdown();
    });

    it("cancela com reset e M5 se ninguém reconectar em 60 s", async () => {
      const { fake, grbl, agent } = await setup();
      const owner = new TestClient("a");
      agent.connect(owner);
      startJob(agent, owner);
      await vi.advanceTimersByTimeAsync(100);
      agent.disconnect(owner);

      await vi.advanceTimersByTimeAsync(59_000);
      expect(grbl.isRunning).toBe(true);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(grbl.isRunning).toBe(false);
      expect(agent.jobInfo).toBeNull();
      expect(fake.realtime).toContain("0x18");
      expect(fake.lines.at(-1)).toBe("M5");
      agent.shutdown();
    });

    it("não cancela enquanto alguém conectado está decidindo", async () => {
      const { grbl, agent } = await setup();
      const owner = new TestClient("a");
      const phone = new TestClient("celular");
      agent.connect(owner);
      agent.connect(phone);
      startJob(agent, owner);
      await vi.advanceTimersByTimeAsync(100);
      agent.disconnect(owner);
      await keepAlive(agent, phone, 120_000);
      expect(grbl.isRunning).toBe(true);
      expect(agent.jobInfo?.state).toBe("connectionLost");
      agent.shutdown();
    });

    it("desconexão de quem só observa não afeta o trabalho", async () => {
      const { agent } = await setup(30);
      const owner = new TestClient("pc");
      const phone = new TestClient("celular");
      agent.connect(owner);
      agent.connect(phone);
      startJob(agent, owner);
      agent.disconnect(phone);
      await keepAlive(agent, owner, 4000);
      expect(agent.jobInfo?.state).toBe("running");
      agent.shutdown();
    });
  });
});

describe("Agent: limites", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("recusa trabalho fora dos limites sem enviar nada ao GRBL", async () => {
    const { fake, grbl, agent } = await setup();
    const c = new TestClient("a");
    agent.connect(c);
    const before = fake.lines.length;
    agent.receive(c, { type: "job", name: "grande.gcode", gcode: "M4 S1500\nG1 X500 Y10 F1000", confirmLaserOn: true });
    expect(grbl.isRunning).toBe(false);
    const rejected = c.of("jobRejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.problems.map((p) => p.line)).toEqual([1, 2]);
    await vi.advanceTimersByTimeAsync(100);
    expect(fake.lines.length).toBe(before);
    agent.shutdown();
  });

  it("informa os limites no hello", async () => {
    const { agent } = await setup();
    const c = new TestClient("a");
    agent.connect(c);
    expect(c.of("hello")[0]!.limits).toEqual({ maxSpindle: 1000, workArea: { x: 400, y: 300 } });
    agent.shutdown();
  });
});
