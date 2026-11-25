import { describe, expect, it } from "vitest";
import { boundsOf, carDesign, carPieces, DEFAULT_CAR, DEFAULT_OTTO, generateGcode, ottoDesign, ottoPieces, pointInPolygon, type Piece } from "../src/index.js";

/** Todo furo fica inteiro dentro da peça e não encosta na borda (sobra ≥ 0,8 mm). */
function holesInside(p: Piece): string[] {
  const bad: string[] = [];
  p.holes.forEach((h, i) => {
    for (const pt of h.points) {
      const inside = pointInPolygon(pt, p.outline);
      const near = [-0.8, 0.8].some((dx) => [-0.8, 0.8].some((dy) => !pointInPolygon([pt[0] + dx, pt[1] + dy], p.outline)));
      if (!inside || near) {
        bad.push(`${p.name}: furo ${i + 1} em (${pt[0].toFixed(1)}, ${pt[1].toFixed(1)})`);
        return;
      }
    }
  });
  return bad;
}

/** Furos não se sobrepõem entre si (pelos retângulos envolventes). */
function holesOverlap(p: Piece): string[] {
  const boxes = p.holes.map((h) => boundsOf(h.points)!);
  const bad: string[] = [];
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]!;
      const b = boxes[j]!;
      const sep = a.maxX < b.minX || b.maxX < a.minX || a.maxY < b.minY || b.maxY < a.minY;
      // furo de orelha do servo fica dentro do retângulo do servo? não: ficam fora, então tudo separado
      if (!sep) bad.push(`${p.name}: furos ${i + 1} e ${j + 1}`);
    }
  return bad;
}

describe("chassi do carrinho", () => {
  it("base e 4 suportes; furos dentro das peças e sem sobreposição", () => {
    const pieces = carPieces(DEFAULT_CAR);
    expect(pieces.map((p) => [p.name, p.count])).toEqual([["Base do carrinho", 1], ["Suporte do motor", 4]]);
    for (const p of pieces) {
      expect(holesInside(p)).toEqual([]);
      expect(holesOverlap(p)).toEqual([]);
    }
  });

  it("os rasgos da base batem com as abas dos suportes", () => {
    const [plate, bracket] = carPieces(DEFAULT_CAR) as [Piece, Piece];
    const t = DEFAULT_CAR.thickness;
    // rasgos t × 8 (os 8 primeiros furos da base)
    const slots = plate.holes.slice(0, 8).map((h) => boundsOf(h.points)!);
    for (const s of slots) {
      expect(s.maxX - s.minX).toBeCloseTo(t);
      expect(s.maxY - s.minY).toBeCloseTo(8);
    }
    // abas do suporte: saem t acima do topo, com 8 mm de largura, nos mesmos pontos ao longo da borda
    const top = Math.max(...bracket.outline.map((p) => p[1]));
    const tabXs = [...new Set(bracket.outline.filter((p) => p[1] === top).map((p) => p[0]))].sort((a, b) => a - b);
    expect(tabXs).toEqual([8, 16, 29, 37]); // abas centradas em 12 e 33
    const leftSlotYs = slots.filter((s) => s.maxY < DEFAULT_CAR.width / 2).map((s) => (s.minY + s.maxY) / 2);
    expect([...new Set(leftSlotYs.map((v) => v.toFixed(3)))].sort()).toEqual(["12.000", "33.000"]);
    // os dois suportes de cada motor ficam afastados pela espessura do motor + folga
    const xs = [...new Set(slots.map((s) => ((s.minX + s.maxX) / 2).toFixed(3)))].map(Number).sort((a, b) => a - b);
    expect(xs[1]! - xs[0]!).toBeCloseTo(DEFAULT_CAR.motor.thickness + 0.4 + t);
  });

  it("vira G-code que cabe na mesa", () => {
    const d = carDesign(DEFAULT_CAR);
    const r = generateGcode(d, { maxSpindle: 1000 });
    expect(r.bounds!.maxX).toBeLessThanOrEqual(400);
    expect(r.bounds!.minX).toBeGreaterThanOrEqual(0);
    expect(d.placed).toHaveLength(5);
  });

  it("recusa medidas impossíveis", () => {
    expect(() => carPieces({ ...DEFAULT_CAR, width: 60 })).toThrow(/largura/);
    expect(() => carPieces({ ...DEFAULT_CAR, motor: { ...DEFAULT_CAR.motor, holeSpacing: 40 } })).toThrow(/motor/);
  });
});

describe("robô bípede tipo Otto", () => {
  it("6 peças do corpo, perna e pé em pares; furos dentro das peças", () => {
    const pieces = ottoPieces(DEFAULT_OTTO);
    const total = pieces.reduce((a, p) => a + p.count, 0);
    expect(total).toBe(6 + 2 * 3 + 2 * 2);
    for (const p of pieces) {
      expect(holesInside(p), p.name).toEqual([]);
    }
  });

  it("frente tem os dois furos do sensor e a base os dois servos do quadril", () => {
    const pieces = ottoPieces(DEFAULT_OTTO);
    const front = pieces.find((p) => p.name === "Corpo: frente")!;
    const sensor = front.holes.map((h) => boundsOf(h.points)!);
    expect(sensor).toHaveLength(2);
    expect(sensor[1]!.minX - sensor[0]!.minX).toBeCloseTo(DEFAULT_OTTO.sensor.spacing, 1);
    const base = pieces.find((p) => p.name === "Corpo: base")!;
    expect(base.holes).toHaveLength(6); // 2 × (corpo + 2 orelhas)
  });

  it("abas do suporte do pé batem com os rasgos da sola", () => {
    const pieces = ottoPieces(DEFAULT_OTTO);
    const sole = pieces.find((p) => p.name === "Pé: sola")!;
    const bracket = pieces.find((p) => p.name === "Pé: suporte do tornozelo")!;
    const slotXs = sole.holes.map((h) => { const b = boundsOf(h.points)!; return (b.minX + b.maxX) / 2; });
    const bottom = Math.min(...bracket.outline.map((p) => p[1]));
    const tabEdges = [...new Set(bracket.outline.filter((p) => p[1] === bottom).map((p) => p[0]))].sort((a, b) => a - b);
    const tabCenters = [(tabEdges[0]! + tabEdges[1]!) / 2, (tabEdges[2]! + tabEdges[3]!) / 2];
    expect(slotXs[1]! - slotXs[0]!).toBeCloseTo(tabCenters[1]! - tabCenters[0]!);
  });

  it("vira G-code que cabe na mesa", () => {
    const r = generateGcode(ottoDesign(DEFAULT_OTTO), { maxSpindle: 1000 });
    expect(r.bounds!.maxX).toBeLessThanOrEqual(400);
    expect(r.bounds!.maxY).toBeLessThanOrEqual(300);
  });
});
