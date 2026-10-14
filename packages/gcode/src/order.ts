import { boundsOf, distance, pointInPolygon } from "./geometry.js";
import type { Path, Point } from "./types.js";

export interface OrderOptions {
  /** Corte: um contorno só é cortado depois de tudo que está dentro dele (a peça não cai antes da hora). */
  innerFirst?: boolean;
}

/**
 * Ordena os caminhos pelo vizinho mais próximo para reduzir deslocamentos
 * sem laser. Caminhos abertos podem ser percorridos ao contrário; nos fechados,
 * o início é girado para o vértice mais próximo.
 */
export function orderPaths(paths: readonly Path[], start: Point, options: OrderOptions = {}): Path[] {
  const n = paths.length;
  const boxes = paths.map((p) => boundsOf(p.points));
  // blockers[i] = quantos caminhos ainda não feitos estão dentro de i
  const blockers = new Array<number>(n).fill(0);
  const parents: number[][] = paths.map(() => []);
  if (options.innerFirst) {
    for (let i = 0; i < n; i++) {
      const pi = paths[i]!;
      const bi = boxes[i];
      if (!bi || pi.points.length === 0) continue;
      for (let j = 0; j < n; j++) {
        const pj = paths[j]!;
        const bj = boxes[j];
        if (i === j || !pj.closed || !bj) continue;
        if (bi.minX < bj.minX || bi.maxX > bj.maxX || bi.minY < bj.minY || bi.maxY > bj.maxY) continue;
        // i está dentro de j
        if (pointInPolygon(pi.points[0]!, pj.points)) {
          blockers[j]! += 1;
          parents[i]!.push(j);
        }
      }
    }
  }

  const done = new Array<boolean>(n).fill(false);
  const out: Path[] = [];
  let pos = start;
  for (let k = 0; k < n; k++) {
    let best = -1;
    let bestD = Infinity;
    let bestRev = false;
    let bestRot = 0;
    for (let i = 0; i < n; i++) {
      if (done[i] || blockers[i]! > 0) continue;
      const p = paths[i]!;
      if (p.points.length === 0) continue;
      if (p.closed) {
        // vértice mais próximo como ponto de entrada
        let rot = 0;
        let d = Infinity;
        p.points.forEach((pt, idx) => {
          const dd = distance(pos, pt);
          if (dd < d) {
            d = dd;
            rot = idx;
          }
        });
        if (d < bestD) [best, bestD, bestRev, bestRot] = [i, d, false, rot];
      } else {
        const d0 = distance(pos, p.points[0]!);
        const d1 = distance(pos, p.points[p.points.length - 1]!);
        if (d0 < bestD) [best, bestD, bestRev, bestRot] = [i, d0, false, 0];
        if (d1 < bestD) [best, bestD, bestRev, bestRot] = [i, d1, true, 0];
      }
    }
    if (best < 0) break;
    done[best] = true;
    for (const parent of parents[best]!) blockers[parent]! -= 1;
    const src = paths[best]!;
    let pts: Point[];
    if (src.closed) pts = rotateRing(src.points, bestRot);
    else pts = bestRev ? src.points.slice().reverse() : src.points.slice();
    out.push({ closed: src.closed, points: pts });
    pos = pts[pts.length - 1]!;
  }
  return out;
}

/** Recomeça um anel fechado no índice `start`, mantendo-o fechado. */
function rotateRing(points: readonly Point[], start: number): Point[] {
  const first = points[0]!;
  const last = points[points.length - 1]!;
  const ring = distance(first, last) < 1e-9 ? points.slice(0, -1) : points.slice();
  const k = start % ring.length;
  const out = [...ring.slice(k), ...ring.slice(0, k)];
  out.push(out[0]!);
  return out;
}
