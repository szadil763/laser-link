import type { Path, Point, TextTag } from "./types.js";

/**
 * Fonte própria de traço único (ideal para gravar em linha): grade 4 × 6,
 * linha de base em y = 0. Cada glifo é uma lista de traços "x,y x,y …"
 * separados por ";".
 */
const GLYPHS: Record<string, string> = {
  "0": "1,0 0,1 0,5 1,6 3,6 4,5 4,1 3,0 1,0;0.5,1 3.5,5",
  "1": "1,5 2,6 2,0;1,0 3,0",
  "2": "0,5 1,6 3,6 4,5 4,4 0,0 4,0",
  "3": "0,5 1,6 3,6 4,5 4,4 3,3 1.5,3;3,3 4,2 4,1 3,0 1,0 0,1",
  "4": "3,0 3,6 0,2 4,2",
  "5": "4,6 0,6 0,3.5 3,3.5 4,2.5 4,1 3,0 1,0 0,1",
  "6": "4,5 3,6 1,6 0,5 0,1 1,0 3,0 4,1 4,2 3,3 0,3",
  "7": "0,6 4,6 1.5,0",
  "8": "1,3 0,4 0,5 1,6 3,6 4,5 4,4 3,3 1,3 0,2 0,1 1,0 3,0 4,1 4,2 3,3",
  "9": "0,1 1,0 3,0 4,1 4,5 3,6 1,6 0,5 0,4 1,3 4,3",
  A: "0,0 0,4 2,6 4,4 4,0;0,2.5 4,2.5",
  B: "0,0 0,6 3,6 4,5 4,4 3,3 0,3;3,3 4,2 4,1 3,0 0,0",
  C: "4,5 3,6 1,6 0,5 0,1 1,0 3,0 4,1",
  D: "0,0 0,6 2,6 4,4 4,2 2,0 0,0",
  E: "4,6 0,6 0,0 4,0;0,3 3,3",
  F: "4,6 0,6 0,0;0,3 3,3",
  G: "4,5 3,6 1,6 0,5 0,1 1,0 3,0 4,1 4,3 2,3",
  H: "0,0 0,6;4,0 4,6;0,3 4,3",
  I: "1,6 3,6;2,6 2,0;1,0 3,0",
  J: "4,6 4,1 3,0 1,0 0,1",
  K: "0,0 0,6;4,6 0,2;1.2,3.2 4,0",
  L: "0,6 0,0 4,0",
  M: "0,0 0,6 2,3 4,6 4,0",
  N: "0,0 0,6 4,0 4,6",
  O: "1,0 0,1 0,5 1,6 3,6 4,5 4,1 3,0 1,0",
  P: "0,0 0,6 3,6 4,5 4,4 3,3 0,3",
  Q: "1,0 0,1 0,5 1,6 3,6 4,5 4,1 3,0 1,0;2.5,1.5 4,0",
  R: "0,0 0,6 3,6 4,5 4,4 3,3 0,3;2,3 4,0",
  S: "4,5 3,6 1,6 0,5 0,4 1,3 3,3 4,2 4,1 3,0 1,0 0,1",
  T: "0,6 4,6;2,6 2,0",
  U: "0,6 0,1 1,0 3,0 4,1 4,6",
  V: "0,6 2,0 4,6",
  W: "0,6 1,0 2,3 3,0 4,6",
  X: "0,0 4,6;0,6 4,0",
  Y: "0,6 2,3 4,6;2,3 2,0",
  Z: "0,6 4,6 0,0 4,0",
  ".": "1.7,0 2.3,0 2.3,0.6 1.7,0.6 1.7,0",
  ",": "2,0.6 2,0 1.4,-1",
  ":": "1.7,0 2.3,0 2.3,0.6 1.7,0.6 1.7,0;1.7,3.6 2.3,3.6 2.3,4.2 1.7,4.2 1.7,3.6",
  "-": "1,3 3,3",
  "+": "0.5,3 3.5,3;2,1.5 2,4.5",
  "=": "0.5,2 3.5,2;0.5,4 3.5,4",
  "/": "0,0 4,6",
  "%": "0,6 0,5 1,5 1,6 0,6;3,1 3,0 4,0 4,1 3,1;0,0 4,6",
  "(": "3,6 2,5 2,1 3,0",
  ")": "1,6 2,5 2,1 1,0",
  "×": "0.8,1.8 3.2,4.2;0.8,4.2 3.2,1.8",
  "?": "0,5 1,6 3,6 4,5 4,4 2,3 2,2;2,0.6 2,0",
  "!": "2,6 2,2;2,0.6 2,0",
  "'": "2,6 2,4.5",
  "#": "1,0 1,6;3,0 3,6;0,2 4,2;0,4 4,4",
};

const ADVANCE = 6; // largura do glifo (4) + espaço (2), em unidades da grade
const LINE_GAP = 4; // entre linhas de texto, além da altura (6)

function parseGlyph(spec: string): Point[][] {
  return spec.split(";").map((stroke) =>
    stroke
      .trim()
      .split(/\s+/)
      .map((pair) => {
        const [x, y] = pair.split(",").map(Number);
        return [x!, y!] as Point;
      }),
  );
}

const CACHE = new Map<string, Point[][]>();
function glyph(ch: string): Point[][] | null {
  if (ch === " ") return [];
  const spec = GLYPHS[ch];
  if (!spec) return null;
  let g = CACHE.get(ch);
  if (!g) {
    g = parseGlyph(spec);
    CACHE.set(ch, g);
  }
  return g;
}

/** Tira acentos (ç → C, ã → A) e passa para maiúsculas: a fonte só tem maiúsculas. */
export function normalizeText(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase();
}

export interface TextOptions {
  /** Altura das letras maiúsculas, mm. */
  height: number;
  /** Canto inferior esquerdo da primeira linha, mm. */
  x: number;
  y: number;
  align?: "left" | "center" | "right";
  /** Marca as letras com o texto (Path.text), para ele poder ser editado depois. */
  tag?: string;
}

/** Largura do texto em mm (linha mais longa). */
export function textWidth(text: string, height: number): number {
  const unit = height / 6;
  const longest = Math.max(0, ...normalizeText(text).split("\n").map((l) => l.length));
  return longest > 0 ? (longest * ADVANCE - 2) * unit : 0;
}

/** Converte texto em caminhos abertos de traço único. Caracteres sem glifo viram "?". */
export function textToPaths(text: string, options: TextOptions): Path[] {
  const unit = options.height / 6;
  const out: Path[] = [];
  normalizeText(text)
    .split("\n")
    .forEach((line, li) => {
      const width = line.length > 0 ? (line.length * ADVANCE - 2) * unit : 0;
      const shift = options.align === "center" ? -width / 2 : options.align === "right" ? -width : 0;
      const baseY = options.y - li * (6 + LINE_GAP) * unit;
      [...line].forEach((ch, i) => {
        const strokes = glyph(ch) ?? glyph("?")!;
        const ox = options.x + shift + i * ADVANCE * unit;
        for (const stroke of strokes) {
          const points = stroke.map(([gx, gy]) => [ox + gx * unit, baseY + gy * unit] as Point);
          const first = points[0]!;
          const last = points[points.length - 1]!;
          out.push({ points, closed: points.length > 2 && first[0] === last[0] && first[1] === last[1] });
        }
      });
    });
  if (options.tag) {
    const tag: TextTag = { id: options.tag, value: text, height: options.height, align: options.align ?? "left" };
    for (const p of out) p.text = tag;
  }
  return out;
}
