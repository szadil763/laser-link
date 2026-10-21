import { boundsOf } from "./geometry.js";
import type { JobDesign, Point, VectorMode } from "./types.js";

const STROKE: Record<VectorMode, string> = { cut: "#ff0000", line: "#0000ff", fill: "#000000", detail: "#7f00ff" };

function fmt(n: number): string {
  return (Math.round(n * 1000) / 1000).toString();
}

/**
 * Exporta os vetores em SVG com unidades em mm (abre no Inkscape no tamanho
 * real). Cada operação ganha uma cor: vermelho = cortar, azul = gravar linha,
 * preto = preenchido, roxo = detalhado. Ao importar de volta no LaserLink,
 * vermelho volta como Cortar.
 */
export function designToSvg(design: JobDesign, margin = 0): string {
  const all: Point[] = design.vectors.flatMap((g) => g.paths.flatMap((p) => p.points));
  const b = boundsOf(all) ?? { minX: 0, minY: 0, maxX: 10, maxY: 10 };
  const x0 = b.minX - margin;
  const y1 = b.maxY + margin;
  const w = b.maxX - b.minX + 2 * margin;
  const h = b.maxY - b.minY + 2 * margin;
  const groups = design.vectors.map((g) => {
    const paths = g.paths
      .map((p) => {
        const d = p.points.map(([x, y], i) => `${i ? "L" : "M"}${fmt(x - x0)} ${fmt(y1 - y)}`).join(" ");
        return `<path d="${d}${p.closed ? " Z" : ""}"/>`;
      })
      .join("\n    ");
    const name = g.name.replace(/[&<>"]/g, "");
    return `  <g id="${name}" fill="none" stroke="${STROKE[g.mode]}" stroke-width="0.1">\n    ${paths}\n  </g>`;
  });
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!-- ${design.name.replace(/--/g, "-")} · gerado pelo Sapienza LaserLink -->`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(w)}mm" height="${fmt(h)}mm" viewBox="0 0 ${fmt(w)} ${fmt(h)}">`,
    ...groups,
    `</svg>`,
    "",
  ].join("\n");
}
