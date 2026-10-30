import type { Bounds, Point } from "@laserlink/gcode";
import { BedView, type Area } from "./bed-view.js";
import GenWorker from "./prepare/gen-worker.ts?worker&inline";
import type { GenRequest, GenResponse, RasterView } from "./prepare/gen-worker.js";
import { LayerCache, strokeSegments } from "./segment-cache.js";
import { bedColors } from "./theme.js";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

/**
 * Mesa "Na máquina": trajetória do arquivo, o que o GRBL já
 * confirmou e a posição do cabeçote em tempo real.
 *
 * Trabalhos podem ter mais de um milhão de segmentos: a leitura do G-code roda num Worker
 * e o desenho fica guardado (trajetória inteira numa camada; o que já foi feito em outra,
 * que só recebe os segmentos novos a cada progresso).
 */
export class JobPreview {
  private readonly view: BedView;
  private readonly worker: Worker = new GenWorker();
  private loadSeq = 0;
  /** x0, y0, x1, y1, laser por segmento. */
  private data: Float32Array | null = null;
  /** Linhas enviadas ao GRBL depois das quais cada segmento está feito. */
  private sentAt: Uint32Array = new Uint32Array(0);
  private count = 0;
  private bounds: Bounds | null = null;
  private sent = 0;
  private head: Point | null = null;
  private lit = false;
  private drawQueued = false;
  /** Trajetória pintada fora da tela para a vista `rasterKey`. */
  private baseBmp: ImageBitmap | null = null;
  private rasterKey = "";
  /** Pedido de pintura em andamento (chave da vista pedida). */
  private rasterPending: string | null = null;
  private rasterSeq = 0;
  private readonly done = new LayerCache();
  /** Quantos segmentos já estão pintados na camada "feito". */
  private doneDrawn = 0;

  constructor(area: Area, onHover?: (mm: Point | null) => void) {
    this.view = new BedView($<HTMLCanvasElement>("c-canvas"), area, () => this.requestDraw(), {
      onDoubleClick: () => this.fitJob(),
      ...(onHover ? { onHover } : {}),
    });
    $("c-zoom-in").addEventListener("click", () => this.view.zoomCenter(1.4));
    $("c-zoom-out").addEventListener("click", () => this.view.zoomCenter(1 / 1.4));
    $("c-zoom-fit").addEventListener("click", () => this.view.fitTo(null));
    $("c-zoom-piece").addEventListener("click", () => this.fitJob());
    this.worker.onmessage = (e: MessageEvent<GenResponse>) => {
      const m = e.data;
      if (m.kind === "raster") {
        if (m.id !== this.rasterSeq) return;
        const key = this.rasterPending;
        this.rasterPending = null;
        if (key === null || key !== this.viewKey()) {
          // a vista mudou enquanto pintava: pede de novo
          m.base.close();
          m.done.close();
          this.requestDraw();
          return;
        }
        this.baseBmp?.close();
        this.baseBmp = m.base;
        this.rasterKey = key;
        // camada "feito" parte do que o worker pintou e recebe só o que vier depois
        this.done.ensure(this.view, key);
        const dc = this.done.ctx;
        dc.clearRect(0, 0, this.done.canvas.width, this.done.canvas.height);
        dc.drawImage(m.done, 0, 0);
        m.done.close();
        this.doneDrawn = m.doneUpTo;
        this.requestDraw();
        return;
      }
      if (m.kind !== "preview" || m.id !== this.loadSeq) return;
      this.data = m.data;
      this.sentAt = m.sentAt;
      this.count = m.sentAt.length;
      this.bounds = m.bounds;
      this.rasterKey = "";
      $("c-empty").hidden = true;
      this.requestDraw();
    };
  }

  setArea(area: Area): void {
    this.view.setArea(area);
  }

  /** Carrega um G-code (arquivo escolhido ou desenho enviado). A leitura acontece fora da tela. */
  load(name: string, gcode: string): void {
    const id = ++this.loadSeq;
    this.data = null;
    this.count = 0;
    this.sent = 0;
    $("c-name").textContent = name;
    $("c-empty").hidden = true;
    this.worker.postMessage({ kind: "preview", id, gcode } satisfies GenRequest);
    this.requestDraw();
  }

  /** Tira o trabalho da mesa "Na máquina" (o cabeçote continua aparecendo). */
  clear(): void {
    this.loadSeq += 1;
    this.data = null;
    this.count = 0;
    this.sent = 0;
    this.bounds = null;
    $("c-name").textContent = "";
    $("c-empty").hidden = false;
    this.requestDraw();
  }

  setProgress(sent: number): void {
    if (sent < this.sent) this.done.invalidate(); // recomeçou (outro trabalho com o mesmo arquivo)
    this.sent = sent;
    this.requestDraw();
  }

  /** Junta vários pedidos num desenho por quadro (o progresso chega centenas de vezes por segundo). */
  private requestDraw(): void {
    if (this.drawQueued) return;
    this.drawQueued = true;
    requestAnimationFrame(() => {
      this.drawQueued = false;
      this.draw();
    });
  }

  setHead(p: Point, spindle: number): void {
    this.head = p;
    this.lit = spindle > 0;
    $("c-hud-pos").textContent = `X ${p[0].toFixed(1)} Y ${p[1].toFixed(1)}`;
    this.requestDraw();
  }

  private fitJob(): void {
    const b = this.bounds;
    if (b) this.view.fitTo({ minX: b.minX - 5, minY: b.minY - 5, maxX: b.maxX + 5, maxY: b.maxY + 5 }, true);
  }

  /** Identifica a vista atual (tamanho, zoom, posição, tema) e o trabalho carregado. */
  private viewKey(): string {
    const v = this.view;
    return `${v.canvas.width}x${v.canvas.height}|${v.ox}|${v.oy}|${v.s}|${document.documentElement.dataset.bed ?? ""}|${this.loadSeq}`;
  }

  /** Quantos segmentos já estão feitos com `sent` linhas confirmadas (sentAt cresce junto com o arquivo). */
  private doneCount(): number {
    let lo = 0;
    let hi = this.count;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.sentAt[mid]! <= this.sent) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private draw(): void {
    const v = this.view;
    v.drawBed();
    const ctx = v.ctx;
    const d = v.dpr;
    const data = this.data;
    if (data) {
      const col = bedColors();
      const key = this.viewKey();
      if (key !== this.rasterKey) {
        // vista nova: a trajetória é pintada no worker (pode ter um milhão de segmentos)
        if (this.rasterPending !== key) {
          this.rasterPending = key;
          const view: RasterView = { w: v.canvas.width, h: v.canvas.height, ox: v.ox, oy: v.oy, s: v.s, dpr: d, colors: { travel: col.travel, todo: col.todo, burned: col.burned } };
          this.worker.postMessage({ kind: "raster", id: ++this.rasterSeq, view, doneUpTo: this.doneCount() } satisfies GenRequest);
        }
        $("c-hud-zoom").textContent = `${v.zoomPercent}% · desenhando…`;
        if (this.head) v.drawHead(this.head, this.lit);
        return;
      }
      // o que já foi gravado: só os segmentos novos desde o último quadro
      let end = this.doneDrawn;
      while (end < this.count && this.sentAt[end]! <= this.sent) end++;
      if (end > this.doneDrawn) {
        const dc = this.done.ctx;
        dc.strokeStyle = col.burned;
        dc.lineWidth = 1.8 * d;
        strokeSegments(dc, v, data, 5, this.doneDrawn, end, (burn) => burn);
        this.doneDrawn = end;
      }
      if (this.baseBmp) ctx.drawImage(this.baseBmp, 0, 0);
      ctx.drawImage(this.done.canvas, 0, 0);
    }
    if (this.head) v.drawHead(this.head, this.lit);
    $("c-hud-zoom").textContent = `${v.zoomPercent}%`;
  }
}
