import { boundsOfPaths } from "./geometry.js";
import { solidOutline, unionPaths } from "./offset.js";
import { circle } from "./parts/shapes.js";
import type { Path, Point } from "./types.js";

/**
 * Painéis escolares: letras com base (contorno), bandeirolas e lápis decorativo.
 * O desenho das letras vem de fora (`Shaper`), assim este módulo não depende de fonte nenhuma.
 */

/** Contornos fechados de uma linha de texto: linha de base em y = 0, começando em x = 0. */
export type Shaper = (text: string, height: number) => Path[];

/** Peça do painel em coordenadas locais. `fill` = gravar preenchido, `engrave` = gravar linha. */
export interface PanelPart {
  name: string;
  cut: Path[];
  engrave: Path[];
  fill: Path[];
}

export interface PhraseOptions {
  /** Uma linha por item. */
  lines: string[];
  /** Altura das letras maiúsculas, mm. */
  height: number;
  /** Largura do contorno da base, mm. 0 = só as letras, sem base. */
  border: number;
  /** A base sai uma por letra, uma por palavra ou uma por linha. */
  baseBy: "letter" | "word" | "line";
  /** Grava na base o lugar de cada letra (para colar certo). */
  guide: boolean;
}

export type BuntingShape = "pencil" | "triangle" | "swallowtail" | "rect";

export interface BuntingOptions {
  /** Cada caractere vira uma bandeirola; espaço vira bandeirola sem letra. */
  text: string;
  shape: BuntingShape;
  width: number;
  height: number;
  /** Diâmetro dos 2 furos do barbante. 0 = sem furos. */
  holeD: number;
  /** Letra recortada (peça para colar), gravada (preenchida) ou vazada (furo na bandeirola). */
  letter: "cut" | "engrave" | "hollow";
  /** Tamanho da letra em relação ao espaço livre (0,3 a 1). */
  letterScale: number;
}

export interface PencilOptions {
  length: number;
  width: number;
  /** Peças separadas por cor (borracha, ponteira, corpo, madeira, grafite) ou uma peça só com as divisas gravadas. */
  split: boolean;
  /** Texto gravado no corpo (opcional). */
  label: string;
}

const translate = (paths: readonly Path[], dx: number, dy: number): Path[] =>
  paths.map((p) => ({ closed: p.closed, points: p.points.map(([x, y]) => [x + dx, y + dy] as Point) }));

const line = (a: Point, b: Point): Path => ({ closed: false, points: [a, b] });

const poly = (points: Point[]): Path => ({ closed: true, points: [...points, points[0]!] });

function shortName(text: string): string {
  const t = text.trim();
  return t.length > 18 ? `${t.slice(0, 18)}…` : t;
}

// ---------- frase com contorno ----------

export function phraseParts(o: PhraseOptions, shape: Shaper): PanelPart[] {
  if (!(o.height > 0)) throw new Error("A altura das letras precisa ser maior que zero.");
  if (o.border < 0) throw new Error("O contorno não pode ser negativo.");
  const parts: PanelPart[] = [];
  const units: string[] = [];
  for (const raw of o.lines) {
    const l = raw.trim();
    if (!l) continue;
    if (o.baseBy === "word") units.push(...l.split(/\s+/));
    else units.push(l);
  }
  if (!units.length) throw new Error("Escreva a frase.");
  // a base junta as letras da palavra (ou da linha); "por letra" deixa cada letra com a sua
  const bridge = o.baseBy === "letter" ? 0 : o.baseBy === "word" ? o.height * 0.3 : o.height * 0.6;
  for (const u of units) {
    const letters = unionPaths(shape(u, o.height));
    if (!letters.length) continue;
    const name = shortName(u);
    parts.push({ name: `Letras “${name}”`, cut: letters, engrave: [], fill: [] });
    if (o.border > 0) {
      const base = solidOutline(letters, o.border, bridge);
      parts.push({ name: `Base “${name}”`, cut: base, engrave: o.guide ? letters.map((p) => ({ ...p, points: p.points.slice() })) : [], fill: [] });
    }
  }
  if (!parts.length) throw new Error("Nenhuma letra dessa frase existe na fonte escolhida.");
  return parts;
}

// ---------- bandeirolas ----------

interface FlagGeometry {
  outline: Path;
  engrave: Path[];
  /** Espaço livre para a letra. */
  y0: number;
  y1: number;
  maxW: number;
}

function flagGeometry(shape: BuntingShape, w: number, h: number, holeZone: number): FlagGeometry {
  switch (shape) {
    case "rect":
      return { outline: poly([[0, 0], [w, 0], [w, h], [0, h]]), engrave: [], y0: h * 0.08, y1: h - holeZone, maxW: w * 0.84 };
    case "swallowtail":
      return { outline: poly([[0, 0], [w / 2, h * 0.22], [w, 0], [w, h], [0, h]]), engrave: [], y0: h * 0.26, y1: h - holeZone, maxW: w * 0.84 };
    case "triangle":
      return { outline: poly([[w / 2, 0], [w, h], [0, h]]), engrave: [], y0: h * 0.4, y1: h - holeZone, maxW: w * 0.5 };
    case "pencil": {
      // lápis de ponta para baixo: borracha em cima, ponteira, corpo, madeira e grafite
      const tip = Math.min(h * 0.3, w * 0.9);
      const eraser = Math.max(holeZone, h * 0.12);
      const ferruleTop = h - eraser;
      const ferruleBottom = ferruleTop - h * 0.08;
      const lead = tip * 0.36;
      const leadHalf = (w / 2) * (lead / tip);
      return {
        outline: poly([[w / 2, 0], [w, tip], [w, h], [0, h], [0, tip]]),
        engrave: [
          line([0, ferruleTop], [w, ferruleTop]),
          line([0, ferruleBottom], [w, ferruleBottom]),
          line([0, tip], [w, tip]),
          line([w / 2 - leadHalf, lead], [w / 2 + leadHalf, lead]),
        ],
        y0: tip + h * 0.04,
        y1: ferruleBottom - h * 0.03,
        maxW: w * 0.84,
      };
    }
  }
}

export function buntingParts(o: BuntingOptions, shape: Shaper): PanelPart[] {
  const chars = [...o.text.trim()];
  if (!chars.length) throw new Error("Escreva o texto das bandeirolas.");
  if (o.width < 20 || o.height < 30) throw new Error("A bandeirola precisa ter pelo menos 20 mm de largura e 30 mm de altura.");
  if (o.holeD < 0 || o.holeD > o.width / 4) throw new Error(`O furo precisa ter entre 0 e ${(o.width / 4).toFixed(0)} mm.`);
  const scale = Math.min(1, Math.max(0.3, o.letterScale));
  const holeZone = o.holeD > 0 ? o.holeD * 2.6 : o.height * 0.06;
  const parts: PanelPart[] = [];
  chars.forEach((ch, i) => {
    const g = flagGeometry(o.shape, o.width, o.height, holeZone);
    const cut: Path[] = [];
    if (o.holeD > 0) {
      const hy = o.height - o.holeD * 1.3;
      cut.push(circle(o.width * 0.2, hy, o.holeD), circle(o.width * 0.8, hy, o.holeD));
    }
    const engrave = [...g.engrave];
    const fill: Path[] = [];
    const n = i + 1;
    if (ch.trim()) {
      const room = Math.max(1, g.y1 - g.y0);
      let lh = room * scale * 0.82;
      let letter = unionPaths(shape(ch, lh));
      let b = boundsOfPaths(letter);
      if (b && b.maxX - b.minX > g.maxW) {
        lh *= g.maxW / (b.maxX - b.minX);
        letter = unionPaths(shape(ch, lh));
        b = boundsOfPaths(letter);
      }
      if (b) {
        const placed = translate(letter, o.width / 2 - (b.minX + b.maxX) / 2, (g.y0 + g.y1) / 2 - (b.minY + b.maxY) / 2);
        if (o.letter === "hollow") cut.push(...placed);
        else if (o.letter === "engrave") fill.push(...placed);
        else {
          // letra recortada: peça própria; na bandeirola fica gravado onde colar
          engrave.push(...placed);
          parts.push({ name: `Letra ${ch} (${n})`, cut: translate(letter, -b.minX, -b.minY), engrave: [], fill: [] });
        }
      }
    }
    cut.push(g.outline);
    parts.push({ name: `Bandeirola ${n}${ch.trim() ? ` “${ch}”` : ""}`, cut, engrave, fill });
  });
  return parts;
}

// ---------- lápis decorativo ----------

export function pencilParts(o: PencilOptions, shape?: Shaper): PanelPart[] {
  const L = o.length;
  const W = o.width;
  if (W < 15) throw new Error("O lápis precisa ter pelo menos 15 mm de largura.");
  const eraserL = W * 0.6;
  const ferruleL = W * 0.38;
  const coneL = W * 1.1;
  if (L < eraserL + ferruleL + coneL + W) throw new Error(`Para ${W} mm de largura, o lápis precisa ter pelo menos ${Math.ceil(eraserL + ferruleL + coneL + W)} mm de comprimento.`);
  const r = W * 0.22;
  const xF = eraserL;
  const xB = eraserL + ferruleL;
  const xC = L - coneL;
  const xG = L - coneL * 0.35;
  const gHalf = (W / 2) * ((L - xG) / coneL);
  // borracha com cantos arredondados à esquerda
  const arc = (cx: number, cy: number, a0: number, a1: number): Point[] => {
    const pts: Point[] = [];
    for (let i = 0; i <= 8; i++) {
      const a = a0 + ((a1 - a0) * i) / 8;
      pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
    return pts;
  };
  const eraserLeft: Point[] = [...arc(r, W - r, Math.PI / 2, Math.PI), ...arc(r, r, Math.PI, (3 * Math.PI) / 2)];
  const label: Path[] = [];
  if (o.label.trim() && shape) {
    let lh = W * 0.38;
    let t = unionPaths(shape(o.label.trim(), lh));
    let b = boundsOfPaths(t);
    const room = (xC - xB) * 0.86;
    if (b && b.maxX - b.minX > room) {
      lh *= room / (b.maxX - b.minX);
      t = unionPaths(shape(o.label.trim(), lh));
      b = boundsOfPaths(t);
    }
    if (b) label.push(...translate(t, (xB + xC) / 2 - (b.minX + b.maxX) / 2, W / 2 - (b.minY + b.maxY) / 2));
  }
  if (!o.split) {
    const outline = poly([[xC, 0], [L, W / 2], [xC, W], ...eraserLeft]);
    const engrave: Path[] = [
      line([xF, 0], [xF, W]),
      line([xB, 0], [xB, W]),
      line([xF + ferruleL / 3, 0], [xF + ferruleL / 3, W]),
      line([xF + (2 * ferruleL) / 3, 0], [xF + (2 * ferruleL) / 3, W]),
      line([xC, 0], [xC, W]),
      line([xG, W / 2 - gHalf], [xG, W / 2 + gHalf]),
    ];
    // faces do lápis sextavado (só quando não há texto no meio)
    if (!label.length) engrave.push(line([xB, W / 3], [xC, W / 3]), line([xB, (2 * W) / 3], [xC, (2 * W) / 3]));
    return [{ name: "Lápis", cut: [outline], engrave, fill: label }];
  }
  const local = (p: Path): Path[] => {
    const b = boundsOfPaths([p])!;
    return translate([p], -b.minX, -b.minY);
  };
  const body: Path[] = [poly([[xB, 0], [xC, 0], [xC, W], [xB, W]])];
  const bodyB = boundsOfPaths(body)!;
  return [
    { name: "Lápis: borracha", cut: local(poly([...eraserLeft, [xF, 0], [xF, W]])), engrave: [], fill: [] },
    { name: "Lápis: ponteira", cut: local(poly([[xF, 0], [xB, 0], [xB, W], [xF, W]])), engrave: [line([ferruleL / 3, 0], [ferruleL / 3, W]), line([(2 * ferruleL) / 3, 0], [(2 * ferruleL) / 3, W])], fill: [] },
    { name: "Lápis: corpo", cut: translate(body, -bodyB.minX, 0), engrave: [], fill: translate(label, -bodyB.minX, 0) },
    { name: "Lápis: madeira", cut: local(poly([[xC, 0], [xG, W / 2 - gHalf], [xG, W / 2 + gHalf], [xC, W]])), engrave: [], fill: [] },
    { name: "Lápis: grafite", cut: local(poly([[xG, W / 2 - gHalf], [L, W / 2], [xG, W / 2 + gHalf]])), engrave: [], fill: [] },
  ];
}

// ---------- chapas ----------

export interface PlacedPart {
  part: PanelPart;
  /** Deslocamento a somar às coordenadas locais da peça. */
  dx: number;
  dy: number;
}

/**
 * Distribui as peças em chapas do tamanho da mesa (fileiras, da esquerda para a direita).
 * Peça maior que a mesa vai para `tooBig` e fica de fora.
 */
export function layoutSheets(parts: readonly PanelPart[], area: { x: number; y: number }, margin = 8, gap = 6): { sheets: PlacedPart[][]; tooBig: string[] } {
  const sheets: PlacedPart[][] = [];
  const tooBig: string[] = [];
  let sheet: PlacedPart[] = [];
  let x = margin;
  let y = margin;
  let rowH = 0;
  for (const part of parts) {
    const b = boundsOfPaths([...part.cut, ...part.engrave, ...part.fill]);
    if (!b) continue;
    const w = b.maxX - b.minX;
    const h = b.maxY - b.minY;
    if (w > area.x - 2 * margin || h > area.y - 2 * margin) {
      tooBig.push(part.name);
      continue;
    }
    if (x > margin && x + w > area.x - margin) {
      x = margin;
      y += rowH + gap;
      rowH = 0;
    }
    if (y + h > area.y - margin) {
      if (sheet.length) sheets.push(sheet);
      sheet = [];
      x = margin;
      y = margin;
      rowH = 0;
    }
    sheet.push({ part, dx: x - b.minX, dy: y - b.minY });
    x += w + gap;
    rowH = Math.max(rowH, h);
  }
  if (sheet.length) sheets.push(sheet);
  return { sheets, tooBig };
}
