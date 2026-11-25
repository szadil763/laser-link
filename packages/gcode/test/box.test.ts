import { describe, expect, it } from "vitest";
import { boxDesign, boxPanels, designToSvg, generateGcode, pointInPolygon, DEFAULT_BOX, type BoxOptions, type Point } from "../src/index.js";

/**
 * Monta a caixa em 3D e confere, ponto a ponto, que as paredes não se
 * sobrepõem e não deixam buracos: cada ponto da casca é coberto por
 * exatamente uma peça.
 */
function checkAssembly(o: BoxOptions): { overlaps: number; holes: number; checked: number } {
  const t = o.thickness;
  const panels = boxPanels(o);
  const byName = new Map(panels.map((p) => [p.name, p.outline]));
  const X = panels[0]!.width;
  const Z = panels[0]!.height;
  const Y = panels[2]!.width;
  const inside = (name: string, u: number, v: number): boolean => pointInPolygon([u, v] as Point, byName.get(name)!);
  let overlaps = 0;
  let holes = 0;
  let checked = 0;
  const step = 0.61;
  for (let x = 0.137; x < X; x += step) {
    for (let y = 0.211; y < Y; y += step) {
      for (let z = 0.173; z < Z; z += step) {
        const shell = x < t || x > X - t || y < t || y > Y - t || z < t || z > Z - t;
        if (!shell) continue;
        let n = 0;
        if (y < t && inside("Frente", x, z)) n++;
        if (y > Y - t && inside("Trás", x, z)) n++;
        if (x < t && inside("Lado esquerdo", y, z)) n++;
        if (x > X - t && inside("Lado direito", y, z)) n++;
        if (z < t && inside("Base", x, y)) n++;
        if (o.lid && z > Z - t && inside("Tampa", x, y)) n++;
        const openTop = !o.lid && z > Z - t && x > t && x < X - t && y > t && y < Y - t;
        checked++;
        if (n > 1) overlaps++;
        if (n === 0 && !openTop) holes++;
      }
    }
  }
  return { overlaps, holes, checked };
}

const small: BoxOptions = { ...DEFAULT_BOX, width: 60, depth: 45, height: 40, thickness: 3, finger: 8 };

describe("caixa com encaixes", () => {
  it("com tampa: as 6 peças se encaixam sem sobra nem buraco", () => {
    const r = checkAssembly(small);
    expect(r.checked).toBeGreaterThan(10000);
    expect(r.overlaps).toBe(0);
    expect(r.holes).toBe(0);
  });

  it("aberta: as 5 peças se encaixam", () => {
    const r = checkAssembly({ ...small, lid: false });
    expect(boxPanels({ ...small, lid: false })).toHaveLength(5);
    expect(r.overlaps).toBe(0);
    expect(r.holes).toBe(0);
  });

  it("outras espessuras e dentes", () => {
    for (const [t, f] of [[6, 12], [4, 15], [3, 3]] as const) {
      const r = checkAssembly({ ...small, width: 90, depth: 70, height: 65, thickness: t, finger: f });
      expect(r.overlaps, `t=${t} f=${f}`).toBe(0);
      expect(r.holes, `t=${t} f=${f}`).toBe(0);
    }
  });

  it("medidas internas somam a espessura das paredes", () => {
    const p = boxPanels({ ...small, measure: "inside", width: 100, depth: 50, height: 40, thickness: 3, lid: true });
    expect(p[0]).toMatchObject({ name: "Frente", width: 106, height: 46 });
    expect(p[2]).toMatchObject({ name: "Lado esquerdo", width: 56 });
    const open = boxPanels({ ...small, measure: "inside", width: 100, depth: 50, height: 40, thickness: 3, lid: false });
    expect(open[0]!.height).toBe(43);
  });

  it("recusa caixa pequena demais ou dente menor que a espessura", () => {
    expect(() => boxPanels({ ...small, width: 20 })).toThrow(/pequena demais/);
    expect(() => boxPanels({ ...small, finger: 2 })).toThrow(/dente/);
  });

  it("vira G-code com corte e nomes gravados, tudo dentro da mesa", () => {
    const d = boxDesign(DEFAULT_BOX);
    expect(d.vectors.map((v) => v.mode)).toEqual(["cut", "line"]);
    const r = generateGcode(d, { maxSpindle: 1000 });
    expect(r.bounds!.maxX).toBeLessThanOrEqual(10 + DEFAULT_BOX.maxRowWidth);
    expect(r.bounds!.minX).toBeGreaterThanOrEqual(0);
    // peças não se sobrepõem na mesa
    const boxes = d.panels.map((p) => [p.at[0], p.at[1], p.at[0] + p.width, p.at[1] + p.height] as const);
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const [a, b] = [boxes[i]!, boxes[j]!];
        const sep = a[2] <= b[0] || b[2] <= a[0] || a[3] <= b[1] || b[3] <= a[1];
        expect(sep).toBe(true);
      }
  });

  it("grava o nome de todas as peças quando cabem", () => {
    const d = boxDesign({ ...DEFAULT_BOX, width: 120, depth: 90, height: 70 });
    const labels = d.vectors.find((v) => v.mode === "line")!;
    const xs = labels.paths.map((p) => p.points[0]![0]);
    // um nome dentro de cada peça
    for (const panel of d.panels) {
      const inPanel = xs.some((x) => x > panel.at[0] && x < panel.at[0] + panel.width);
      expect(inPanel, panel.name).toBe(true);
    }
  });

  it("exporta SVG em mm", () => {
    const svg = designToSvg(boxDesign(small));
    expect(svg).toMatch(/<svg [^>]*width="[\d.]+mm"/);
    expect((svg.match(/stroke="#ff0000"/g) ?? []).length).toBe(1);
    expect((svg.match(/<path /g) ?? []).length).toBeGreaterThan(6);
  });
});
