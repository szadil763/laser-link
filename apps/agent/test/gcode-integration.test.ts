import { describe, expect, it } from "vitest";
import { boxDesign, carDesign, DEFAULT_BOX, DEFAULT_CAR, DEFAULT_OTTO, ottoDesign, frameGcode, generateGcode, matrixTest, DEFAULT_MATRIX, textToPaths, type JobDesign } from "@laserlink/gcode";
import { checkGcode } from "../src/gcode-check.js";

const limits = { maxSpindle: 1000, workArea: { x: 400, y: 300 } };

describe("G-code gerado pelo LaserLink passa no verificador do agente", () => {
  it("cortes, linhas, preenchidos, imagem e texto", () => {
    const design: JobDesign = {
      name: "tudo",
      rasters: [{ name: "img", bitmap: Uint8Array.from([1, 0, 1, 1]), width: 2, height: 2, x: 50, y: 50, widthMm: 4, heightMm: 4, overscan: 3, bidirectional: true, settings: { speed: 3000, power: 40, passes: 1 } }],
      vectors: [
        { name: "corte", mode: "cut", settings: { speed: 300, power: 100, passes: 2, kerf: 0.15 }, paths: [{ closed: true, points: [[10, 10], [110, 10], [110, 60], [10, 60], [10, 10]] }] },
        { name: "texto", mode: "line", settings: { speed: 1500, power: 20, passes: 1 }, paths: textToPaths("LASERLINK 2026", { height: 6, x: 20, y: 30 }) },
        { name: "fill", mode: "fill", settings: { speed: 3000, power: 35, passes: 1 }, paths: [{ closed: true, points: [[120, 10], [140, 10], [140, 30], [120, 10]] }] },
      ],
    };
    const r = generateGcode(design, { maxSpindle: 1000 });
    expect(checkGcode(r.gcode, limits).problems).toEqual([]);
  });

  it("caixa com encaixes, chassi do carrinho e robô bípede (passe por passe e peça por peça)", () => {
    for (const d of [boxDesign(DEFAULT_BOX), carDesign(DEFAULT_CAR), ottoDesign(DEFAULT_OTTO)]) {
      for (const passOrder of ["pass", "piece"] as const) {
        expect(checkGcode(generateGcode(d, { maxSpindle: 1000 }, { passOrder }).gcode, limits).problems, `${d.name} ${passOrder}`).toEqual([]);
      }
    }
  });

  it("teste de matriz e enquadrar", () => {
    expect(checkGcode(generateGcode(matrixTest(DEFAULT_MATRIX), { maxSpindle: 1000 }).gcode, limits).problems).toEqual([]);
    expect(checkGcode(frameGcode({ minX: 5, minY: 5, maxX: 100, maxY: 80 }, { feed: 3000, s: 10 }), limits).problems).toEqual([]);
  });

  it("imagem perto da borda: o overscan conta para a área", () => {
    const d: JobDesign = { name: "borda", vectors: [], rasters: [{ name: "img", bitmap: Uint8Array.from([1]), width: 1, height: 1, x: 1, y: 10, widthMm: 1, heightMm: 1, overscan: 3, bidirectional: true, settings: { speed: 3000, power: 40, passes: 1 } }] };
    expect(checkGcode(generateGcode(d, { maxSpindle: 1000 }).gcode, limits).problems[0]?.message).toContain("Sai da área útil");
  });
});
