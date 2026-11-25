import { describe, expect, it } from "vitest";
import { compensateKerf, hatch, nestingDepth, offsetPath, orderPaths, boundsOfPaths, type Path } from "../src/index.js";

const rect = (x: number, y: number, w: number, h: number): Path => ({
  closed: true,
  points: [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]],
});

describe("hatch", () => {
  it("preenche um quadrado em zigue-zague", () => {
    const segs = hatch([rect(0, 0, 10, 10)], 1);
    expect(segs).toHaveLength(10);
    expect(segs[0]).toEqual([[0, 0.5], [10, 0.5]]);
    expect(segs[1]).toEqual([[10, 1.5], [0, 1.5]]); // volta no sentido contrário
    for (const [a, b] of segs) expect(Math.abs(b[0] - a[0])).toBeCloseTo(10);
  });

  it("deixa furos sem preencher (par-ímpar)", () => {
    const segs = hatch([rect(0, 0, 10, 10), rect(4, 4, 2, 2)], 1);
    const row = segs.filter(([a]) => a[1] === 4.5);
    expect(row).toHaveLength(2); // a linha que cruza o furo vira dois trechos
    const total = row.reduce((s, [a, b]) => s + Math.abs(b[0] - a[0]), 0);
    expect(total).toBeCloseTo(8);
  });

  it("ignora caminhos abertos e recusa intervalo zero", () => {
    expect(hatch([{ closed: false, points: [[0, 0], [10, 0]] }], 1)).toEqual([]);
    expect(() => hatch([rect(0, 0, 1, 1)], 0)).toThrow();
  });
});

describe("orderPaths", () => {
  it("vai para o caminho mais próximo e inverte abertos quando convém", () => {
    const far: Path = { closed: false, points: [[100, 0], [110, 0]] };
    const near: Path = { closed: false, points: [[20, 0], [10, 0]] };
    const out = orderPaths([far, near], [0, 0]);
    expect(out[0]!.points[0]).toEqual([10, 0]); // entrou pela ponta mais próxima
    expect(out[1]!.points[0]).toEqual([100, 0]);
  });

  it("corta furos antes do contorno que os contém", () => {
    const outer = rect(0, 0, 100, 100);
    const hole1 = rect(80, 80, 5, 5);
    const hole2 = rect(10, 10, 5, 5);
    // o contorno começa mais perto, mas tem que ficar por último
    const out = orderPaths([outer, hole1, hole2], [0, 0], { innerFirst: true });
    expect(boundsOfPaths([out[2]!])).toEqual({ minX: 0, minY: 0, maxX: 100, maxY: 100 });
  });

  it("gira o início de um caminho fechado para o vértice mais próximo", () => {
    const out = orderPaths([rect(0, 0, 10, 10)], [10, 10]);
    expect(out[0]!.points[0]).toEqual([10, 10]);
    expect(out[0]!.points.at(-1)).toEqual([10, 10]);
    expect(out[0]!.points).toHaveLength(5);
  });
});

describe("offset e kerf", () => {
  it("cresce e encolhe um quadrado", () => {
    const grown = offsetPath(rect(0, 0, 10, 10), 1, "miter");
    expect(boundsOfPaths(grown)).toEqual({ minX: -1, minY: -1, maxX: 11, maxY: 11 });
    const shrunk = offsetPath(rect(0, 0, 10, 10), -1, "miter");
    expect(boundsOfPaths(shrunk)).toEqual({ minX: 1, minY: 1, maxX: 9, maxY: 9 });
  });

  it("funciona com o caminho em qualquer sentido", () => {
    const cw: Path = { closed: true, points: rect(0, 0, 10, 10).points.slice().reverse() };
    expect(boundsOfPaths(offsetPath(cw, 1, "miter"))).toEqual({ minX: -1, minY: -1, maxX: 11, maxY: 11 });
  });

  it("encolher demais faz o caminho sumir", () => {
    expect(offsetPath(rect(0, 0, 2, 2), -2)).toEqual([]);
  });

  it("kerf: peça cresce kerf/2, furo encolhe kerf/2", () => {
    const out = compensateKerf([rect(0, 0, 50, 50), rect(20, 20, 10, 10)], 0.2);
    const boxes = out.map((p) => boundsOfPaths([p])!);
    const outer = boxes.find((b) => b.minX < 0)!;
    const hole = boxes.find((b) => b.minX > 10)!;
    expect(outer.minX).toBeCloseTo(-0.1);
    expect(outer.maxX).toBeCloseTo(50.1);
    expect(hole.minX).toBeCloseTo(20.1);
    expect(hole.maxX).toBeCloseTo(29.9);
  });

  it("calcula a profundidade de aninhamento", () => {
    expect(nestingDepth([rect(0, 0, 100, 100), rect(10, 10, 50, 50), rect(20, 20, 5, 5), { closed: false, points: [[1, 1], [2, 2]] }])).toEqual([0, 1, 2, 0]);
  });
});
