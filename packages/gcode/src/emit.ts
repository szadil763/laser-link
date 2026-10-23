import { boundsOf, distance, nestingDepth, pathLength, pointInPolygon } from "./geometry.js";
import { hatch } from "./hatch.js";
import { compensateKerf } from "./offset.js";
import { orderPathIndices, orderPaths } from "./order.js";
import { runsOfRow } from "./raster.js";
import type { Bounds, JobDesign, MachineProfile, OpSettings, Path, Point, RasterGroup, VectorGroup, VectorMode } from "./types.js";

/** Ordem de execução: imagem primeiro, cortes por último (a peça só se solta no fim). */
export const MODE_ORDER: readonly VectorMode[] = ["detail", "fill", "line", "cut"];

export const DEFAULT_INTERVAL: Record<"fill" | "detail", number> = { fill: 0.2, detail: 0.08 };

/**
 * Ordem dos passes de linhas e cortes:
 * - "pass": passe 1 em todas as peças, depois passe 2 em todas… (cada peça esfria entre um passe e outro);
 * - "piece": todos os passes de uma peça (furos primeiro, contorno por último), depois a próxima peça.
 */
export type PassOrder = "pass" | "piece";

export interface GenerateOptions {
  /** Padrão: "pass". */
  passOrder?: PassOrder;
  /** Velocidade estimada dos deslocamentos sem laser (só para a estimativa de tempo), mm/min. */
  travelFeed?: number;
  /** Volta para a origem de trabalho no fim. Padrão: sim. */
  returnToOrigin?: boolean;
  /** Data no cabeçalho (fixa nos testes). */
  date?: Date;
}

export interface GenerateResult {
  gcode: string;
  /** Linhas de G-code (sem comentários). */
  lines: number;
  /** Área percorrida pelo cabeçote, mm. */
  bounds: Bounds | null;
  /** Estimativa sem aceleração, em segundos. */
  estimatedSeconds: number;
  burnMm: number;
  travelMm: number;
  /** Maior S usado. */
  maxS: number;
}

function fmt(n: number): string {
  const r = Math.round(n * 1000) / 1000;
  return (Object.is(r, -0) ? 0 : r).toString();
}

/** Escreve G-code sem repetir palavras modais (economiza bytes no streaming). */
class Writer {
  readonly out: string[] = [];
  private x: number | null = null;
  private y: number | null = null;
  private feed: number | null = null;
  private s: number | null = null;
  private motion: 0 | 1 | null = null;
  burnMm = 0;
  travelMm = 0;
  seconds = 0;
  maxS = 0;
  private readonly visited: Point[] = [];

  constructor(private readonly travelFeed: number) {}

  get pos(): Point {
    return [this.x ?? 0, this.y ?? 0];
  }

  comment(text: string): void {
    this.out.push(`; ${text.replace(/[\r\n]+/g, " ")}`);
  }

  raw(line: string): void {
    this.out.push(line);
  }

  rapid(p: Point): void {
    if (this.x !== null && this.y !== null && distance(this.pos, p) < 1e-4) return;
    const d = distance(this.pos, p);
    this.travelMm += d;
    this.seconds += (d / this.travelFeed) * 60;
    this.move(0, p, null, null);
  }

  burn(p: Point, feed: number, s: number): void {
    const d = distance(this.pos, p);
    if (d < 1e-4) return;
    if (s > 0) this.burnMm += d;
    this.seconds += (d / feed) * 60;
    if (s > this.maxS) this.maxS = s;
    this.move(1, p, feed, s);
  }

  private move(motion: 0 | 1, p: Point, feed: number | null, s: number | null): void {
    const words: string[] = [];
    if (this.motion !== motion) words.push(motion === 0 ? "G0" : "G1");
    const nx = fmt(p[0]);
    const ny = fmt(p[1]);
    if (this.x === null || fmt(this.x) !== nx) words.push(`X${nx}`);
    if (this.y === null || fmt(this.y) !== ny) words.push(`Y${ny}`);
    if (feed !== null && feed !== this.feed) {
      words.push(`F${fmt(feed)}`);
      this.feed = feed;
    }
    if (s !== null && s !== this.s) {
      words.push(`S${s}`);
      this.s = s;
    }
    if (words.length === 0) return;
    this.out.push(words.join(" "));
    this.motion = motion;
    this.x = p[0];
    this.y = p[1];
    this.visited.push(p);
  }

  bounds(): Bounds | null {
    return boundsOf(this.visited);
  }
}

/** S inteiro proporcional à potência em %. */
export function powerToS(power: number, machine: MachineProfile): number {
  const p = Math.max(0, Math.min(100, power));
  return Math.round((p / 100) * machine.maxSpindle);
}

function describe(g: { name: string }, mode: string, s: OpSettings, extra = ""): string {
  return `${g.name}: ${mode}, ${s.speed} mm/min, ${s.power}%, ${s.passes} passe(s)${extra}`;
}

const MODE_LABEL: Record<VectorMode, string> = { cut: "Cortar", line: "Gravar linha", fill: "Gravar preenchido", detail: "Detalhado" };

function validateSettings(s: OpSettings, where: string): void {
  if (!(s.speed > 0)) throw new Error(`${where}: a velocidade precisa ser maior que zero.`);
  if (!(s.power >= 0 && s.power <= 100)) throw new Error(`${where}: a potência precisa estar entre 0 e 100%.`);
  if (!(Number.isInteger(s.passes) && s.passes >= 1)) throw new Error(`${where}: o número de passes precisa ser 1 ou mais.`);
}

function emitRaster(w: Writer, r: RasterGroup, machine: MachineProfile): void {
  validateSettings(r.settings, r.name);
  const s = powerToS(r.settings.power, machine);
  const px = r.widthMm / r.width;
  const py = r.heightMm / r.height;
  w.comment(describe(r, "Gravar imagem", r.settings, `, ${fmt(1 / py)} linhas/mm, overscan ${r.overscan} mm`));
  for (let pass = 0; pass < r.settings.passes; pass++) {
    let k = 0;
    for (let row = 0; row < r.height; row++) {
      const runs = runsOfRow(r.bitmap, r.width, row);
      if (runs.length === 0) continue;
      const y = r.y + r.heightMm - (row + 0.5) * py;
      const forward = !r.bidirectional || k % 2 === 0;
      k++;
      const xs = (v: number): number => r.x + v * px;
      const seq = forward ? runs : runs.slice().reverse().map(([a, b]) => [b, a] as [number, number]);
      const first = seq[0]!;
      const last = seq[seq.length - 1]!;
      const dir = forward ? 1 : -1;
      w.rapid([xs(first[0]) - dir * r.overscan, y]);
      w.burn([xs(first[0]), y], r.settings.speed, 0);
      seq.forEach(([a, b], i) => {
        if (i > 0) w.burn([xs(a), y], r.settings.speed, 0);
        w.burn([xs(b), y], r.settings.speed, s);
      });
      w.burn([xs(last[1]) + dir * r.overscan, y], r.settings.speed, 0);
    }
  }
}

function emitPaths(w: Writer, paths: readonly Path[], settings: OpSettings, s: number): void {
  for (const p of paths) {
    if (p.points.length < 2) continue;
    w.rapid(p.points[0]!);
    for (const pt of p.points.slice(1)) w.burn(pt, settings.speed, s);
  }
}

function emitVector(w: Writer, g: VectorGroup, machine: MachineProfile): void {
  validateSettings(g.settings, g.name);
  const s = powerToS(g.settings.power, machine);
  if (g.mode === "fill" || g.mode === "detail") {
    const interval = g.settings.interval ?? DEFAULT_INTERVAL[g.mode];
    w.comment(describe(g, MODE_LABEL[g.mode], g.settings, `, intervalo ${interval} mm`));
    const segs = hatch(g.paths, interval);
    for (let pass = 0; pass < g.settings.passes; pass++) {
      for (const [a, b] of segs) {
        // linhas vizinhas no mesmo sentido do zigue-zague: liga direto em S0 se estiver perto
        if (distance(w.pos, a) <= interval * 3) w.burn(a, g.settings.speed, 0);
        else w.rapid(a);
        w.burn(b, g.settings.speed, s);
      }
    }
    return;
  }
  let paths: Path[] = g.paths.filter((p) => p.points.length >= 2);
  const kerf = g.mode === "cut" ? (g.settings.kerf ?? 0) : 0;
  if (kerf > 0) paths = compensateKerf(paths, kerf);
  w.comment(describe(g, MODE_LABEL[g.mode], g.settings, kerf > 0 ? `, kerf ${kerf} mm` : ""));
  for (let pass = 0; pass < g.settings.passes; pass++) {
    const ordered = orderPaths(paths, w.pos, { innerFirst: g.mode === "cut" });
    emitPaths(w, ordered, g.settings, s);
  }
}

interface PieceItem {
  path: Path;
  settings: OpSettings;
  s: number;
}

/**
 * Peça por peça: junta cada contorno externo com tudo que está dentro dele (furos, ilhas,
 * gravações) e faz todos os passes de cada caminho antes do próximo. Nos cortes, o que
 * está dentro sai antes do contorno, então a peça só se solta quando está pronta.
 */
function emitByPiece(w: Writer, groups: readonly VectorGroup[], machine: MachineProfile): void {
  const mode = groups[0]!.mode;
  const items: PieceItem[] = [];
  for (const g of groups) {
    validateSettings(g.settings, g.name);
    const s = powerToS(g.settings.power, machine);
    let paths: Path[] = g.paths.filter((p) => p.points.length >= 2);
    const kerf = mode === "cut" ? (g.settings.kerf ?? 0) : 0;
    if (kerf > 0) paths = compensateKerf(paths, kerf);
    w.comment(describe(g, MODE_LABEL[g.mode], g.settings, `${kerf > 0 ? `, kerf ${kerf} mm` : ""}, peça por peça`));
    for (const path of paths) items.push({ path, settings: g.settings, s });
  }
  // cada caminho vai para o menor contorno externo que o contém (ou forma uma peça sozinho)
  const paths = items.map((it) => it.path);
  const depth = nestingDepth(paths);
  const boxes = paths.map((p) => boundsOf(p.points)!);
  const area = (i: number): number => (boxes[i]!.maxX - boxes[i]!.minX) * (boxes[i]!.maxY - boxes[i]!.minY);
  const tops = paths.map((p, i) => i).filter((i) => paths[i]!.closed && depth[i] === 0);
  const owner = paths.map((p, i) => {
    if (tops.includes(i)) return i;
    const probe = p.points[0]!;
    let best = -1;
    for (const t of tops) {
      const b = boxes[t]!;
      if (probe[0] < b.minX || probe[0] > b.maxX || probe[1] < b.minY || probe[1] > b.maxY) continue;
      if (pointInPolygon(probe, paths[t]!.points) && (best < 0 || area(t) < area(best))) best = t;
    }
    return best < 0 ? i : best;
  });
  const pieces = new Map<number, number[]>();
  owner.forEach((o, i) => pieces.set(o, [...(pieces.get(o) ?? []), i]));
  const remaining = [...pieces.values()];
  const boxOf = (idx: number[]): Bounds => boundsOf(idx.flatMap((i) => paths[i]!.points))!;
  const boxDist = (p: Point, b: Bounds): number => Math.hypot(Math.max(b.minX - p[0], 0, p[0] - b.maxX), Math.max(b.minY - p[1], 0, p[1] - b.maxY));
  while (remaining.length) {
    // próxima peça: a mais perto do cabeçote
    let k = 0;
    let kd = Infinity;
    remaining.forEach((idx, j) => {
      const d = boxDist(w.pos, boxOf(idx));
      if (d < kd) [k, kd] = [j, d];
    });
    const idx = remaining.splice(k, 1)[0]!;
    const ordered = orderPathIndices(
      idx.map((i) => paths[i]!),
      w.pos,
      { innerFirst: mode === "cut" },
    );
    for (const o of ordered) {
      const it = items[idx[o.index]!]!;
      let pts = o.points;
      for (let pass = 0; pass < it.settings.passes; pass++) {
        // caminho aberto vai e volta (sem deslocamento vazio entre os passes)
        if (pass > 0 && !o.closed) pts = pts.slice().reverse();
        emitPaths(w, [{ closed: o.closed, points: pts }], it.settings, it.s);
      }
    }
  }
}

/**
 * Gera o G-code do trabalho inteiro: M4 (potência dinâmica, o laser enfraquece
 * nas curvas e apaga parado), S proporcional à potência, imagem primeiro e
 * cortes por último, caminhos em ordem de vizinho mais próximo, kerf compensado.
 */
export function generateGcode(design: JobDesign, machine: MachineProfile, options: GenerateOptions = {}): GenerateResult {
  if (!(machine.maxSpindle > 0)) throw new Error("maxSpindle precisa ser maior que zero.");
  const w = new Writer(options.travelFeed ?? 6000);
  w.comment(`Sapienza LaserLink: ${design.name}`);
  w.comment(`Gerado em ${(options.date ?? new Date()).toISOString()}`);
  w.raw("G21 G90");
  w.raw("M4 S0");
  for (const r of design.rasters) emitRaster(w, r, machine);
  const byPiece = options.passOrder === "piece";
  for (const mode of MODE_ORDER) {
    const groups = design.vectors.filter((g) => g.mode === mode);
    if (byPiece && (mode === "cut" || mode === "line") && groups.length) emitByPiece(w, groups, machine);
    else for (const g of groups) emitVector(w, g, machine);
  }
  w.raw("M5");
  if (options.returnToOrigin ?? true) w.rapid([0, 0]);
  const gcode = w.out.join("\n") + "\n";
  return {
    gcode,
    lines: w.out.filter((l) => !l.startsWith(";")).length,
    bounds: w.bounds(),
    estimatedSeconds: w.seconds,
    burnMm: w.burnMm,
    travelMm: w.travelMm,
    maxS: w.maxS,
  };
}

/** Comprimento total a gravar de um grupo vetorial (para estimativas na interface). */
export function groupBurnLength(g: VectorGroup): number {
  if (g.mode === "fill" || g.mode === "detail") {
    return hatch(g.paths, g.settings.interval ?? DEFAULT_INTERVAL[g.mode]).reduce((a, [p, q]) => a + distance(p, q), 0) * g.settings.passes;
  }
  return g.paths.reduce((a, p) => a + pathLength(p.points), 0) * g.settings.passes;
}
