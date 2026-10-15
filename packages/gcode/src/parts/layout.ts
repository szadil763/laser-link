import { layoutPanels } from "../box.js";
import type { JobDesign, OpSettings, Path, Point } from "../types.js";
import { pieceSize, type Piece } from "./shapes.js";

export interface LayoutOptions {
  x: number;
  y: number;
  gap: number;
  maxRowWidth: number;
  cut: OpSettings;
  engrave: OpSettings;
}

export interface PlacedPiece {
  name: string;
  at: Point;
  width: number;
  height: number;
}

/** Distribui as peças (com as cópias) na mesa e monta o projeto: furos e contornos no corte, gravações em linha. */
export function layoutPieces(
  name: string,
  pieces: readonly Piece[],
  o: LayoutOptions,
): JobDesign & { placed: PlacedPiece[]; cutOwners: string[]; engraveOwners: string[] } {
  const expanded: Piece[] = pieces.flatMap((p) => Array.from({ length: p.count }, (_, i) => ({ ...p, name: p.count > 1 ? `${p.name} ${i + 1}` : p.name })));
  const sizes = expanded.map(pieceSize);
  const pos = layoutPanels(sizes, o.x, o.y, o.gap, o.maxRowWidth);
  const cut: Path[] = [];
  const engrave: Path[] = [];
  const placed: PlacedPiece[] = [];
  // a que peça pertence cada caminho (para a interface agrupar contorno, furos e gravações)
  const cutOwners: string[] = [];
  const engraveOwners: string[] = [];
  expanded.forEach((p, i) => {
    const s = sizes[i]!;
    const at = pos[i]!;
    const dx = at[0] - s.minX;
    const dy = at[1] - s.minY;
    const move = (path: Path): Path => {
      const moved: Path = { closed: path.closed, points: path.points.map(([x, y]) => [x + dx, y + dy] as Point) };
      // cada cópia da peça tem o seu próprio texto
      if (path.text) moved.text = { ...path.text, id: `${i}:${path.text.id}` };
      return moved;
    };
    cut.push(...p.holes.map(move), { closed: true, points: p.outline.map(([x, y]) => [x + dx, y + dy] as Point) });
    engrave.push(...p.engrave.map(move));
    for (let k = 0; k <= p.holes.length; k++) cutOwners.push(p.name);
    for (let k = 0; k < p.engrave.length; k++) engraveOwners.push(p.name);
    placed.push({ name: p.name, at, width: s.width, height: s.height });
  });
  const vectors: JobDesign["vectors"] = [{ name: "Peças", mode: "cut", settings: o.cut, paths: cut }];
  if (engrave.length) vectors.push({ name: "Gravações", mode: "line", settings: o.engrave, paths: engrave });
  return { name, rasters: [], vectors, placed, cutOwners, engraveOwners };
}
