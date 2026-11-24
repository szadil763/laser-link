import type { Bounds, Point } from "./types.js";

export interface FillOptions {
  /** Área a preencher (a chapa, já sem a margem da borda). */
  area: Bounds;
  /** Espaço entre as peças, mm. */
  gap: number;
  /** Tenta também a peça girada 90° e fica com a que der mais cópias. */
  allowRotate: boolean;
  /** Áreas já ocupadas por outras peças (não recebem cópias). */
  obstacles?: readonly Bounds[];
  /** Quantidade máxima (contando a peça original). Sem valor = o máximo que couber. */
  max?: number;
}

export interface FillPlan {
  /** Peça girada 90° em todas as posições. */
  rotated: boolean;
  /** Canto de baixo à esquerda de cada posição, em ordem (linha por linha, de baixo para cima). */
  slots: Point[];
  cols: number;
  rows: number;
  /** Tamanho da peça na orientação escolhida, mm. */
  width: number;
  height: number;
}

const EPS = 1e-6;

function overlaps(a: Bounds, b: Bounds): boolean {
  return a.minX < b.maxX - EPS && a.maxX > b.minX + EPS && a.minY < b.maxY - EPS && a.maxY > b.minY + EPS;
}

function grid(w: number, h: number, o: FillOptions): { slots: Point[]; cols: number; rows: number } {
  const { area, gap } = o;
  const cols = Math.floor((area.maxX - area.minX + gap + EPS) / (w + gap));
  const rows = Math.floor((area.maxY - area.minY + gap + EPS) / (h + gap));
  const slots: Point[] = [];
  // obstáculos crescem meio espaço para cada lado: a cópia fica a `gap` da peça que já está lá
  const half = gap / 2;
  const blocked = (o.obstacles ?? []).map((b) => ({ minX: b.minX - half, minY: b.minY - half, maxX: b.maxX + half, maxY: b.maxY + half }));
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = area.minX + c * (w + gap);
      const y = area.minY + r * (h + gap);
      const box = { minX: x - half, minY: y - half, maxX: x + w + half, maxY: y + h + half };
      if (blocked.some((b) => overlaps(box, b))) continue;
      slots.push([x, y]);
    }
  }
  return { slots, cols: Math.max(0, cols), rows: Math.max(0, rows) };
}

/**
 * Posições para repetir uma peça de `width` × `height` mm na área, em grade, com `gap` entre elas.
 * Devolve null se a peça não cabe nenhuma vez.
 */
export function planFill(width: number, height: number, o: FillOptions): FillPlan | null {
  if (!(width > 0 && height > 0) || !(o.gap >= 0)) return null;
  const straight = { rotated: false, width, height, ...grid(width, height, o) };
  let best = straight;
  if (o.allowRotate && Math.abs(width - height) > EPS) {
    const turned = { rotated: true, width: height, height: width, ...grid(height, width, o) };
    if (turned.slots.length > straight.slots.length) best = turned;
  }
  if (!best.slots.length) return null;
  if (o.max !== undefined && o.max >= 1) best.slots = best.slots.slice(0, Math.floor(o.max));
  return best;
}
