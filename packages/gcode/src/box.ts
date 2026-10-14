import { textToPaths, textWidth } from "./text.js";
import type { JobDesign, OpSettings, Path, Point } from "./types.js";

/**
 * Caixa com encaixes de dentes (finger joints), gerada do zero.
 *
 * Regras de montagem:
 * - Frente e trás ficam com os cantos (os cubos t×t×t de cada quina).
 * - Laterais encaixam entre frente e trás.
 * - Base (e tampa) encaixam por dentro, presas pelas quatro paredes.
 * Cada borda tem um número ímpar de dentes; bordas que se encostam têm o mesmo
 * número de segmentos com padrão invertido, então sempre fecham.
 */
export interface BoxOptions {
  /** mm */
  width: number;
  depth: number;
  height: number;
  /** As medidas acima são internas (espaço útil) ou externas. */
  measure: "inside" | "outside";
  /** Espessura do material, mm. */
  thickness: number;
  /** Largura desejada de cada dente, mm (ajustada para caber um número ímpar). */
  finger: number;
  /** Com tampa (6 peças) ou aberta em cima (5 peças). */
  lid: boolean;
  /** Grava o nome de cada peça (ajuda a montar). */
  labels: boolean;
  /** Canto inferior esquerdo da primeira peça na mesa, mm. */
  x: number;
  y: number;
  /** Espaço entre peças na mesa, mm. */
  gap: number;
  /** Largura útil da mesa, para quebrar a fileira de peças. */
  maxRowWidth: number;
  cut: OpSettings;
  label: OpSettings;
}

export const DEFAULT_BOX: BoxOptions = {
  width: 100,
  depth: 80,
  height: 60,
  measure: "outside",
  thickness: 3,
  finger: 10,
  lid: true,
  labels: true,
  x: 10,
  y: 10,
  gap: 5,
  maxRowWidth: 380,
  cut: { speed: 300, power: 85, passes: 2, kerf: 0.15 },
  label: { speed: 1500, power: 20, passes: 1 },
};

/** Segmento de borda: comprimento e se fica para fora (dente) ou recuado `t` (vão). */
type Seg = [length: number, out: boolean];

/** Número ímpar de segmentos (mínimo 3) com largura próxima de `finger`. */
function oddCount(length: number, finger: number): number {
  const n = Math.round(length / finger);
  if (n % 2 === 1) return Math.max(3, n);
  // par: fica com o ímpar vizinho cujo dente fica mais perto do pedido
  const below = Math.max(3, n - 1);
  const above = n + 1;
  return Math.abs(length / below - finger) <= Math.abs(length / above - finger) ? below : above;
}

/** Dentes alternados ao longo de `length`; `startOut` = começa e termina com dente. */
function fingers(length: number, finger: number, startOut: boolean): Seg[] {
  const n = oddCount(length, finger);
  const seg = length / n;
  return Array.from({ length: n }, (_, i): Seg => [seg, i % 2 === 0 ? startOut : !startOut]);
}

/** Borda com as pontas (t) recuadas e dentes no meio. */
function insetFingers(length: number, t: number, finger: number, startOut: boolean): Seg[] {
  return [[t, false], ...fingers(length - 2 * t, finger, startOut), [t, false]];
}

const plain = (length: number): Seg[] => [[length, true]];

/**
 * Contorno de uma peça w × h a partir das 4 bordas (base, direita, topo,
 * esquerda, sentido anti-horário). Vãos recuam `t` para dentro.
 */
export function panelOutline(w: number, h: number, t: number, edges: [Seg[], Seg[], Seg[], Seg[]]): Point[] {
  const lengths = [w, h, w, h];
  // converte (s ao longo da borda, d para dentro) em coordenadas da peça
  const map = (k: number, s: number, d: number): Point => {
    if (k === 0) return [s, d];
    if (k === 1) return [w - d, s];
    if (k === 2) return [w - s, h - d];
    return [d, h - s];
  };
  const depth = (seg: Seg): number => (seg[1] ? 0 : t);
  const pts: Point[] = [];
  for (let k = 0; k < 4; k++) {
    const segs = edges[k]!;
    const prev = edges[(k + 3) % 4]!;
    const next = edges[(k + 1) % 4]!;
    const startS = depth(prev[prev.length - 1]!);
    const endS = lengths[k]! - depth(next[0]!);
    let s = 0;
    pts.push(map(k, startS, depth(segs[0]!)));
    for (let i = 0; i < segs.length - 1; i++) {
      s += segs[i]![0];
      const a = depth(segs[i]!);
      const b = depth(segs[i + 1]!);
      if (a !== b) {
        pts.push(map(k, s, a));
        pts.push(map(k, s, b));
      }
    }
    pts.push(map(k, endS, depth(segs[segs.length - 1]!)));
  }
  // remove pontos repetidos e fecha
  const out: Point[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (!last || Math.abs(last[0] - p[0]) > 1e-9 || Math.abs(last[1] - p[1]) > 1e-9) out.push(p);
  }
  out.push(out[0]!);
  return out;
}

export interface BoxPanel {
  name: string;
  width: number;
  height: number;
  outline: Point[];
}

/** As peças da caixa, cada uma com o canto inferior esquerdo em (0, 0). */
export function boxPanels(o: BoxOptions): BoxPanel[] {
  const t = o.thickness;
  if (!(t > 0)) throw new Error("A espessura precisa ser maior que zero.");
  if (!(o.finger >= t)) throw new Error("A largura do dente precisa ser pelo menos igual à espessura do material.");
  const X = o.measure === "inside" ? o.width + 2 * t : o.width;
  const Y = o.measure === "inside" ? o.depth + 2 * t : o.depth;
  const Z = o.measure === "inside" ? o.height + (o.lid ? 2 : 1) * t : o.height;
  const min = 3 * t + 3 * o.finger;
  if (X < min || Y < min || Z < min) {
    throw new Error(`Caixa pequena demais para dentes de ${o.finger} mm em material de ${t} mm: use no mínimo ${min.toFixed(0)} mm em cada medida externa.`);
  }
  const f = o.finger;
  // frente/trás (X × Z): donas dos cantos
  const frontEdges: [Seg[], Seg[], Seg[], Seg[]] = [
    fingers(X, f, true),
    fingers(Z, f, true),
    o.lid ? fingers(X, f, true) : plain(X),
    fingers(Z, f, true),
  ];
  // laterais (Y × Z): encaixam entre frente e trás
  const sideEdges: [Seg[], Seg[], Seg[], Seg[]] = [
    insetFingers(Y, t, f, true),
    fingers(Z, f, false),
    o.lid ? insetFingers(Y, t, f, true) : plain(Y),
    fingers(Z, f, false),
  ];
  // base e tampa (X × Y): por dentro das quatro paredes
  const baseEdges: [Seg[], Seg[], Seg[], Seg[]] = [
    fingers(X, f, false),
    insetFingers(Y, t, f, false),
    fingers(X, f, false),
    insetFingers(Y, t, f, false),
  ];
  const panels: BoxPanel[] = [
    { name: "Frente", width: X, height: Z, outline: panelOutline(X, Z, t, frontEdges) },
    { name: "Trás", width: X, height: Z, outline: panelOutline(X, Z, t, frontEdges) },
    { name: "Lado esquerdo", width: Y, height: Z, outline: panelOutline(Y, Z, t, sideEdges) },
    { name: "Lado direito", width: Y, height: Z, outline: panelOutline(Y, Z, t, sideEdges) },
    { name: "Base", width: X, height: Y, outline: panelOutline(X, Y, t, baseEdges) },
  ];
  if (o.lid) panels.push({ name: "Tampa", width: X, height: Y, outline: panelOutline(X, Y, t, baseEdges) });
  return panels;
}

/** Posições das peças na mesa em fileiras (da esquerda para a direita, de baixo para cima). */
export function layoutPanels(sizes: ReadonlyArray<{ width: number; height: number }>, x0: number, y0: number, gap: number, maxRowWidth: number): Point[] {
  const out: Point[] = [];
  let x = x0;
  let y = y0;
  let rowH = 0;
  for (const s of sizes) {
    if (x > x0 && x + s.width > x0 + maxRowWidth) {
      x = x0;
      y += rowH + gap;
      rowH = 0;
    }
    out.push([x, y]);
    x += s.width + gap;
    rowH = Math.max(rowH, s.height);
  }
  return out;
}

/** Caixa pronta para o gerador: corte das peças e, se pedido, nomes gravados. */
export function boxDesign(o: BoxOptions = DEFAULT_BOX): JobDesign & { panels: Array<BoxPanel & { at: Point }> } {
  const panels = boxPanels(o);
  const pos = layoutPanels(panels, o.x, o.y, o.gap, o.maxRowWidth);
  const placed = panels.map((p, i) => ({ ...p, at: pos[i]! }));
  const cut: Path[] = placed.map((p) => ({ closed: true, points: p.outline.map(([x, y]) => [x + p.at[0], y + p.at[1]] as Point) }));
  const vectors: JobDesign["vectors"] = [{ name: "Peças da caixa", mode: "cut", settings: o.cut, paths: cut }];
  if (o.labels) {
    const labels: Path[] = [];
    for (const p of placed) {
      // letra entre 2,5 e 6 mm, reduzida até o nome caber longe dos dentes
      const usable = p.width - 4 * o.thickness - 2 * o.finger;
      const h = Math.min(6, p.height * 0.12, usable / textWidth(p.name, 1));
      if (h >= 2.5) {
        labels.push(...textToPaths(p.name, { height: h, x: p.at[0] + p.width / 2, y: p.at[1] + p.height / 2 - h / 2, align: "center" }));
      }
    }
    if (labels.length) vectors.push({ name: "Nomes das peças", mode: "line", settings: o.label, paths: labels });
  }
  const kind = o.lid ? "com tampa" : "aberta";
  const dims = `${o.width}×${o.depth}×${o.height} mm ${o.measure === "inside" ? "internos" : "externos"}`;
  return { name: `Caixa ${kind} ${dims}`, rasters: [], vectors, panels: placed };
}
