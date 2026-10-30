import { describe, expect, it } from "vitest";
import { boundsOfPaths, buntingParts, layoutSheets, pencilParts, phraseParts, solidOutline, unionPaths, type Path, type Shaper } from "../src/index.js";

const sq = (x: number, y: number, s: number, ccw = true): Path => {
  const pts: Array<[number, number]> = [[x, y], [x + s, y], [x + s, y + s], [x, y + s]];
  if (!ccw) pts.reverse();
  return { closed: true, points: [...pts, pts[0]!] };
};

/** "Fonte" de teste: cada letra é um quadrado com miolo; espaço ocupa uma letra. */
const boxes: Shaper = (text, h) =>
  [...text].flatMap((ch, i) => (ch === " " ? [] : [sq(i * h * 0.8, 0, h * 0.7), sq(i * h * 0.8 + h * 0.2, h * 0.2, h * 0.3, false)]));

describe("unionPaths e solidOutline", () => {
  it("une quadrados que se sobrepõem e mantém o furo", () => {
    const u = unionPaths([sq(0, 0, 10), sq(5, 0, 10), sq(2, 2, 3, false)]);
    expect(u).toHaveLength(2);
    const b = boundsOfPaths(u)!;
    expect(b.maxX - b.minX).toBeCloseTo(15, 3);
  });

  it("a base não tem furos, cresce o contorno e junta letras próximas", () => {
    const letters = boxes("AB", 10);
    const perLetter = solidOutline(letters, 0.4);
    expect(perLetter).toHaveLength(2);
    const joined = solidOutline(letters, 2, 3);
    expect(joined).toHaveLength(1);
    const b = boundsOfPaths(joined)!;
    expect(b.minX).toBeCloseTo(-2, 1);
    expect(b.maxX).toBeCloseTo(8 + 7 + 2, 1);
  });
});

describe("painéis", () => {
  it("frase por palavra: letras e base de cada palavra", () => {
    const parts = phraseParts({ lines: ["Bem vindos"], height: 40, border: 5, baseBy: "word", guide: true }, boxes);
    expect(parts.map((p) => p.name)).toEqual(["Letras “Bem”", "Base “Bem”", "Letras “vindos”", "Base “vindos”"]);
    expect(parts[1]!.cut).toHaveLength(1);
    expect(parts[1]!.engrave.length).toBeGreaterThan(0);
    expect(() => phraseParts({ lines: ["  "], height: 40, border: 5, baseBy: "word", guide: false }, boxes)).toThrow(/frase/);
  });

  it("bandeirolas: uma por caractere, letra recortada vira peça própria", () => {
    const parts = buntingParts({ text: "OI A", shape: "pencil", width: 80, height: 140, holeD: 5, letter: "cut", letterScale: 0.8 }, boxes);
    const flags = parts.filter((p) => p.name.startsWith("Bandeirola"));
    expect(flags).toHaveLength(4);
    expect(parts.filter((p) => p.name.startsWith("Letra"))).toHaveLength(3);
    // furos + contorno; o contorno do lápis tem a ponta em (40, 0)
    const outline = flags[0]!.cut[flags[0]!.cut.length - 1]!;
    expect(outline.points[0]).toEqual([40, 0]);
    expect(flags[0]!.cut).toHaveLength(3);
    const hollow = buntingParts({ text: "O", shape: "rect", width: 80, height: 100, holeD: 0, letter: "hollow", letterScale: 1 }, boxes);
    expect(hollow[0]!.cut.length).toBeGreaterThan(1);
  });

  it("lápis: uma peça ou cinco peças por cor, e recusa medidas impossíveis", () => {
    expect(pencilParts({ length: 300, width: 40, split: false, label: "" })).toHaveLength(1);
    const split = pencilParts({ length: 300, width: 40, split: true, label: "TURMA" }, boxes);
    expect(split.map((p) => p.name)).toEqual(["Lápis: borracha", "Lápis: ponteira", "Lápis: corpo", "Lápis: madeira", "Lápis: grafite"]);
    const b = boundsOfPaths(pencilParts({ length: 300, width: 40, split: false, label: "" })[0]!.cut)!;
    expect(b.maxX).toBeCloseTo(300, 3);
    expect(b.maxY).toBeCloseTo(40, 3);
    expect(() => pencilParts({ length: 60, width: 40, split: false, label: "" })).toThrow(/comprimento/);
  });

  it("chapas: o que não cabe passa para a próxima; maior que a mesa fica de fora", () => {
    const parts = Array.from({ length: 7 }, (_, i) => ({ name: `P${i}`, cut: [sq(0, 0, 120)], engrave: [], fill: [] }));
    parts.push({ name: "Gigante", cut: [sq(0, 0, 500)], engrave: [], fill: [] });
    const { sheets, tooBig } = layoutSheets(parts, { x: 400, y: 300 });
    expect(tooBig).toEqual(["Gigante"]);
    expect(sheets.map((s) => s.length)).toEqual([6, 1]);
    for (const { part, dx, dy } of sheets[0]!) {
      const b = boundsOfPaths(part.cut)!;
      expect(b.maxX + dx).toBeLessThanOrEqual(392);
      expect(b.maxY + dy).toBeLessThanOrEqual(292);
    }
  });
});
