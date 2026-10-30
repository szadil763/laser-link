import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QUEUE_MAX_ITEMS, parseClientMessage } from "@laserlink/shared";
import { Agent } from "../src/agent.js";
import { TestClient, openGrbl, sampleJob, testConfig } from "./helpers.js";

async function setup() {
  const { fake, grbl } = await openGrbl({ msPerLine: 5 });
  const agent = new Agent({ config: testConfig(), grbl, portLabel: "simulador" });
  const c = new TestClient("a");
  agent.connect(c);
  return { fake, grbl, agent, c };
}

const job = (n = 50): string => sampleJob(n).join("\n");
const lastQueue = (c: TestClient) => c.of("queue").at(-1)!.items;

/** Ping a cada 2 s, como a interface faz. */
async function keepAlive(agent: Agent, c: TestClient, ms: number): Promise<void> {
  for (let t = 0; t < ms; t += 2000) {
    agent.receive(c, { type: "ping", t });
    await vi.advanceTimersByTimeAsync(Math.min(2000, ms - t));
  }
}

describe("fila de trabalhos", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("manda a fila (vazia) ao conectar", async () => {
    const { agent, c } = await setup();
    expect(c.of("queue")).toEqual([{ type: "queue", items: [] }]);
    agent.shutdown();
  });

  it("guardar na fila não fala com a laser e mostra linhas, tempo e área", async () => {
    const { fake, grbl, agent, c } = await setup();
    const before = fake.lines.length;
    agent.receive(c, { type: "queueAdd", name: "caixa.gcode", gcode: job(50) });
    expect(grbl.isRunning).toBe(false);
    expect(fake.lines.length).toBe(before);
    const [item] = lastQueue(c);
    expect(item).toMatchObject({ name: "caixa.gcode", lines: 50 });
    expect(item!.estimatedSec).toBeGreaterThan(0);
    expect(item!.bounds).not.toBeNull();
    expect(item).not.toHaveProperty("gcode");
    agent.shutdown();
  });

  it("recusa na entrada o G-code fora dos limites", async () => {
    const { agent, c } = await setup();
    agent.receive(c, { type: "queueAdd", name: "grande.gcode", gcode: "G21\nG90\nG1 X900 Y10 F1000" });
    expect(c.of("jobRejected")).toHaveLength(1);
    expect(agent.queueLength).toBe(0);
    agent.shutdown();
  });

  it("nunca inicia o próximo sozinho quando um trabalho termina", async () => {
    const { grbl, agent, c } = await setup();
    agent.receive(c, { type: "queueAdd", name: "a.gcode", gcode: job(40) });
    agent.receive(c, { type: "queueAdd", name: "b.gcode", gcode: job(40) });
    const [a] = lastQueue(c);
    agent.receive(c, { type: "queueStart", id: a!.id, confirmLaserOn: true });
    expect(grbl.isRunning).toBe(true);
    expect(lastQueue(c).map((q) => q.name)).toEqual(["b.gcode"]);
    await keepAlive(agent, c, 6000);
    expect(c.of("jobEnded").map((m) => m.result.outcome)).toEqual(["completed"]);
    await keepAlive(agent, c, 6000);
    expect(grbl.isRunning).toBe(false);
    expect(agent.jobInfo).toBeNull();
    expect(agent.queueLength).toBe(1);
    agent.shutdown();
  });

  it("iniciar da fila exige a confirmação de laser ligado", async () => {
    const { grbl, agent, c } = await setup();
    agent.receive(c, { type: "queueAdd", name: "a.gcode", gcode: job() });
    const [a] = lastQueue(c);
    agent.receive(c, { type: "queueStart", id: a!.id });
    expect(c.of("error")).toHaveLength(1);
    expect(grbl.isRunning).toBe(false);
    expect(parseClientMessage({ type: "queueStart", id: a!.id, confirmLaserOn: "true" })).toBeNull();
    agent.shutdown();
  });

  it("não inicia da fila com outro trabalho em andamento e mantém o item", async () => {
    const { agent, c } = await setup();
    agent.receive(c, { type: "queueAdd", name: "a.gcode", gcode: job() });
    agent.receive(c, { type: "job", name: "direto.gcode", gcode: job(300), confirmLaserOn: true });
    const [a] = lastQueue(c);
    agent.receive(c, { type: "queueStart", id: a!.id, confirmLaserOn: true });
    expect(c.of("error").at(-1)!.message).toMatch(/andamento/);
    expect(agent.queueLength).toBe(1);
    agent.shutdown();
  });

  it("confere de novo ao iniciar: a origem pode ter mudado", async () => {
    const { fake, grbl } = await openGrbl({ msPerLine: 5 });
    const config = testConfig({ machineLimits: { xMin: 0, xMax: 400, yMin: 0, yMax: 300 } });
    const agent = new Agent({ config, grbl, portLabel: "simulador" });
    const c = new TestClient("a");
    agent.connect(c);
    await vi.advanceTimersByTimeAsync(300); // primeiro relatório de status (origem em 0)
    agent.receive(c, { type: "queueAdd", name: "a.gcode", gcode: "G21\nG90\nG1 X300 Y10 F1000" });
    expect(agent.queueLength).toBe(1);
    // origem movida para X200 da máquina: X300 de trabalho vira X500, fora do curso
    fake.mpos = { x: 200, y: 0, z: 0 };
    agent.receive(c, { type: "setOrigin" });
    await vi.advanceTimersByTimeAsync(300);
    agent.receive(c, { type: "queueStart", id: lastQueue(c)[0]!.id, confirmLaserOn: true });
    expect(c.of("jobRejected")).toHaveLength(1);
    expect(grbl.isRunning).toBe(false);
    expect(agent.queueLength).toBe(1);
    agent.shutdown();
  });

  it("tira, reordena e limita a quantidade", async () => {
    const { agent, c } = await setup();
    for (const n of ["a", "b", "c"]) agent.receive(c, { type: "queueAdd", name: `${n}.gcode`, gcode: job() });
    const ids = lastQueue(c).map((q) => q.id);
    agent.receive(c, { type: "queueMove", id: ids[2]!, index: 0 });
    expect(lastQueue(c).map((q) => q.name)).toEqual(["c.gcode", "a.gcode", "b.gcode"]);
    agent.receive(c, { type: "queueMove", id: ids[2]!, index: 99 });
    expect(lastQueue(c).map((q) => q.name)).toEqual(["a.gcode", "b.gcode", "c.gcode"]);
    agent.receive(c, { type: "queueRemove", id: ids[1]! });
    expect(lastQueue(c).map((q) => q.name)).toEqual(["a.gcode", "c.gcode"]);
    agent.receive(c, { type: "queueRemove", id: ids[1]! });
    expect(c.of("error").at(-1)!.message).toMatch(/não está mais na fila/);
    for (let i = agent.queueLength; i < QUEUE_MAX_ITEMS; i++) agent.receive(c, { type: "queueAdd", name: `x${i}`, gcode: job(10) });
    agent.receive(c, { type: "queueAdd", name: "demais", gcode: job(10) });
    expect(agent.queueLength).toBe(QUEUE_MAX_ITEMS);
    expect(c.of("error").at(-1)!.message).toMatch(/já tem/);
    agent.shutdown();
  });

  it("todos os clientes veem a mesma fila", async () => {
    const { agent, c } = await setup();
    const other = new TestClient("b");
    agent.connect(other);
    agent.receive(c, { type: "queueAdd", name: "a.gcode", gcode: job() });
    expect(lastQueue(other).map((q) => q.name)).toEqual(["a.gcode"]);
    agent.shutdown();
  });

  it("valida as mensagens da fila", () => {
    expect(parseClientMessage({ type: "queueAdd", name: "  ", gcode: "G0" })).toBeNull();
    expect(parseClientMessage({ type: "queueAdd", name: "x".repeat(121), gcode: "G0" })).toBeNull();
    expect(parseClientMessage({ type: "queueMove", id: "a", index: 1.5 })).toBeNull();
    expect(parseClientMessage({ type: "queueRemove", id: "" })).toBeNull();
    expect(parseClientMessage({ type: "queueAdd", name: " a ", gcode: "G0" })).toEqual({ type: "queueAdd", name: "a", gcode: "G0" });
  });
});
