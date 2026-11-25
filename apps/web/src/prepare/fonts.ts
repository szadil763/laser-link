import opentype from "opentype.js";
import { textToPaths, unionPaths, type Path, type Point, type TextOptions, type TextTag } from "@laserlink/gcode";
import fredoka from "@fontsource/fredoka/files/fredoka-latin-700-normal.woff?url";
import baloo from "@fontsource/baloo-2/files/baloo-2-latin-800-normal.woff?url";
import luckiest from "@fontsource/luckiest-guy/files/luckiest-guy-latin-400-normal.woff?url";
import chewy from "@fontsource/chewy/files/chewy-latin-400-normal.woff?url";
import pacifico from "@fontsource/pacifico/files/pacifico-latin-400-normal.woff?url";
import lobster from "@fontsource/lobster/files/lobster-latin-400-normal.woff?url";
import patrick from "@fontsource/patrick-hand/files/patrick-hand-latin-400-normal.woff?url";
import comic from "@fontsource/comic-neue/files/comic-neue-latin-700-normal.woff?url";
import bebas from "@fontsource/bebas-neue/files/bebas-neue-latin-400-normal.woff?url";
import roboto from "@fontsource/roboto/files/roboto-latin-700-normal.woff?url";
import stencil from "@fontsource/allerta-stencil/files/allerta-stencil-latin-400-normal.woff?url";

/**
 * Fontes de texto. "single" é a fonte própria de traço único (gravar em linha);
 * as outras são fontes livres (licença OFL, vêm junto com o app) com letras de contorno,
 * boas para cortar ou gravar preenchido. A pessoa também pode carregar uma fonte do computador.
 */
export interface FontInfo {
  id: string;
  label: string;
  url?: string;
}

export const SINGLE_STROKE = "single";

export const FONTS: FontInfo[] = [
  { id: SINGLE_STROKE, label: "Traço único (gravar em linha)" },
  { id: "fredoka", label: "Fredoka (arredondada)", url: fredoka },
  { id: "baloo2", label: "Baloo 2 (gordinha)", url: baloo },
  { id: "luckiest", label: "Luckiest Guy (cartaz)", url: luckiest },
  { id: "chewy", label: "Chewy (divertida)", url: chewy },
  { id: "pacifico", label: "Pacifico (cursiva)", url: pacifico },
  { id: "lobster", label: "Lobster (cursiva clássica)", url: lobster },
  { id: "patrick", label: "Patrick Hand (escrita à mão)", url: patrick },
  { id: "comic", label: "Comic Neue (escolar)", url: comic },
  { id: "bebas", label: "Bebas Neue (alta)", url: bebas },
  { id: "roboto", label: "Roboto (simples)", url: roboto },
  { id: "stencil", label: "Allerta Stencil (estêncil)", url: stencil },
];

const USER_PREFIX = "user:";
const STORE_KEY = "laserlink.fonts";
const cache = new Map<string, Promise<opentype.Font>>();
const userFonts = new Map<string, { label: string; data: ArrayBuffer }>();

function toBase64(buf: ArrayBuffer): string {
  let s = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(b64: string): ArrayBuffer {
  const s = atob(b64);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes.buffer;
}

// fontes carregadas antes, guardadas neste navegador
try {
  const saved = JSON.parse(localStorage.getItem(STORE_KEY) ?? "[]") as Array<{ id: string; label: string; b64: string }>;
  for (const f of saved) userFonts.set(f.id, { label: f.label, data: fromBase64(f.b64) });
} catch {
  /* armazenamento indisponível ou corrompido: segue sem as fontes guardadas */
}

/** Todas as fontes: as que vêm com o app e as carregadas pela pessoa. */
export function allFonts(): FontInfo[] {
  return [...FONTS, ...[...userFonts].map(([id, f]) => ({ id, label: `${f.label} (sua)` }))];
}

export function fontLabel(id: string | undefined): string {
  return allFonts().find((f) => f.id === (id ?? SINGLE_STROKE))?.label ?? "fonte que não está mais carregada";
}

export function loadFont(id: string): Promise<opentype.Font> {
  let p = cache.get(id);
  if (!p) {
    const info = FONTS.find((f) => f.id === id);
    const user = userFonts.get(id);
    p = (async () => {
      if (user) return opentype.parse(user.data);
      if (!info?.url) throw new Error("Essa fonte não está carregada neste computador. Use Carregar fonte do computador e tente de novo.");
      const res = await fetch(info.url);
      if (!res.ok) throw new Error(`Não deu para baixar a fonte ${info.label} (erro ${res.status}).`);
      return opentype.parse(await res.arrayBuffer());
    })();
    p.catch(() => cache.delete(id));
    cache.set(id, p);
  }
  return p;
}

/** Carrega uma fonte TTF, OTF ou WOFF do computador. Guarda neste navegador quando cabe. */
export async function addUserFont(file: File): Promise<FontInfo> {
  if (/\.woff2$/i.test(file.name)) throw new Error("WOFF2 não é aceito. Use a mesma fonte em TTF, OTF ou WOFF.");
  const data = await file.arrayBuffer();
  let font: opentype.Font;
  try {
    font = opentype.parse(data);
  } catch {
    throw new Error(`${file.name} não parece ser uma fonte TTF, OTF ou WOFF.`);
  }
  const label = font.names.fullName?.en || file.name.replace(/\.[^.]+$/, "");
  const id = `${USER_PREFIX}${label}`;
  userFonts.set(id, { label, data });
  cache.set(id, Promise.resolve(font));
  try {
    const list = [...userFonts].map(([fid, f]) => ({ id: fid, label: f.label, b64: toBase64(f.data) }));
    localStorage.setItem(STORE_KEY, JSON.stringify(list));
  } catch {
    /* sem espaço: a fonte vale só até fechar a página */
  }
  return { id, label: `${label} (sua)` };
}

/** Altura das maiúsculas em unidades da fonte (ou ~70% do quadro, se a fonte não informa). */
function capHeight(font: opentype.Font): number {
  const os2 = (font.tables as { os2?: { sCapHeight?: number } }).os2;
  const fromTable = os2?.sCapHeight;
  if (fromTable && fromTable > 0) return fromTable;
  const h = font.charToGlyph("H").getBoundingBox();
  return h.y2 > 0 ? h.y2 : font.unitsPerEm * 0.7;
}

/** Curvas viram retas curtas (no máximo ~0,25 mm). */
function flatten(cmds: opentype.PathCommand[], flipY: (y: number) => number, tol: number): Path[] {
  const out: Path[] = [];
  let cur: Point[] = [];
  let px = 0;
  let py = 0;
  const push = (x: number, y: number): void => {
    cur.push([x, flipY(y)]);
    px = x;
    py = y;
  };
  const close = (): void => {
    if (cur.length >= 3) out.push({ closed: true, points: [...cur, cur[0]!] });
    cur = [];
  };
  for (const c of cmds) {
    if (c.type === "M") {
      close();
      push(c.x, c.y);
    } else if (c.type === "L") push(c.x, c.y);
    else if (c.type === "Q") {
      const n = Math.max(2, Math.min(32, Math.ceil(Math.hypot(c.x - px, c.y - py) / tol)));
      const [x0, y0] = [px, py];
      for (let i = 1; i <= n; i++) {
        const t = i / n;
        const u = 1 - t;
        push(u * u * x0 + 2 * u * t * c.x1 + t * t * c.x, u * u * y0 + 2 * u * t * c.y1 + t * t * c.y);
      }
    } else if (c.type === "C") {
      const n = Math.max(3, Math.min(48, Math.ceil(Math.hypot(c.x - px, c.y - py) / tol)));
      const [x0, y0] = [px, py];
      for (let i = 1; i <= n; i++) {
        const t = i / n;
        const u = 1 - t;
        push(
          u * u * u * x0 + 3 * u * u * t * c.x1 + 3 * u * t * t * c.x2 + t * t * t * c.x,
          u * u * u * y0 + 3 * u * u * t * c.y1 + 3 * u * t * t * c.y2 + t * t * t * c.y,
        );
      }
    } else if (c.type === "Z") close();
  }
  close();
  return out;
}

/** Uma linha de texto em contornos fechados e unidos: linha de base em y = 0, começando em x = 0. */
export function shapeLine(font: opentype.Font, text: string, height: number): Path[] {
  const size = (height / capHeight(font)) * font.unitsPerEm;
  const path = font.getPath(text, 0, 0, size, { kerning: true });
  // opentype desenha com y para baixo; na mesa y cresce para cima
  return unionPaths(flatten(path.commands, (y) => -y, 0.25));
}

function lineWidth(font: opentype.Font, text: string, height: number): number {
  const size = (height / capHeight(font)) * font.unitsPerEm;
  return font.getAdvanceWidth(text, size, { kerning: true });
}

/** Texto (com várias linhas e alinhamento) na fonte escolhida. Mesmo contrato de `textToPaths`. */
export async function fontTextToPaths(fontId: string | undefined, text: string, o: TextOptions): Promise<Path[]> {
  if (!fontId || fontId === SINGLE_STROKE) return textToPaths(text, o);
  const font = await loadFont(fontId);
  const lineGap = ((font.ascender - font.descender) / capHeight(font)) * o.height * 1.05;
  const out: Path[] = [];
  text.split("\n").forEach((l, i) => {
    const w = lineWidth(font, l, o.height);
    const shift = o.align === "center" ? -w / 2 : o.align === "right" ? -w : 0;
    const dy = o.y - i * lineGap;
    for (const p of shapeLine(font, l, o.height)) out.push({ closed: true, points: p.points.map(([x, y]) => [x + o.x + shift, y + dy] as Point) });
  });
  if (o.tag) {
    const tag: TextTag = { id: o.tag, value: text, height: o.height, align: o.align ?? "left", font: fontId };
    for (const p of out) p.text = tag;
  }
  return out;
}

/** Deixa a fonte disponível para o CSS (amostra no diálogo). */
export async function cssFamily(fontId: string): Promise<string | null> {
  if (fontId === SINGLE_STROKE) return null;
  const family = `ll-${fontId.replace(/[^a-z0-9]/gi, "-")}`;
  if ([...document.fonts].some((f) => f.family === family)) return family;
  const info = FONTS.find((f) => f.id === fontId);
  const user = userFonts.get(fontId);
  const source = user ? user.data : info?.url ? `url(${info.url})` : null;
  if (!source) return null;
  const face = new FontFace(family, source);
  await face.load();
  document.fonts.add(face);
  return family;
}
