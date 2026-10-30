// Gera o G-code fora da tela: trabalhos grandes (centenas de milhares de linhas) levariam
// segundos e travariam a página — e uma página travada para de mandar sinal ao agente.
import { generateGcode, parseGcode, segmentSeconds, type Bounds, type GenerateResult, type JobDesign, type MachineProfile, type PassOrder } from "@laserlink/gcode";

export type GenRequest =
  | { kind: "gen"; id: number; design: JobDesign; machine: MachineProfile; passOrder: PassOrder }
  /** Segmentos completos do último resultado (para a simulação). */
  | { kind: "segments"; id: number }
  /** Prévia da mesa "Na máquina" de um G-code qualquer (enviado, da fila ou de arquivo). */
  | { kind: "preview"; id: number; gcode: string }
  /** Pinta a prévia carregada numa vista (fora da tela): trajetória e o que já foi feito até `doneUpTo`. */
  | { kind: "raster"; id: number; view: RasterView; doneUpTo: number };

/** Vista da mesa para pintar fora da tela: X = ox + x·s, Y = oy − y·s (pixels do canvas). */
export interface RasterView {
  w: number;
  h: number;
  ox: number;
  oy: number;
  s: number;
  dpr: number;
  colors: { travel: string; todo: string; burned: string };
}

export type GenResponse =
  | {
      kind: "gen";
      id: number;
      ok: true;
      result: GenerateResult;
      /** Tempo na outra ordem de passes (null = não se aplica). */
      altSeconds: number | null;
      maxPasses: number;
      burnBounds: Bounds | null;
      /** Deslocamentos sem laser: x0, y0, x1, y1 por segmento. */
      travel: Float32Array;
    }
  | { kind: "gen"; id: number; ok: false; error: string }
  /** x0, y0, x1, y1, laser (0/1) por segmento, e o tempo acumulado até o fim de cada um. */
  | { kind: "segments"; id: number; data: Float32Array; cumulative: Float64Array }
  /** x0, y0, x1, y1, laser por segmento; `sentAt`: a quantas linhas enviadas ao GRBL cada segmento já foi feito. */
  | { kind: "preview"; id: number; data: Float32Array; sentAt: Uint32Array; bounds: Bounds | null }
  | { kind: "raster"; id: number; base: ImageBitmap; done: ImageBitmap; doneUpTo: number };

const ctx = self as unknown as { postMessage(msg: GenResponse, transfer?: Transferable[]): void; onmessage: ((e: MessageEvent<GenRequest>) => void) | null };

let lastGcode = "";
/** Última prévia carregada (cópia própria: a outra foi transferida para a página). */
let preview: { data: Float32Array; count: number } | null = null;

/** Traça segmentos em blocos (um caminho gigante é bem mais lento de pintar). */
function strokeRange(c: OffscreenCanvasRenderingContext2D, v: RasterView, data: Float32Array, from: number, to: number, pick: (k: number) => boolean): void {
  let n = 0;
  c.beginPath();
  for (let i = from; i < to; i++) {
    const k = i * 5;
    if (!pick(k)) continue;
    c.moveTo(v.ox + data[k]! * v.s, v.oy - data[k + 1]! * v.s);
    c.lineTo(v.ox + data[k + 2]! * v.s, v.oy - data[k + 3]! * v.s);
    if (++n >= 2000) {
      c.stroke();
      c.beginPath();
      n = 0;
    }
  }
  if (n) c.stroke();
}

ctx.onmessage = (e) => {
  const req = e.data;
  if (req.kind === "preview") {
    const parsed = parseGcode(req.gcode);
    // linha do arquivo → posição entre as linhas que vão ao GRBL (sem comentários e vazias)
    const lineToSent = new Uint32Array(req.gcode.split(/\r?\n/).length + 2);
    let n = 0;
    req.gcode.split(/\r?\n/).forEach((raw, i) => {
      const clean = raw.replace(/;.*$/, "").replace(/\(.*?\)/g, "").trim();
      if (clean && clean !== "%") n += 1;
      lineToSent[i + 1] = clean && clean !== "%" ? n : 0;
    });
    const segs = parsed.segments;
    const data = new Float32Array(segs.length * 5);
    const sentAt = new Uint32Array(segs.length);
    segs.forEach((sg, i) => {
      data.set([sg.from[0], sg.from[1], sg.to[0], sg.to[1], sg.burn ? 1 : 0], i * 5);
      sentAt[i] = lineToSent[sg.line] || 0xffffffff;
    });
    preview = { data: data.slice(), count: segs.length };
    ctx.postMessage({ kind: "preview", id: req.id, data, sentAt, bounds: parsed.bounds }, [data.buffer, sentAt.buffer]);
    return;
  }
  if (req.kind === "raster") {
    const v = req.view;
    const base = new OffscreenCanvas(Math.max(1, v.w), Math.max(1, v.h));
    const done = new OffscreenCanvas(Math.max(1, v.w), Math.max(1, v.h));
    if (preview) {
      const { data, count } = preview;
      const b = base.getContext("2d")!;
      b.setLineDash([4 * v.dpr, 4 * v.dpr]);
      b.strokeStyle = v.colors.travel;
      b.lineWidth = 1 * v.dpr;
      strokeRange(b, v, data, 0, count, (k) => data[k + 4] === 0 && Math.hypot(data[k + 2]! - data[k]!, data[k + 3]! - data[k + 1]!) >= 1);
      b.setLineDash([]);
      b.strokeStyle = v.colors.todo;
      b.lineWidth = 1.2 * v.dpr;
      strokeRange(b, v, data, 0, count, (k) => data[k + 4] === 1);
      const dc = done.getContext("2d")!;
      dc.strokeStyle = v.colors.burned;
      dc.lineWidth = 1.8 * v.dpr;
      strokeRange(dc, v, data, 0, Math.min(req.doneUpTo, count), (k) => data[k + 4] === 1);
    }
    const bb = base.transferToImageBitmap();
    const db = done.transferToImageBitmap();
    ctx.postMessage({ kind: "raster", id: req.id, base: bb, done: db, doneUpTo: req.doneUpTo }, [bb, db]);
    return;
  }
  if (req.kind === "segments") {
    const segs = parseGcode(lastGcode).segments;
    const data = new Float32Array(segs.length * 5);
    const cumulative = new Float64Array(segs.length);
    let acc = 0;
    segs.forEach((sg, i) => {
      data.set([sg.from[0], sg.from[1], sg.to[0], sg.to[1], sg.burn ? 1 : 0], i * 5);
      acc += segmentSeconds(sg);
      cumulative[i] = acc;
    });
    ctx.postMessage({ kind: "segments", id: req.id, data, cumulative }, [data.buffer, cumulative.buffer]);
    return;
  }
  try {
    const result = generateGcode(req.design, req.machine, { passOrder: req.passOrder });
    lastGcode = result.gcode;
    const parsed = parseGcode(result.gcode);
    // ligações curtas do preenchimento (G1 S0) não entram: são milhões e só poluem a mesa
    const travelSegs = parsed.segments.filter((sg) => !sg.burn && Math.hypot(sg.to[0] - sg.from[0], sg.to[1] - sg.from[1]) >= 1);
    const travel = new Float32Array(travelSegs.length * 4);
    travelSegs.forEach((sg, i) => travel.set([sg.from[0], sg.from[1], sg.to[0], sg.to[1]], i * 4));
    // a outra ordem só muda linhas e cortes: compara só essa parte (bem mais leve que gerar tudo de novo)
    const paths = req.design.vectors.filter((g) => g.mode === "cut" || g.mode === "line");
    const maxPasses = Math.max(0, ...paths.map((g) => g.settings.passes));
    let altSeconds: number | null = null;
    if (paths.length) {
      const subset: JobDesign = { name: req.design.name, rasters: [], vectors: paths };
      const other: PassOrder = req.passOrder === "piece" ? "pass" : "piece";
      const cur = generateGcode(subset, req.machine, { passOrder: req.passOrder }).estimatedSeconds;
      const alt = generateGcode(subset, req.machine, { passOrder: other }).estimatedSeconds;
      altSeconds = result.estimatedSeconds - cur + alt;
    }
    ctx.postMessage({ kind: "gen", id: req.id, ok: true, result, altSeconds, maxPasses, burnBounds: parsed.burnBounds, travel }, [travel.buffer]);
  } catch (err) {
    ctx.postMessage({ kind: "gen", id: req.id, ok: false, error: (err as Error).message });
  }
};
