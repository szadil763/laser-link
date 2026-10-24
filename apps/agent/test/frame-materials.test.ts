import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseClientMessage } from "@laserlink/shared";
import { Agent } from "../src/agent.js";
import { DEFAULT_MATERIALS, MaterialStore } from "../src/materials.js";
import { TestClient, openGrbl, testConfig } from "./helpers.js";

describe("enquadrar", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  async function setup() {
    const { fake, grbl } = await openGrbl({ msPerLine: 5 });
    const agent = new Agent({ config: testConfig(), grbl, portLabel: "sim" });
    const c = new TestClient("a");
    agent.connect(c);
    return { fake, grbl, agent, c };
  }

  it("laser desligado: percorre o retângulo sem nenhum S", async () => {
    const { fake, agent, c } = await setup();
    agent.receive(c, { type: "frame", bounds: { minX: 10, minY: 20, maxX: 60, maxY: 50 }, laser: "off" });
    for (let i = 0; i < 4; i++) {
      agent.receive(c, { type: "ping", t: i });
      await vi.advanceTimersByTimeAsync(200);
    }
    expect(fake.lines).toContain("G0 X10 Y20");
    expect(fake.lines).toContain("G1 X60 Y20 F3000");
    expect(fake.lines.some((l) => /S[1-9]/.test(l))).toBe(false);
    expect(c.of("jobEnded")[0]?.result).toMatchObject({ name: "Enquadrar (laser desligado)", outcome: "completed" });
    agent.shutdown();
  });

  it("potência mínima usa framePower e exige confirmação", async () => {
    const { fake, grbl, agent, c } = await setup();
    agent.receive(c, { type: "frame", bounds: { minX: 10, minY: 20, maxX: 60, maxY: 50 }, laser: "min" });
    expect(grbl.isRunning).toBe(false);
    expect(c.of("error")).toHaveLength(1);
    agent.receive(c, { type: "frame", bounds: { minX: 10, minY: 20, maxX: 60, maxY: 50 }, laser: "min", confirmLaserOn: true });
    await vi.advanceTimersByTimeAsync(200);
    expect(fake.lines.some((l) => l.includes("S10"))).toBe(true);
    agent.shutdown();
  });

  it("retângulo fora da área útil é recusado", async () => {
    const { grbl, agent, c } = await setup();
    agent.receive(c, { type: "frame", bounds: { minX: 10, minY: 20, maxX: 600, maxY: 50 }, laser: "off" });
    expect(grbl.isRunning).toBe(false);
    expect(c.of("jobRejected")).toHaveLength(1);
    agent.shutdown();
  });

  it("hello informa framePower e frameFeed", async () => {
    const { c, agent } = await setup();
    expect(c.of("hello")[0]!.limits).toMatchObject({ framePower: 10, frameFeed: 3000 });
    agent.shutdown();
  });
});

describe("biblioteca de materiais", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "laserlink-mat-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("começa com os materiais de exemplo (MDF primeiro)", () => {
    const store = new MaterialStore(dir);
    expect(store.all.map((m) => m.name).slice(0, 2)).toEqual(["MDF 3 mm", "MDF 6 mm"]);
    expect(store.all.map((m) => m.id)).toEqual(DEFAULT_MATERIALS.map((m) => m.id));
    expect(store.all.map((m) => m.name)).toEqual(expect.arrayContaining(["EVA 2 mm", "Papel lamicote (cartão metalizado)", "Acrílico preto 3 mm"]));
    expect(existsSync(store.file)).toBe(false); // só grava quando a pessoa salva
    expect(parseClientMessage({ type: "materialsSave", materials: DEFAULT_MATERIALS })).not.toBeNull();
  });

  it("salva, avisa todos os clientes e recarrega do arquivo", async () => {
    vi.useFakeTimers();
    const store = new MaterialStore(dir);
    const { grbl } = await openGrbl();
    const agent = new Agent({ config: testConfig(), grbl, portLabel: "sim", materials: store });
    const a = new TestClient("a");
    const b = new TestClient("b");
    agent.connect(a);
    agent.connect(b);
    expect(a.of("materials")[0]!.materials).toHaveLength(DEFAULT_MATERIALS.length);
    const acrilico = { id: "acr-3", name: "Acrílico 3 mm", thickness: 3, presets: [{ mode: "cut", speed: 200, power: 100, passes: 3 }] };
    agent.receive(a, { type: "materialsSave", materials: [...DEFAULT_MATERIALS, acrilico] });
    expect(b.of("materials").at(-1)!.materials.map((m) => m.name)).toContain("Acrílico 3 mm");
    expect(JSON.parse(readFileSync(store.file, "utf8"))).toHaveLength(DEFAULT_MATERIALS.length + 1);
    expect(new MaterialStore(dir).all).toHaveLength(DEFAULT_MATERIALS.length + 1);
    agent.shutdown();
    vi.useRealTimers();
  });

  it("recusa materiais inválidos", () => {
    const bad = [
      [{ id: "x", name: "", thickness: 3, presets: [] }],
      [{ id: "x", name: "A", thickness: 3, presets: [{ mode: "cut", speed: 100, power: 150, passes: 1 }] }],
      [{ id: "x", name: "A", thickness: 3, presets: [] }, { id: "x", name: "B", thickness: 3, presets: [] }],
      "não é lista",
    ];
    for (const materials of bad) expect(parseClientMessage({ type: "materialsSave", materials })).toBeNull();
  });

  it("arquivo corrompido não derruba o agente", () => {
    writeFileSync(join(dir, "materials.json"), "{ quebrado");
    expect(new MaterialStore(dir).all.map((m) => m.id)).toEqual(DEFAULT_MATERIALS.map((m) => m.id));
  });

  it("biblioteca salva numa versão antiga: ganha os exemplos novos sem perder as edições", () => {
    // o que a pessoa tinha: MDF 3 editado, MDF 6 apagado e um material dela
    const mdf3 = { ...structuredClone(DEFAULT_MATERIALS[0]!), name: "MDF 3 mm da loja X" };
    const meu = { id: "meu", name: "Meu material", thickness: 1, presets: [{ mode: "line", speed: 1000, power: 10, passes: 1 }] };
    writeFileSync(join(dir, "materials.json"), JSON.stringify([mdf3, meu]));
    const ids = new MaterialStore(dir).all.map((m) => m.id);
    expect(ids.slice(0, 2)).toEqual(["mdf-3", "meu"]);
    expect(ids).not.toContain("mdf-6");
    expect(ids).toContain("eva-2");
    expect(new MaterialStore(dir).all[0]!.name).toBe("MDF 3 mm da loja X");
    // apagar um exemplo novo: ele não volta
    const store = new MaterialStore(dir);
    store.save(store.all.filter((m) => m.id !== "eva-2"));
    expect(new MaterialStore(dir).all.map((m) => m.id)).not.toContain("eva-2");
  });
});
