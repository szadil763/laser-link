import type { JobDesign, Path, Point, VectorMode } from "./types.js";

/**
 * Leitura e escrita de DXF (formato aberto de troca de desenhos 2D).
 *
 * Leitura: LINE, LWPOLYLINE e POLYLINE (com arcos por "bulge"), CIRCLE, ARC,
 * ELLIPSE, SPLINE e INSERT (blocos, com escala e giro). Curvas viram
 * polilinhas com trechos de ~0,3 mm. Textos, cotas e hachuras são ignorados
 * (contados em `skipped`). Unidade pelo $INSUNITS; sem ele, milímetros.
 */

export interface DxfLayer {
  /** Nome da camada no DXF. */
  name: string;
  /** Cor ACI (1 = vermelho, 5 = azul, 7 = branco/preto). */
  color: number;
  paths: Path[];
}

export interface DxfImport {
  layers: DxfLayer[];
  /** Fator aplicado para chegar em mm. */
  unitToMm: number;
  /** Entidades ignoradas, por tipo. */
  skipped: Record<string, number>;
}

type Pair = [code: number, value: string];

interface Entity {
  type: string;
  pairs: Pair[];
  /** Vértices de um POLYLINE antigo. */
  vertices?: Entity[];
}

const UNITS: Record<number, number> = { 0: 1, 1: 25.4, 2: 304.8, 4: 1, 5: 10, 6: 1000, 8: 0.0000254, 9: 0.0254, 10: 914.4 };
const SEGMENT_MM = 0.3;
const MAX_DEPTH = 8;

function readPairs(text: string): Pair[] {
  const lines = text.split(/\r\n|\r|\n/);
  const out: Pair[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number.parseInt(lines[i]!.trim(), 10);
    if (!Number.isFinite(code)) throw new Error("Esse arquivo não parece um DXF de texto (ASCII). DXF binário não é aceito.");
    out.push([code, lines[i + 1]!.trim()]);
  }
  return out;
}

const num = (e: Entity, code: number, fallback = 0): number => {
  const p = e.pairs.find((x) => x[0] === code);
  const v = p ? Number(p[1]) : NaN;
  return Number.isFinite(v) ? v : fallback;
};
const str = (e: Entity, code: number): string | undefined => e.pairs.find((x) => x[0] === code)?.[1];
const all = (e: Entity, code: number): number[] => e.pairs.filter((x) => x[0] === code).map((x) => Number(x[1]));

/** Separa as entidades de um trecho (ENTITIES ou um bloco), juntando VERTEX/SEQEND ao POLYLINE. */
function entities(pairs: Pair[], start: number, endMarker: string): { list: Entity[]; next: number } {
  const list: Entity[] = [];
  let i = start;
  let poly: Entity | null = null;
  while (i < pairs.length) {
    const [code, value] = pairs[i]!;
    if (code === 0 && (value === endMarker || value === "ENDSEC")) break;
    if (code !== 0) {
      i++;
      continue;
    }
    const e: Entity = { type: value, pairs: [] };
    i++;
    while (i < pairs.length && pairs[i]![0] !== 0) e.pairs.push(pairs[i++]!);
    if (e.type === "VERTEX" && poly) poly.vertices!.push(e);
    else if (e.type === "SEQEND") poly = null;
    else {
      if (e.type === "POLYLINE") {
        e.vertices = [];
        poly = e;
      }
      list.push(e);
    }
  }
  return { list, next: i };
}

function arcPoints(cx: number, cy: number, r: number, a0: number, sweep: number): Point[] {
  const n = Math.max(4, Math.min(720, Math.ceil((Math.abs(sweep) * r) / SEGMENT_MM)));
  const pts: Point[] = [];
  for (let k = 0; k <= n; k++) {
    const a = a0 + (sweep * k) / n;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
}

/** Trecho entre dois vértices com "bulge" (tangente de 1/4 do ângulo do arco). */
function bulgeSegment(p1: Point, p2: Point, bulge: number): Point[] {
  if (Math.abs(bulge) < 1e-9) return [p2];
  const dx = p2[0] - p1[0];
  const dy = p2[1] - p1[1];
  const d = Math.hypot(dx, dy);
  if (d < 1e-12) return [p2];
  const sweep = 4 * Math.atan(bulge);
  const r = (d * (1 + bulge * bulge)) / (4 * Math.abs(bulge));
  const k = (1 - bulge * bulge) / (2 * bulge) / 2;
  const cx = (p1[0] + p2[0]) / 2 - dy * k;
  const cy = (p1[1] + p2[1]) / 2 + dx * k;
  const a0 = Math.atan2(p1[1] - cy, p1[0] - cx);
  const pts = arcPoints(cx, cy, r, a0, sweep).slice(1);
  pts[pts.length - 1] = p2;
  return pts;
}

function polyFromVertices(verts: Array<{ p: Point; bulge: number }>, closed: boolean): Path | null {
  if (verts.length < 2) return null;
  const pts: Point[] = [verts[0]!.p];
  const n = closed ? verts.length : verts.length - 1;
  for (let i = 0; i < n; i++) {
    const a = verts[i]!;
    const b = verts[(i + 1) % verts.length]!;
    pts.push(...bulgeSegment(a.p, b.p, a.bulge));
  }
  return { points: pts, closed };
}

/** Avalia um B-spline (de Boor) em pontos espaçados. */
function splinePoints(degree: number, knots: number[], ctrl: Point[]): Point[] {
  const n = ctrl.length;
  if (n < 2) return ctrl;
  const p = Math.max(1, Math.min(degree, n - 1));
  let k = knots;
  if (k.length !== n + p + 1) {
    // nós uniformes "clamped" quando o arquivo não traz os nós certos
    k = [];
    for (let i = 0; i <= n + p; i++) k.push(i <= p ? 0 : i >= n ? n - p : i - p);
  }
  const t0 = k[p]!;
  const t1 = k[n]!;
  let len = 0;
  for (let i = 1; i < n; i++) len += Math.hypot(ctrl[i]![0] - ctrl[i - 1]![0], ctrl[i]![1] - ctrl[i - 1]![1]);
  const steps = Math.max(8, Math.min(2000, Math.ceil(len / SEGMENT_MM)));
  const out: Point[] = [];
  for (let s = 0; s <= steps; s++) {
    const t = s === steps ? t1 : t0 + ((t1 - t0) * s) / steps;
    let span = p;
    while (span < n - 1 && t >= k[span + 1]!) span++;
    const d: Point[] = [];
    for (let j = 0; j <= p; j++) d.push([...ctrl[span - p + j]!] as Point);
    for (let r = 1; r <= p; r++) {
      for (let j = p; j >= r; j--) {
        const i = span - p + j;
        const den = k[i + p - r + 1]! - k[i]!;
        const a = den === 0 ? 0 : (t - k[i]!) / den;
        d[j] = [(1 - a) * d[j - 1]![0] + a * d[j]![0], (1 - a) * d[j - 1]![1] + a * d[j]![1]];
      }
    }
    out.push(d[p]!);
  }
  return out;
}

/** Converte uma entidade em caminhos (coordenadas do DXF, sem unidade). */
function toPaths(e: Entity): Path[] | null {
  const mirror = num(e, 230, 1) < 0; // extrusão (0,0,-1): o desenho está espelhado em X
  const fix = (paths: Path[]): Path[] => (mirror ? paths.map((p) => ({ ...p, points: p.points.map(([x, y]) => [-x, y] as Point) })) : paths);
  switch (e.type) {
    case "LINE":
      return [{ points: [[num(e, 10), num(e, 20)], [num(e, 11), num(e, 21)]], closed: false }];
    case "LWPOLYLINE": {
      const raw: Array<{ x: number; y: number; bulge: number }> = [];
      for (const [code, value] of e.pairs) {
        if (code === 10) raw.push({ x: Number(value), y: 0, bulge: 0 });
        else if (code === 20 && raw.length) raw[raw.length - 1]!.y = Number(value);
        else if (code === 42 && raw.length) raw[raw.length - 1]!.bulge = Number(value);
      }
      const verts = raw.map((v) => ({ p: [v.x, v.y] as Point, bulge: v.bulge }));
      const path = polyFromVertices(verts, (num(e, 70) & 1) === 1);
      return path ? fix([path]) : [];
    }
    case "POLYLINE": {
      const flags = num(e, 70);
      if (flags & (16 | 64)) return null; // malhas 3D
      const verts = (e.vertices ?? [])
        .filter((v) => (num(v, 70) & 16) === 0) // pontos de controle de "spline fit" não são vértices
        .map((v) => ({ p: [num(v, 10), num(v, 20)] as Point, bulge: num(v, 42) }));
      const path = polyFromVertices(verts, (flags & 1) === 1);
      return path ? fix([path]) : [];
    }
    case "CIRCLE": {
      const pts = arcPoints(num(e, 10), num(e, 20), num(e, 40), 0, Math.PI * 2);
      pts[pts.length - 1] = pts[0]!;
      return fix([{ points: pts, closed: true }]);
    }
    case "ARC": {
      const a0 = (num(e, 50) * Math.PI) / 180;
      let a1 = (num(e, 51) * Math.PI) / 180;
      while (a1 <= a0) a1 += Math.PI * 2;
      return fix([{ points: arcPoints(num(e, 10), num(e, 20), num(e, 40), a0, a1 - a0), closed: false }]);
    }
    case "ELLIPSE": {
      const cx = num(e, 10);
      const cy = num(e, 20);
      const mx = num(e, 11);
      const my = num(e, 21);
      const ratio = num(e, 40, 1);
      const t0 = num(e, 41, 0);
      let t1 = num(e, 42, Math.PI * 2);
      while (t1 <= t0) t1 += Math.PI * 2;
      const a = Math.hypot(mx, my);
      const rot = Math.atan2(my, mx);
      const full = Math.abs(t1 - t0 - Math.PI * 2) < 1e-6;
      const n = Math.max(16, Math.min(720, Math.ceil(((t1 - t0) * a) / SEGMENT_MM)));
      const pts: Point[] = [];
      for (let k = 0; k <= n; k++) {
        const t = t0 + ((t1 - t0) * k) / n;
        const x = a * Math.cos(t);
        const y = a * ratio * Math.sin(t);
        pts.push([cx + x * Math.cos(rot) - y * Math.sin(rot), cy + x * Math.sin(rot) + y * Math.cos(rot)]);
      }
      if (full) pts[pts.length - 1] = pts[0]!;
      return fix([{ points: pts, closed: full }]);
    }
    case "SPLINE": {
      const xs = all(e, 10);
      const ys = all(e, 20);
      const ctrl: Point[] = xs.map((x, i) => [x, ys[i] ?? 0]);
      let pts: Point[];
      if (ctrl.length >= 2) pts = splinePoints(num(e, 71, 3), all(e, 40), ctrl);
      else {
        const fx = all(e, 11);
        const fy = all(e, 21);
        pts = fx.map((x, i) => [x, fy[i] ?? 0] as Point);
      }
      if (pts.length < 2) return [];
      const closed = (num(e, 70) & 1) === 1;
      if (closed) pts.push(pts[0]!);
      return fix([{ points: pts, closed }]);
    }
    default:
      return null;
  }
}

interface Block {
  base: Point;
  list: Entity[];
}

/** Lê um DXF de texto e devolve os caminhos em mm, agrupados pela camada do DXF. */
export function parseDxf(text: string): DxfImport {
  const pairs = readPairs(text);
  let unitToMm = 1;
  const layerColor = new Map<string, number>();
  const blocks = new Map<string, Block>();
  let ents: Entity[] = [];
  for (let i = 0; i < pairs.length; i++) {
    const [code, value] = pairs[i]!;
    if (code !== 2) continue;
    const prev = pairs[i - 1];
    if (!prev || prev[0] !== 0 || prev[1] !== "SECTION") continue;
    if (value === "HEADER") {
      for (let j = i + 1; j < pairs.length && !(pairs[j]![0] === 0 && pairs[j]![1] === "ENDSEC"); j++) {
        if (pairs[j]![0] === 9 && pairs[j]![1] === "$INSUNITS") unitToMm = UNITS[Number(pairs[j + 1]?.[1])] ?? 1;
      }
    } else if (value === "TABLES") {
      for (let j = i + 1; j < pairs.length && !(pairs[j]![0] === 0 && pairs[j]![1] === "ENDSEC"); j++) {
        if (pairs[j]![0] === 0 && pairs[j]![1] === "LAYER") {
          let name = "0";
          let color = 7;
          for (let k = j + 1; k < pairs.length && pairs[k]![0] !== 0; k++) {
            if (pairs[k]![0] === 2) name = pairs[k]![1];
            if (pairs[k]![0] === 62) color = Math.abs(Number(pairs[k]![1])) || 7;
          }
          layerColor.set(name, color);
        }
      }
    } else if (value === "BLOCKS") {
      let j = i + 1;
      while (j < pairs.length && !(pairs[j]![0] === 0 && pairs[j]![1] === "ENDSEC")) {
        if (pairs[j]![0] === 0 && pairs[j]![1] === "BLOCK") {
          const head: Entity = { type: "BLOCK", pairs: [] };
          j++;
          while (j < pairs.length && pairs[j]![0] !== 0) head.pairs.push(pairs[j++]!);
          const { list, next } = entities(pairs, j, "ENDBLK");
          blocks.set(str(head, 2) ?? "", { base: [num(head, 10), num(head, 20)], list });
          j = next;
        } else j++;
      }
    } else if (value === "ENTITIES") {
      ents = entities(pairs, i + 1, "ENDSEC").list;
    }
  }

  const byLayer = new Map<string, DxfLayer>();
  const skipped: Record<string, number> = {};
  const add = (layer: string, color: number, paths: Path[], tf: (p: Point) => Point): void => {
    let l = byLayer.get(layer);
    if (!l) {
      l = { name: layer, color, paths: [] };
      byLayer.set(layer, l);
    }
    for (const p of paths) {
      if (p.points.length < 2) continue;
      l.paths.push({ closed: p.closed, points: p.points.map((pt) => tf(pt)).map(([x, y]) => [x * unitToMm, y * unitToMm] as Point) });
    }
  };
  const walk = (list: Entity[], tf: (p: Point) => Point, parentLayer: string | null, depth: number): void => {
    for (const e of list) {
      // camada "0" dentro de bloco herda a camada do INSERT
      const own = str(e, 8) ?? "0";
      const layer = own === "0" && parentLayer ? parentLayer : own;
      const ec = num(e, 62, 256);
      const color = ec > 0 && ec < 256 ? ec : layerColor.get(layer) ?? 7;
      if (e.type === "INSERT") {
        const block = blocks.get(str(e, 2) ?? "");
        if (!block || depth >= MAX_DEPTH) {
          skipped.INSERT = (skipped.INSERT ?? 0) + 1;
          continue;
        }
        const ix = num(e, 10);
        const iy = num(e, 20);
        const sx = num(e, 41, 1);
        const sy = num(e, 42, sx);
        const rot = (num(e, 50) * Math.PI) / 180;
        const c = Math.cos(rot);
        const s = Math.sin(rot);
        const [bx, by] = block.base;
        const local = (p: Point): Point => {
          const x = (p[0] - bx) * sx;
          const y = (p[1] - by) * sy;
          return tf([ix + x * c - y * s, iy + x * s + y * c]);
        };
        walk(block.list, local, layer, depth + 1);
        continue;
      }
      const paths = toPaths(e);
      if (paths === null) skipped[e.type] = (skipped[e.type] ?? 0) + 1;
      else add(layer, color, paths, tf);
    }
  };
  walk(ents, (p) => p, null, 0);
  const layers = [...byLayer.values()].filter((l) => l.paths.length);
  if (!layers.length) throw new Error("Não achei linhas, arcos ou curvas nesse DXF.");
  return { layers, unitToMm, skipped };
}

const DXF_LAYER: Record<VectorMode, { name: string; color: number }> = {
  cut: { name: "CORTAR", color: 1 },
  line: { name: "GRAVAR_LINHA", color: 5 },
  fill: { name: "GRAVAR_PREENCHIDO", color: 2 },
  detail: { name: "DETALHADO", color: 6 },
};

const f = (n: number): string => (Math.abs(n) < 1e-9 ? "0" : n.toFixed(4).replace(/\.?0+$/, ""));

/**
 * DXF R12 (AC1009) em mm: uma camada por operação (CORTAR em vermelho,
 * GRAVAR_LINHA em azul…), cada caminho como POLYLINE. Imagens não vão no DXF.
 */
export function designToDxf(design: JobDesign): string {
  const out: string[] = [];
  const w = (code: number, value: string | number): void => {
    out.push(String(code), typeof value === "number" ? f(value) : value);
  };
  w(999, `${design.name.replace(/[\r\n]/g, " ")} - gerado pelo Sapienza LaserLink`);
  w(0, "SECTION");
  w(2, "HEADER");
  w(9, "$ACADVER");
  w(1, "AC1009");
  w(9, "$INSUNITS");
  w(70, "4");
  w(0, "ENDSEC");
  const used = [...new Set(design.vectors.map((g) => g.mode))];
  w(0, "SECTION");
  w(2, "TABLES");
  w(0, "TABLE");
  w(2, "LAYER");
  w(70, String(used.length));
  for (const m of used) {
    w(0, "LAYER");
    w(2, DXF_LAYER[m].name);
    w(70, "0");
    w(62, String(DXF_LAYER[m].color));
    w(6, "CONTINUOUS");
  }
  w(0, "ENDTAB");
  w(0, "ENDSEC");
  w(0, "SECTION");
  w(2, "ENTITIES");
  for (const g of design.vectors) {
    const layer = DXF_LAYER[g.mode].name;
    for (const p of g.paths) {
      let pts = p.points;
      if (pts.length < 2) continue;
      const first = pts[0]!;
      const last = pts[pts.length - 1]!;
      if (p.closed && first[0] === last[0] && first[1] === last[1]) pts = pts.slice(0, -1);
      w(0, "POLYLINE");
      w(8, layer);
      w(66, "1");
      w(10, 0);
      w(20, 0);
      w(30, 0);
      w(70, p.closed ? "1" : "0");
      for (const [x, y] of pts) {
        w(0, "VERTEX");
        w(8, layer);
        w(10, x);
        w(20, y);
        w(30, 0);
      }
      w(0, "SEQEND");
      w(8, layer);
    }
  }
  w(0, "ENDSEC");
  w(0, "EOF");
  return out.join("\r\n") + "\r\n";
}
