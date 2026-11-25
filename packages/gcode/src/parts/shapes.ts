import { boundsOf } from "../geometry.js";
import type { Path, Point } from "../types.js";

/** Peça plana: contorno de corte, furos (cortados antes) e gravações. Coordenadas locais, canto inferior esquerdo em (0, 0). */
export interface Piece {
  name: string;
  outline: Point[];
  holes: Path[];
  engrave: Path[];
  /** Quantas cópias cortar. */
  count: number;
}

export function rect(x: number, y: number, w: number, h: number): Path {
  return { closed: true, points: [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]] };
}

/** Retângulo centrado em (cx, cy). */
export function rectC(cx: number, cy: number, w: number, h: number): Path {
  return rect(cx - w / 2, cy - h / 2, w, h);
}

export function circle(cx: number, cy: number, d: number): Path {
  const r = d / 2;
  const n = Math.max(16, Math.min(96, Math.ceil((Math.PI * d) / 0.5)));
  const points: Point[] = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    points.push(i === n ? points[0]! : [cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return { closed: true, points };
}

export function roundedRectPoints(x: number, y: number, w: number, h: number, r: number): Point[] {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  if (rr === 0) return rect(x, y, w, h).points;
  const pts: Point[] = [];
  const arc = (cx: number, cy: number, a0: number): void => {
    for (let i = 0; i <= 8; i++) {
      const a = a0 + (i / 8) * (Math.PI / 2);
      pts.push([cx + rr * Math.cos(a), cy + rr * Math.sin(a)]);
    }
  };
  arc(x + w - rr, y + rr, -Math.PI / 2);
  arc(x + w - rr, y + h - rr, 0);
  arc(x + rr, y + h - rr, Math.PI / 2);
  arc(x + rr, y + rr, Math.PI);
  pts.push(pts[0]!);
  return pts;
}

/** Rasgo arredondado (oblongo) entre dois centros, largura `w`. */
export function slot(x1: number, y1: number, x2: number, y2: number, w: number): Path {
  const a = Math.atan2(y2 - y1, x2 - x1);
  const r = w / 2;
  const pts: Point[] = [];
  const n = 12;
  for (let i = 0; i <= n; i++) {
    const t = a - Math.PI / 2 + (i / n) * Math.PI;
    pts.push([x2 + r * Math.cos(t), y2 + r * Math.sin(t)]);
  }
  for (let i = 0; i <= n; i++) {
    const t = a + Math.PI / 2 + (i / n) * Math.PI;
    pts.push([x1 + r * Math.cos(t), y1 + r * Math.sin(t)]);
  }
  pts.push(pts[0]!);
  return { closed: true, points: pts };
}

/**
 * Retângulo w × h com abas (dentes) saindo da borda de cima e/ou de baixo.
 * `top`/`bottom`: centros das abas em x; cada aba tem `tabW` de largura e
 * `depth` de altura (normalmente a espessura do material).
 */
export function plateWithTabs(w: number, h: number, tabW: number, depth: number, top: number[] = [], bottom: number[] = []): Point[] {
  const pts: Point[] = [[0, 0]];
  for (const c of [...bottom].sort((a, b) => a - b)) {
    pts.push([c - tabW / 2, 0], [c - tabW / 2, -depth], [c + tabW / 2, -depth], [c + tabW / 2, 0]);
  }
  pts.push([w, 0], [w, h]);
  for (const c of [...top].sort((a, b) => b - a)) {
    pts.push([c + tabW / 2, h], [c + tabW / 2, h + depth], [c - tabW / 2, h + depth], [c - tabW / 2, h]);
  }
  pts.push([0, h], [0, 0]);
  return pts;
}

/** Furos de um servo SG90 visto de cima: corpo e os dois furos das orelhas. Eixo ao longo de `alongX`. */
export interface ServoSize {
  /** comprimento do corpo, mm */
  length: number;
  /** largura do corpo, mm */
  width: number;
  /** distância entre os furos das orelhas, mm */
  earHoles: number;
  /** diâmetro do furo para o parafuso da orelha, mm */
  earHoleD: number;
  /** folga em volta do corpo, mm */
  clearance: number;
}

export const SG90: ServoSize = { length: 22.8, width: 12.3, earHoles: 27.8, earHoleD: 2.2, clearance: 0.3 };

export function servoCutout(cx: number, cy: number, s: ServoSize, alongX = true): Path[] {
  const l = s.length + 2 * s.clearance;
  const w = s.width + 2 * s.clearance;
  const body = alongX ? rectC(cx, cy, l, w) : rectC(cx, cy, w, l);
  const e = s.earHoles / 2;
  const holes = alongX ? [circle(cx - e, cy, s.earHoleD), circle(cx + e, cy, s.earHoleD)] : [circle(cx, cy - e, s.earHoleD), circle(cx, cy + e, s.earHoleD)];
  return [body, ...holes];
}

export function pieceSize(p: Piece): { width: number; height: number; minX: number; minY: number } {
  const b = boundsOf(p.outline)!;
  return { width: b.maxX - b.minX, height: b.maxY - b.minY, minX: b.minX, minY: b.minY };
}
