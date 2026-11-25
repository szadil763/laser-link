import type { BedView } from "./bed-view.js";

/**
 * Camada desenhada uma vez e reaproveitada: trabalhos grandes têm centenas de milhares
 * de segmentos, e redesenhar todos a cada quadro (progresso, mouse) trava a página.
 * O canvas guardado só é refeito quando a vista muda (zoom, arrastar, tamanho, tema)
 * ou quando `extra` muda (outro trabalho).
 */
export class LayerCache {
  readonly canvas = document.createElement("canvas");
  private key = "";

  /** Ajusta à vista. Devolve true se a camada foi limpa e precisa ser desenhada de novo. */
  ensure(v: BedView, extra: string): boolean {
    const c = v.canvas;
    const key = `${c.width}x${c.height}|${v.ox}|${v.oy}|${v.s}|${document.documentElement.dataset.bed ?? ""}|${extra}`;
    if (key === this.key) return false;
    this.key = key;
    this.canvas.width = c.width;
    this.canvas.height = c.height;
    return true;
  }

  invalidate(): void {
    this.key = "";
  }

  get ctx(): CanvasRenderingContext2D {
    return this.canvas.getContext("2d")!;
  }
}

/** Deslocamentos menores que isto (as ligações curtas do preenchimento) não aparecem: são milhões e só poluem. */
export const MIN_TRAVEL_MM = 1;

/**
 * Traça segmentos de `data` (x0, y0, x1, y1, laser por segmento, `stride` números cada),
 * do índice `from` até `to` (exclusivo), só os que passam em `pick`.
 */
export function strokeSegments(
  ctx: CanvasRenderingContext2D,
  v: BedView,
  data: Float32Array,
  stride: number,
  from: number,
  to: number,
  pick: (burn: boolean, k: number) => boolean,
): void {
  // traços em blocos: um caminho com um milhão de pedaços é muito mais lento de pintar que mil de mil
  let inPath = 0;
  ctx.beginPath();
  for (let i = from; i < to; i++) {
    const k = i * stride;
    const burn = stride > 4 ? data[k + 4] === 1 : false;
    if (!pick(burn, k)) continue;
    ctx.moveTo(v.X(data[k]!), v.Y(data[k + 1]!));
    ctx.lineTo(v.X(data[k + 2]!), v.Y(data[k + 3]!));
    if (++inPath >= CHUNK) {
      ctx.stroke();
      ctx.beginPath();
      inPath = 0;
    }
  }
  if (inPath) ctx.stroke();
}

const CHUNK = 2000;

/** Comprimento do segmento k (mm). */
export function segLength(data: Float32Array, k: number): number {
  return Math.hypot(data[k + 2]! - data[k]!, data[k + 3]! - data[k + 1]!);
}
