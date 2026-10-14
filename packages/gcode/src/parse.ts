import { boundsOf } from "./geometry.js";
import type { Bounds, Point } from "./types.js";

export interface Segment {
  from: Point;
  to: Point;
  /** Laser aceso (G1/G2/G3 com M3/M4 e S > 0). */
  burn: boolean;
  s: number;
  /** Linha do arquivo (1…n). */
  line: number;
}

export interface ParsedGcode {
  segments: Segment[];
  /** Retângulo de todos os movimentos (com e sem laser). */
  bounds: Bounds | null;
  /** Retângulo só do que grava. */
  burnBounds: Bounds | null;
}

const WORD = /([A-Z])\s*([-+]?(?:\d+\.?\d*|\.\d+))/g;

/**
 * Lê G-code para a pré-visualização: G0/G1/G2/G3 (arcos viram segmentos),
 * G90/G91, G20/G21, M3/M4/M5 e S. Ignora o que não move o cabeçote.
 */
export function parseGcode(text: string, start: Point = [0, 0]): ParsedGcode {
  const segments: Segment[] = [];
  let pos: Point = start;
  let absolute = true;
  let unit = 1;
  let motion = 0;
  let laserOn = false;
  let s = 0;
  const lines = text.split(/\r?\n/);
  for (let li = 0; li < lines.length; li++) {
    const code = lines[li]!.replace(/;.*$/, "").replace(/\(.*?\)/g, "").trim().toUpperCase();
    if (!code || code.startsWith("$") || code === "%") continue;
    const words = new Map<string, number[]>();
    for (const m of code.matchAll(WORD)) {
      const list = words.get(m[1]!) ?? [];
      list.push(Number(m[2]));
      words.set(m[1]!, list);
    }
    const one = (l: string): number | undefined => words.get(l)?.[0];
    for (const g of words.get("G") ?? []) {
      if (g === 0 || g === 1 || g === 2 || g === 3) motion = g;
      else if (g === 20) unit = 25.4;
      else if (g === 21) unit = 1;
      else if (g === 90) absolute = true;
      else if (g === 91) absolute = false;
    }
    for (const m of words.get("M") ?? []) {
      if (m === 3 || m === 4) laserOn = true;
      if (m === 5 || m === 2 || m === 30) laserOn = false;
    }
    const sv = one("S");
    if (sv !== undefined) s = sv;
    const xw = one("X");
    const yw = one("Y");
    const isArc = motion === 2 || motion === 3;
    if (xw === undefined && yw === undefined && !(isArc && (one("I") !== undefined || one("J") !== undefined))) continue;
    const to: Point = [
      xw === undefined ? pos[0] : absolute ? xw * unit : pos[0] + xw * unit,
      yw === undefined ? pos[1] : absolute ? yw * unit : pos[1] + yw * unit,
    ];
    const burn = motion !== 0 && laserOn && s > 0;
    if (isArc) {
      const pts = arcPoints(pos, to, motion === 2, (one("I") ?? 0) * unit, (one("J") ?? 0) * unit, one("R") !== undefined ? one("R")! * unit : undefined);
      let prev = pos;
      for (const p of pts) {
        segments.push({ from: prev, to: p, burn, s, line: li + 1 });
        prev = p;
      }
    } else {
      segments.push({ from: pos, to, burn, s, line: li + 1 });
    }
    pos = to;
  }
  return {
    segments,
    bounds: boundsOf(segments.flatMap((sg) => [sg.from, sg.to])),
    burnBounds: boundsOf(segments.filter((sg) => sg.burn).flatMap((sg) => [sg.from, sg.to])),
  };
}

/** Arco em segmentos de no máximo ~0,5 mm (ou 5°). */
function arcPoints(a: Point, b: Point, clockwise: boolean, i: number, j: number, r?: number): Point[] {
  let cx: number;
  let cy: number;
  if (r !== undefined) {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const d2 = dx * dx + dy * dy;
    if (d2 === 0) return [b];
    let h = -Math.sqrt(Math.max(0, 4 * r * r - d2)) / Math.sqrt(d2);
    if (!clockwise) h = -h;
    if (r < 0) h = -h;
    cx = a[0] + 0.5 * (dx - dy * h);
    cy = a[1] + 0.5 * (dy + dx * h);
  } else {
    cx = a[0] + i;
    cy = a[1] + j;
  }
  const radius = Math.hypot(a[0] - cx, a[1] - cy);
  const a0 = Math.atan2(a[1] - cy, a[0] - cx);
  const a1 = Math.atan2(b[1] - cy, b[0] - cx);
  let sweep = clockwise ? a0 - a1 : a1 - a0;
  while (sweep <= 1e-9) sweep += 2 * Math.PI;
  const steps = Math.max(2, Math.ceil(Math.max((sweep * radius) / 0.5, sweep / (Math.PI / 36))));
  const out: Point[] = [];
  for (let k = 1; k <= steps; k++) {
    const t = a0 + (clockwise ? -1 : 1) * (sweep * k) / steps;
    out.push(k === steps ? b : [cx + radius * Math.cos(t), cy + radius * Math.sin(t)]);
  }
  return out;
}
