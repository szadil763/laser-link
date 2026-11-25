import { describe, expect, it } from "vitest";
import { planFill } from "../src/index.js";

const area = { minX: 0, minY: 0, maxX: 300, maxY: 400 };

describe("planFill", () => {
  it("enche a mesa em grade com o espaço entre as peças", () => {
    // 50 + 2 = 52 por peça: 300 → 5 colunas (5·52 − 2 = 258), 400 → 7 linhas (7·52 − 2 = 362)
    const p = planFill(50, 50, { area, gap: 2, allowRotate: false })!;
    expect([p.cols, p.rows, p.slots.length]).toEqual([5, 7, 35]);
    expect(p.slots[0]).toEqual([0, 0]);
    expect(p.slots[1]).toEqual([52, 0]);
    expect(p.slots[5]).toEqual([0, 52]);
  });

  it("peça do tamanho exato da área cabe uma vez", () => {
    expect(planFill(300, 400, { area, gap: 5, allowRotate: false })!.slots).toEqual([[0, 0]]);
  });

  it("gira 90° quando cabem mais", () => {
    // 70 × 130: em pé 4 × 3 = 12; deitada (130 × 70) 2 × 5 = 10 → fica em pé
    expect(planFill(70, 130, { area, gap: 0, allowRotate: true })!.rotated).toBe(false);
    // 110 × 90: em pé 2 × 4 = 8; deitada (90 × 110) 3 × 3 = 9 → gira
    const p = planFill(110, 90, { area, gap: 0, allowRotate: true })!;
    expect([p.rotated, p.slots.length, p.width, p.height]).toEqual([true, 9, 90, 110]);
    expect(planFill(110, 90, { area, gap: 0, allowRotate: false })!.slots.length).toBe(8);
  });

  it("não põe cópia em cima de outra peça da mesa", () => {
    const obstacles = [{ minX: 0, minY: 0, maxX: 100, maxY: 100 }];
    const p = planFill(50, 50, { area, gap: 0, allowRotate: false, obstacles })!;
    expect(p.slots.length).toBe(6 * 8 - 4);
    for (const [x, y] of p.slots) expect(x >= 100 || y >= 100).toBe(true);
  });

  it("respeita a quantidade pedida", () => {
    expect(planFill(50, 50, { area, gap: 2, allowRotate: false, max: 10 })!.slots.length).toBe(10);
  });

  it("não cabe: devolve null", () => {
    expect(planFill(500, 50, { area, gap: 2, allowRotate: false })).toBeNull();
    expect(planFill(0, 50, { area, gap: 2, allowRotate: false })).toBeNull();
  });
});
