import { boundsOf, parseDxf, type Point } from "@laserlink/gcode";
import type { Material } from "@laserlink/shared";
import { makeLayer, makeShape, rebuildImage, type ImageItem, type Layer } from "./model.js";

const SVG_NS = "http://www.w3.org/2000/svg";

const NAMED: Record<string, string> = {
  "rgb(255, 0, 0)": "Vermelho",
  "rgb(0, 0, 255)": "Azul",
  "rgb(0, 0, 0)": "Preto",
  "rgb(0, 128, 0)": "Verde",
  "rgb(0, 255, 0)": "Verde",
  "rgb(255, 0, 255)": "Magenta",
  "rgb(255, 165, 0)": "Laranja",
};

/** mm por unidade de um comprimento SVG ("100mm", "4in", "300" = px). */
function lengthToMm(v: string | null): number | null {
  if (!v) return null;
  const m = /^\s*([\d.]+)\s*(mm|cm|in|px|pt)?\s*$/.exec(v);
  if (!m) return null;
  const factor: Record<string, number> = { mm: 1, cm: 10, in: 25.4, pt: 25.4 / 72, px: 25.4 / 96 };
  return factor[m[2] ?? "px"]! * Number(m[1]);
}

/**
 * Ajuste de corte escrito no próprio SVG: data-laserlink-corte="velocidade:1800 potencia:85 passadas:22".
 * Só vale o que estiver dentro dos limites; o resto continua vindo do material.
 */
export function parseCorteAttr(text: string | null): { speed?: number; power?: number; passes?: number } {
  const out: { speed?: number; power?: number; passes?: number } = {};
  if (!text) return out;
  const num = (re: RegExp): number | undefined => {
    const m = re.exec(text);
    return m ? Number(m[1]!.replace(",", ".")) : undefined;
  };
  const speed = num(/velocidade\s*[:=]\s*([\d.,]+)/i);
  const power = num(/pot[eê]ncia\s*[:=]\s*([\d.,]+)/i);
  const passes = num(/passadas\s*[:=]\s*(\d+)/i);
  if (speed !== undefined && speed > 0 && speed <= 20000) out.speed = speed;
  if (power !== undefined && power >= 0 && power <= 100) out.power = power;
  if (passes !== undefined && Number.isInteger(passes) && passes >= 1 && passes <= 50) out.passes = passes;
  return out;
}

export interface SvgImport {
  layers: Layer[];
  count: number;
}

/**
 * Lê um SVG com o próprio navegador: cada elemento vira uma polilinha
 * (curvas amostradas a cada ~0,25 mm), agrupada em camadas pela cor do traço.
 * Vermelho vira Cortar; as outras cores, Gravar linha. Posiciona a 20 mm da origem.
 */
export function importSvg(text: string, materials: readonly Material[]): SvgImport {
  const doc = new DOMParser().parseFromString(text, "image/svg+xml");
  const svg = doc.documentElement;
  if (svg.nodeName.toLowerCase() !== "svg" || doc.querySelector("parsererror")) {
    throw new Error("Esse arquivo não é um SVG válido.");
  }
  const host = document.createElementNS(SVG_NS, "svg");
  host.setAttribute("style", "position:absolute;left:-9999px;top:0;width:10px;height:10px;visibility:hidden");
  for (const child of [...svg.childNodes]) host.appendChild(document.importNode(child, true));
  const vb = (svg.getAttribute("viewBox") ?? "").trim().split(/[\s,]+/).map(Number);
  const hasVb = vb.length === 4 && vb.every(Number.isFinite);
  const wmm = lengthToMm(svg.getAttribute("width"));
  const hmm = lengthToMm(svg.getAttribute("height"));
  const sx = wmm && hasVb && vb[2] ? wmm / vb[2] : 25.4 / 96;
  const sy = hmm && hasVb && vb[3] ? hmm / vb[3] : sx;
  const vx = hasVb ? vb[0]! : 0;
  const vy = hasVb ? vb[1]! : 0;
  document.body.appendChild(host);
  const groups = new Map<string, Array<{ points: Point[]; closed: boolean; name: string }>>();
  let count = 0;
  try {
    const hostCtm = host.getCTM();
    for (const el of host.querySelectorAll<SVGGeometryElement>("path,line,polyline,polygon,rect,circle,ellipse")) {
      const cs = getComputedStyle(el);
      if (cs.display === "none") continue;
      const stroked = !!cs.stroke && cs.stroke !== "none";
      const color = stroked ? cs.stroke : cs.fill && cs.fill !== "none" ? cs.fill : "rgb(0, 0, 0)";
      // só preenchimento, sem contorno: a intenção é gravar a área (preenchido)
      const key = stroked || !(cs.fill && cs.fill !== "none") ? color : `${color}|fill`;
      let total = 0;
      try {
        total = el.getTotalLength();
      } catch {
        total = 0;
      }
      if (!(total > 0)) continue;
      const step = Math.max(0.25 / sx, total / 4000);
      const ctm = el.getCTM();
      const m = hostCtm && ctm ? hostCtm.inverse().multiply(ctm) : null;
      const at = (len: number): Point => {
        let p = el.getPointAtLength(len);
        if (m) p = p.matrixTransform(m);
        return [(p.x - vx) * sx, (p.y - vy) * sy];
      };
      const points: Point[] = [];
      for (let s = 0; s < total; s += step) points.push(at(s));
      points.push(at(total));
      if (points.length < 2) continue;
      const tag = el.tagName.toLowerCase();
      const closed = ["rect", "circle", "ellipse", "polygon"].includes(tag) || (tag === "path" && /z\s*$/i.test(el.getAttribute("d") ?? ""));
      const list = groups.get(key) ?? [];
      list.push({ points, closed, name: el.id || tag });
      groups.set(key, list);
      count++;
    }
  } finally {
    host.remove();
  }
  if (!count) throw new Error("Não encontrei caminhos nesse SVG. No programa de desenho, converta textos e objetos em caminhos.");
  const b = boundsOf([...groups.values()].flat().flatMap((s) => s.points))!;
  const layers: Layer[] = [];
  let n = 0;
  const mdf = materials[0];
  // data-laserlink="mesa": o SVG é a mesa inteira (0,0 no canto de baixo à esquerda) e as posições valem como estão
  const onBed = svg.getAttribute("data-laserlink") === "mesa";
  const bedH = hmm ?? (hasVb ? vb[3]! * sy : b.maxY);
  const corte = parseCorteAttr(svg.getAttribute("data-laserlink-corte"));
  for (const [key, shapes] of groups) {
    const [color, kind] = key.split("|") as [string, string | undefined];
    const red = /^rgb\((2\d\d), (\d{1,2}), (\d{1,2})\)$/.test(color);
    const mode = kind === "fill" ? "fill" : red ? "cut" : "line";
    const base = NAMED[color] ?? `Cor ${++n}`;
    const layer = makeLayer(kind === "fill" ? `${base} (preenchido)` : base, color, mode, mdf);
    if (mode === "cut") layer.settings.cut = { ...layer.settings.cut, ...corte };
    shapes.forEach((sh, k) => {
      // SVG tem Y para baixo
      const pts = sh.points.map(([x, y]) => (onBed ? [x, bedH - y] : [x - b.minX + 20, b.maxY - y + 20]) as Point);
      layer.shapes.push(makeShape(pts, `${sh.name} ${k + 1}`, sh.closed));
    });
    layers.push(layer);
  }
  return { layers, count };
}

/** Cores ACI mais comuns do DXF. */
const ACI: Record<number, [string, string]> = {
  1: ["#ff5c5c", "Vermelho"],
  2: ["#e0c34d", "Amarelo"],
  3: ["#45c46a", "Verde"],
  4: ["#3fc6d1", "Ciano"],
  5: ["#4da3ff", "Azul"],
  6: ["#d36be0", "Magenta"],
  7: ["#c7cbd1", "Branco/preto"],
};

/**
 * Lê um DXF (pacote gcode, sem navegador): uma camada do LaserLink por camada do DXF.
 * Vermelho (cor 1) vira Cortar; as outras, Gravar linha. Posiciona a 20 mm da origem.
 */
export function importDxf(text: string, materials: readonly Material[]): SvgImport & { skipped: number } {
  const r = parseDxf(text);
  const b = boundsOf(r.layers.flatMap((l) => l.paths.flatMap((p) => p.points)))!;
  const mdf = materials[0];
  let count = 0;
  const layers = r.layers.map((dl) => {
    const [color, colorName] = ACI[dl.color] ?? ["#c7cbd1", `Cor ${dl.color}`];
    const layer = makeLayer(dl.name === "0" ? colorName : dl.name, color, dl.color === 1 ? "cut" : "line", mdf);
    dl.paths.forEach((p, k) => {
      const pts = p.points.map(([x, y]) => [x - b.minX + 20, y - b.minY + 20] as Point);
      layer.shapes.push(makeShape(pts, `${layer.name} ${k + 1}`, p.closed));
      count++;
    });
    return layer;
  });
  const skipped = Object.values(r.skipped).reduce((a, n) => a + n, 0);
  return { layers, count, skipped };
}

/** Abre PNG/JPG e cria a imagem com 60 mm de largura a 20 mm da origem. */
export function importImage(file: File, material: Material | undefined, settings: ImageItem["settings"]): Promise<ImageItem> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const im = new Image();
    im.onload = () => {
      const w = 60;
      const h = Math.max(1, Math.round((60 * im.naturalHeight) / im.naturalWidth));
      const img: ImageItem = {
        name: file.name,
        source: im,
        sourceWidth: im.naturalWidth,
        sourceHeight: im.naturalHeight,
        x: 20,
        y: 20,
        w,
        h,
        res: 8,
        threshold: 128,
        dither: "floyd-steinberg",
        overscan: 3,
        bidirectional: true,
        settings,
        enabled: true,
        materialId: material?.id ?? null,
        bitmap: new Uint8Array(0),
        bw: 0,
        bh: 0,
        preview: document.createElement("canvas"),
      };
      rebuildImage(img);
      resolve(img);
    };
    im.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Não consegui abrir a imagem. Use PNG ou JPG."));
    };
    im.src = url;
  });
}
