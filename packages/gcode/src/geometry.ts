import type { Bounds, Path, Point } from "./types.js";

export const EPS = 1e-6;

export function distance(a: Point, b: Point): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

export function pathLength(points: readonly Point[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += distance(points[i - 1]!, points[i]!);
  return total;
}

export function boundsOf(points: Iterable<Point>): Bounds | null {
  let b: Bounds | null = null;
  for (const [x, y] of points) {
    if (!b) b = { minX: x, minY: y, maxX: x, maxY: y };
    else {
      if (x < b.minX) b.minX = x;
      if (y < b.minY) b.minY = y;
      if (x > b.maxX) b.maxX = x;
      if (y > b.maxY) b.maxY = y;
    }
  }
  return b;
}

export function boundsOfPaths(paths: readonly Path[]): Bounds | null {
  return boundsOf(paths.flatMap((p) => p.points));
}

export function mergeBounds(a: Bounds | null, b: Bounds | null): Bounds | null {
  if (!a) return b;
  if (!b) return a;
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

/** Área com sinal (positiva = anti-horário). */
export function signedArea(points: readonly Point[]): number {
  let a = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    a += (points[j]![0] - points[i]![0]) * (points[j]![1] + points[i]![1]);
  }
  return a / 2;
}

/** Ponto dentro do polígono (regra par-ímpar). */
export function pointInPolygon(p: Point, poly: readonly Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Garante que um caminho fechado termine no ponto inicial. */
export function closeRing(points: readonly Point[]): Point[] {
  const out = points.slice();
  const first = out[0];
  const last = out[out.length - 1];
  if (first && last && distance(first, last) > EPS) out.push(first);
  return out;
}

/** Profundidade de aninhamento de cada caminho fechado (0 = externo, 1 = furo, 2 = ilha no furo…). Abertos = 0. */
export function nestingDepth(paths: readonly Path[]): number[] {
  const boxes = paths.map((p) => boundsOf(p.points));
  return paths.map((p, i) => {
    if (!p.closed || p.points.length === 0) return 0;
    const probe = p.points[0]!;
    const bi = boxes[i]!;
    let depth = 0;
    paths.forEach((q, j) => {
      if (j === i || !q.closed) return;
      const bj = boxes[j];
      if (!bj || bi.minX < bj.minX || bi.maxX > bj.maxX || bi.minY < bj.minY || bi.maxY > bj.maxY) return;
      if (pointInPolygon(probe, q.points)) depth++;
    });
    return depth;
  });
}

/** Aplica uma transformação a todos os pontos. */
export function transformPaths(paths: readonly Path[], fn: (p: Point) => Point): Path[] {
  return paths.map((p) => ({ closed: p.closed, points: p.points.map(fn) }));
}
