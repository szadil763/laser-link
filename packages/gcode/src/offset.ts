import ClipperLib from "clipper-lib";
import { closeRing, nestingDepth, signedArea } from "./geometry.js";
import type { Path, Point } from "./types.js";

/** Clipper trabalha com inteiros: 1 unidade = 0,001 mm. */
const SCALE = 1000;

export type JoinStyle = "round" | "miter";

function toClipper(points: readonly Point[]): ClipperLib.IntPoint[] {
  const ring = points.length > 1 && points[0]![0] === points[points.length - 1]![0] && points[0]![1] === points[points.length - 1]![1] ? points.slice(0, -1) : points;
  return ring.map(([x, y]) => ({ X: Math.round(x * SCALE), Y: Math.round(y * SCALE) }));
}

function fromClipper(path: ClipperLib.IntPoint[]): Path {
  return { closed: true, points: closeRing(path.map((p) => [p.X / SCALE, p.Y / SCALE] as Point)) };
}

/**
 * Desloca um caminho fechado: `delta` > 0 cresce, < 0 encolhe (mm).
 * Um caminho aberto vira o contorno fechado ao redor dele (largura 2·|delta|).
 * Pode devolver vários caminhos (ou nenhum, se encolher até sumir).
 */
export function offsetPath(path: Path, delta: number, join: JoinStyle = "round"): Path[] {
  if (path.points.length < 2 || delta === 0) return [{ closed: path.closed, points: path.points.slice() }];
  const co = new ClipperLib.ClipperOffset(2, 0.01 * SCALE);
  let pts = path.points;
  // orientação anti-horária: delta positivo sempre cresce
  if (path.closed && signedArea(pts) < 0) pts = pts.slice().reverse();
  const jt = join === "round" ? ClipperLib.JoinType.jtRound : ClipperLib.JoinType.jtMiter;
  const et = path.closed ? ClipperLib.EndType.etClosedPolygon : ClipperLib.EndType.etOpenRound;
  co.AddPath(toClipper(pts), jt, et);
  const solution: ClipperLib.IntPoint[][] = [];
  co.Execute(solution, (path.closed ? delta : Math.abs(delta)) * SCALE);
  return solution.filter((p) => p.length >= 3).map(fromClipper);
}

/**
 * Compensação de kerf para corte: contornos externos (peças) crescem kerf/2,
 * furos encolhem kerf/2, ilhas dentro de furos crescem de novo… Assim a peça
 * sai na medida do desenho. Caminhos abertos não mudam.
 */
export function compensateKerf(paths: readonly Path[], kerf: number): Path[] {
  if (!(kerf > 0)) return paths.map((p) => ({ closed: p.closed, points: p.points.slice() }));
  const depth = nestingDepth(paths);
  const out: Path[] = [];
  paths.forEach((p, i) => {
    if (!p.closed) {
      out.push({ closed: false, points: p.points.slice() });
      return;
    }
    const sign = depth[i]! % 2 === 0 ? 1 : -1;
    out.push(...offsetPath(p, (sign * kerf) / 2, "miter"));
  });
  return out;
}
