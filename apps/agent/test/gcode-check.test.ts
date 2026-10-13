import { describe, expect, it } from "vitest";
import { checkGcode, type CheckLimits } from "../src/gcode-check.js";

const limits: CheckLimits = { maxSpindle: 1000, workArea: { x: 400, y: 300 } };
const check = (gcode: string, extra: Partial<CheckLimits> = {}, ctx = {}) => checkGcode(gcode, { ...limits, ...extra }, ctx);
const messages = (gcode: string, extra: Partial<CheckLimits> = {}, ctx = {}) =>
  check(gcode, extra, ctx).problems.map((p) => `${p.line}: ${p.message}`);

describe("checkGcode", () => {
  it("aceita um trabalho dentro dos limites e calcula a área percorrida", () => {
    const r = check("G21 G90\nM4 S800\nG0 X10 Y10\nG1 X390 Y10 F1200 ; corte\nG1 Y290\nG1 X10\nG1 Y10\nM5\n");
    expect(r.problems).toEqual([]);
    expect(r.bounds).toEqual({ minX: 10, maxX: 390, minY: 10, maxY: 290 });
  });

  it("recusa S acima do máximo e informa a linha", () => {
    expect(messages("G1 X1 F100\nM4 S1200\nG1 X2")).toEqual(["2: Potência S1200 acima do máximo configurado (S1000)."]);
    expect(messages("G1X5S1001F100")).toHaveLength(1);
  });

  it("recusa deslocamento G0 fora da área (o cabeçote também anda sem laser)", () => {
    const r = messages("G0 X450 Y10");
    expect(r[0]).toContain("1: Sai da área útil: vai a X450 Y10");
  });

  it("recusa coordenadas negativas", () => {
    expect(messages("G1 X-0.5 Y10 F100")).toHaveLength(1);
  });

  it("acompanha G91 a partir da posição atual", () => {
    expect(messages("G91\nG1 X100 F100\nG1 X100", {}, { start: { x: 150, y: 0 } })).toEqual([]);
    expect(messages("G91\nG1 X100 F100\nG1 X100", {}, { start: { x: 250, y: 0 } })[0]).toContain("3: Sai da área útil");
  });

  it("converte polegadas (G20)", () => {
    expect(messages("G20\nG1 X15 F10")).toHaveLength(0); // 381 mm
    expect(messages("G20\nG1 X16 F10")).toHaveLength(1); // 406,4 mm
  });

  it("considera o ponto mais externo de arcos G2/G3", () => {
    // semicírculo de (10,150) a (50,150) passando por cima (y = 170)
    const r = check("G0 X10 Y150\nG2 X50 Y150 I20 J0 F500");
    expect(r.problems).toEqual([]);
    expect(r.bounds?.maxY).toBeCloseTo(170);
    // o mesmo arco perto da borda superior sai da área
    expect(messages("G0 X10 Y290\nG2 X50 Y290 I20 J0 F500")[0]).toContain("2: Sai da área útil");
    // sentido anti-horário passa por baixo
    expect(check("G0 X10 Y150\nG3 X50 Y150 I20 J0 F500").bounds?.minY).toBeCloseTo(130);
  });

  it("aceita arco por raio (R) e recusa raio impossível", () => {
    const r = check("G0 X10 Y150\nG2 X50 Y150 R20 F500");
    expect(r.problems).toEqual([]);
    expect(r.bounds?.maxY).toBeCloseTo(170);
    expect(messages("G0 X10 Y150\nG2 X50 Y150 R5 F500")[0]).toContain("Arco inválido");
  });

  it("círculo completo conta os quatro extremos", () => {
    const r = check("G0 X100 Y100\nG2 X100 Y100 I20 J0 F500");
    expect(r.bounds).toEqual({ minX: 100, maxX: 140, minY: expect.closeTo(80), maxY: expect.closeTo(120) });
  });

  it("recusa comandos que mudam a origem ou usam coordenadas de máquina", () => {
    const r = messages("G92 X0 Y0\nG53 G0 X0\nG28\n$H\nG10 L20 P1 X0");
    expect(r).toHaveLength(5);
    expect(r[0]).toContain("G92");
    expect(r[3]).toContain("Comandos $");
  });

  it("recusa linhas que não são G-code", () => {
    expect(messages("isto não é gcode")).toEqual(["1: Linha não reconhecida como G-code."]);
  });

  it("ignora comentários, linhas vazias e %", () => {
    expect(messages("%\n(cabeçalho)\n; comentário\n\nG1 X1 F100 (fim)\n%")).toEqual([]);
  });

  it("confere o curso da máquina quando o deslocamento de trabalho é conhecido", () => {
    const machineLimits = { xMin: 0, xMax: 400, yMin: 0, yMax: 300 };
    // origem de trabalho em X=300 da máquina: X150 de trabalho = X450 de máquina
    const r = messages("G1 X150 Y10 F100", { machineLimits }, { workOffset: { x: 300, y: 0 } });
    expect(r[0]).toContain("Passa do curso da máquina: X450");
    // sem deslocamento conhecido, só a área útil vale
    expect(messages("G1 X150 Y10 F100", { machineLimits })).toEqual([]);
  });

  it("resume quando há muitos pontos fora da área", () => {
    const gcode = Array.from({ length: 10 }, (_, i) => `G1 X${500 + i} F100`).join("\n");
    const r = check(gcode).problems;
    expect(r).toHaveLength(4);
    expect(r[3]!.message).toBe("Mais 7 pontos fora da área útil.");
  });
});
