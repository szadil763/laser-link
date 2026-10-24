import { boundsOfPaths } from "./geometry.js";
import type { Path, Point } from "./types.js";

/**
 * Hachura horizontal par-ímpar dos caminhos fechados: furos (contornos
 * dentro de contornos) ficam de fora. Linhas alternam de sentido (zigue-zague)
 * para o cabeçote não voltar vazio. Devolve segmentos [início, fim].
 */
export function hatch(paths: readonly Path[], interval: number): Array<[Point, Point]> {
  if (!(interval > 0)) throw new Error("O intervalo da hachura precisa ser maior que zero.");
  const closed = paths.filter((p) => p.closed && p.points.length >= 3);
  const b = boundsOfPaths(closed);
  if (!b) return [];
  const out: Array<[Point, Point]> = [];
  let row = 0;
  for (let y = b.minY + interval / 2; y < b.maxY; y += interval) {
    const xs: number[] = [];
    for (const p of closed) {
      const pts = p.points;
      for (let i = 0; i < pts.length; i++) {
        const [x1, y1] = pts[i]!;
        const [x2, y2] = pts[(i + 1) % pts.length]!;
        // meio-aberto em y: um vértice exatamente na linha conta uma vez só
        if (y1 > y !== y2 > y) xs.push(x1 + ((y - y1) * (x2 - x1)) / (y2 - y1));
      }
    }
    xs.sort((a, c) => a - c);
    const segs: Array<[Point, Point]> = [];
    for (let i = 0; i + 1 < xs.length; i += 2) {
      if (xs[i + 1]! - xs[i]! > 1e-3) segs.push([[xs[i]!, y], [xs[i + 1]!, y]]);
    }
    if (row % 2 === 1) {
      segs.reverse();
      for (const s of segs) s.reverse();
    }
    out.push(...segs);
    row++;
  }
  return out;
}
