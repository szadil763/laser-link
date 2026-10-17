import { boundsOf, dither, rgbaToGray, runsOfRow, type Bounds, type JobDesign, type OpSettings, type Point, type VectorGroup, type VectorMode } from "@laserlink/gcode";
import type { Material, MaterialMode } from "@laserlink/shared";

export const MODES: readonly VectorMode[] = ["cut", "line", "fill", "detail"];

export const MODE_INFO: Record<VectorMode | "raster", { label: string; hint: string; color: string }> = {
  cut: { label: "Cortar", hint: "atravessa o material", color: "#ff5c5c" },
  line: { label: "Gravar linha", hint: "marca o contorno", color: "#4da3ff" },
  fill: { label: "Gravar preenchido", hint: "hachura dentro da forma", color: "#e0a458" },
  detail: { label: "Detalhado", hint: "preenchimento fino, mais lento", color: "#c58af9" },
  raster: { label: "Gravar imagem", hint: "", color: "#c9b28a" },
};

export interface Shape {
  id: string;
  name: string;
  points: Point[];
  closed: boolean;
  /** Operação própria do elemento; null = a da camada. */
  mode: VectorMode | null;
  /** Elementos do mesmo grupo (ex.: letras de um texto) são selecionados juntos. */
  group?: string;
  /** Letra de um texto editável (dois cliques na mesa). */
  text?: ShapeText;
  /** Travado: continua na mesa e no trabalho, mas não se move, não gira e não é excluído. */
  locked?: boolean;
}

/** O que está escrito num texto, para editar com dois cliques. Todas as letras do texto têm o mesmo `id`. */
export interface ShapeText {
  id: string;
  value: string;
  height: number;
  align: "left" | "center" | "right";
  /** Altura do texto na mesa quando foi escrito (para saber se ele foi esticado depois). */
  h0: number;
}

export interface Layer {
  id: string;
  name: string;
  color: string;
  mode: VectorMode;
  enabled: boolean;
  materialId: string | null;
  settings: Record<VectorMode, OpSettings>;
  shapes: Shape[];
}

export type DitherChoice = "floyd-steinberg" | "threshold";

export interface ImageItem {
  name: string;
  /** Imagem original desenhável (decodificada pelo navegador). */
  source: CanvasImageSource;
  sourceWidth: number;
  sourceHeight: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** linhas por mm */
  res: number;
  threshold: number;
  dither: DitherChoice;
  overscan: number;
  bidirectional: boolean;
  settings: OpSettings;
  enabled: boolean;
  materialId: string | null;
  // calculado
  bitmap: Uint8Array;
  bw: number;
  bh: number;
  preview: HTMLCanvasElement;
}

const FALLBACK: Record<MaterialMode, OpSettings> = {
  cut: { speed: 300, power: 85, passes: 2, kerf: 0.15 },
  line: { speed: 1500, power: 25, passes: 1 },
  fill: { speed: 3000, power: 35, passes: 1, interval: 0.2 },
  detail: { speed: 1800, power: 30, passes: 1, interval: 0.08 },
  raster: { speed: 3000, power: 40, passes: 1 },
};

/** Configuração de um material para uma operação (ou um padrão razoável). */
export function presetFor(material: Material | undefined, mode: MaterialMode): OpSettings {
  const p = material?.presets.find((x) => x.mode === mode);
  const base = { ...FALLBACK[mode] };
  if (!p) return base;
  const s: OpSettings = { speed: p.speed, power: p.power, passes: p.passes };
  if (mode === "cut") s.kerf = p.kerf ?? base.kerf ?? 0;
  if (mode === "fill" || mode === "detail") s.interval = p.interval ?? base.interval;
  return s;
}

let uid = 0;
export const newId = (prefix: string): string => `${prefix}${++uid}`;

export function makeLayer(name: string, color: string, mode: VectorMode, material?: Material): Layer {
  const settings = {} as Record<VectorMode, OpSettings>;
  for (const m of MODES) settings[m] = presetFor(material, m);
  return { id: newId("L"), name, color, mode, enabled: true, materialId: material?.id ?? null, settings, shapes: [] };
}

export function makeShape(points: Point[], name: string, closedHint = false, mode: VectorMode | null = null): Shape {
  const first = points[0];
  const last = points[points.length - 1];
  const touching = !!first && !!last && Math.hypot(first[0] - last[0], first[1] - last[1]) < 0.05;
  const closed = closedHint || (points.length > 2 && touching);
  const pts = points.slice();
  if (closed && first && last && !(first[0] === last[0] && first[1] === last[1])) pts.push(first);
  return { id: newId("S"), name, points: pts, closed, mode };
}

/** Operação efetiva: a do elemento ou a da camada. Caminho aberto não pode ser preenchido. */
export function effectiveMode(s: Shape, l: Layer): VectorMode {
  const m = s.mode ?? l.mode;
  return !s.closed && (m === "fill" || m === "detail") ? "line" : m;
}

/** Recalcula os pontos da imagem (resolução, limiar, pontilhado). */
export function rebuildImage(img: ImageItem): void {
  const bw = Math.max(2, Math.min(2000, Math.round(img.w * img.res)));
  const bh = Math.max(2, Math.min(2000, Math.round(img.h * img.res)));
  const c = document.createElement("canvas");
  c.width = bw;
  c.height = bh;
  const g = c.getContext("2d");
  if (!g) throw new Error("Canvas 2D indisponível.");
  g.fillStyle = "#fff";
  g.fillRect(0, 0, bw, bh);
  g.imageSmoothingQuality = "high";
  g.drawImage(img.source, 0, 0, bw, bh);
  const gray = rgbaToGray(g.getImageData(0, 0, bw, bh).data, bw, bh);
  img.bitmap = dither(gray, bw, bh, img.dither, img.threshold);
  img.bw = bw;
  img.bh = bh;
  const out = g.createImageData(bw, bh);
  for (let i = 0; i < bw * bh; i++) {
    if (img.bitmap[i]) {
      out.data[i * 4] = 241;
      out.data[i * 4 + 1] = 227;
      out.data[i * 4 + 2] = 200;
      out.data[i * 4 + 3] = 255;
    }
  }
  g.putImageData(out, 0, 0);
  img.preview = c;
}

/** Retângulo do que vai ser gravado (inclui o overscan da imagem). */
export function designBounds(layers: readonly Layer[], image: ImageItem | null): Bounds | null {
  const pts: Point[] = [];
  for (const l of layers) if (l.enabled) for (const s of l.shapes) pts.push(...s.points);
  if (image?.enabled) {
    let minRow = Infinity;
    let maxRow = -Infinity;
    for (let r = 0; r < image.bh; r++) {
      if (runsOfRow(image.bitmap, image.bw, r).length) {
        minRow = Math.min(minRow, r);
        maxRow = Math.max(maxRow, r);
      }
    }
    if (minRow <= maxRow) {
      pts.push([image.x - image.overscan, image.y], [image.x + image.w + image.overscan, image.y + image.h]);
    }
  }
  return boundsOf(pts);
}

/** Converte o projeto da tela no formato do gerador de G-code. */
export function toJobDesign(name: string, layers: readonly Layer[], image: ImageItem | null): JobDesign {
  const vectors: VectorGroup[] = [];
  for (const l of layers) {
    if (!l.enabled) continue;
    for (const mode of MODES) {
      const shapes = l.shapes.filter((s) => effectiveMode(s, l) === mode);
      if (!shapes.length) continue;
      vectors.push({
        name: `${l.name}`,
        mode,
        settings: { ...l.settings[mode] },
        paths: shapes.map((s) => ({ points: s.points, closed: s.closed })),
      });
    }
  }
  const rasters = image?.enabled
    ? [
        {
          name: image.name,
          bitmap: image.bitmap,
          width: image.bw,
          height: image.bh,
          x: image.x,
          y: image.y,
          widthMm: image.w,
          heightMm: image.h,
          settings: { ...image.settings },
          overscan: image.overscan,
          bidirectional: image.bidirectional,
        },
      ]
    : [];
  return { name, rasters, vectors };
}

// ---------- desfazer ----------

export class History {
  private stack: string[] = [];

  push(layers: readonly Layer[]): void {
    this.stack.push(JSON.stringify(layers.map((l) => ({ id: l.id, shapes: l.shapes }))));
    if (this.stack.length > 60) this.stack.shift();
  }

  get canUndo(): boolean {
    return this.stack.length > 0;
  }

  clear(): void {
    this.stack = [];
  }

  /** Restaura os elementos de cada camada; devolve false se não havia nada. */
  undo(layers: Layer[]): boolean {
    const last = this.stack.pop();
    if (!last) return false;
    const saved = JSON.parse(last) as Array<{ id: string; shapes: Shape[] }>;
    for (const l of layers) {
      const sv = saved.find((x) => x.id === l.id);
      if (sv) l.shapes = sv.shapes;
    }
    return true;
  }
}
