import { parseGcode, type ParsedGcode, type Point } from "@laserlink/gcode";
import { BedView, type Area } from "./bed-view.js";
import { bedColors } from "./theme.js";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

/**
 * Mesa "Na máquina": trajetória do arquivo, o que o GRBL já
 * confirmou e a posição do cabeçote em tempo real.
 */
export class JobPreview {
  private readonly view: BedView;
  private parsed: ParsedGcode | null = null;
  /** linha original do arquivo → posição entre as linhas enviadas ao GRBL (1…n) */
  private lineToSent = new Map<number, number>();
  private sent = 0;
  private head: Point | null = null;
  private lit = false;
  /** posição de cada segmento entre as linhas enviadas (para saber o que já foi) */
  private segSent: number[] = [];
  private drawQueued = false;

  constructor(area: Area, onHover?: (mm: Point | null) => void) {
    this.view = new BedView($<HTMLCanvasElement>("c-canvas"), area, () => this.requestDraw(), {
      onDoubleClick: () => this.fitJob(),
      ...(onHover ? { onHover } : {}),
    });
    $("c-zoom-in").addEventListener("click", () => this.view.zoomCenter(1.4));
    $("c-zoom-out").addEventListener("click", () => this.view.zoomCenter(1 / 1.4));
    $("c-zoom-fit").addEventListener("click", () => this.view.fitTo(null));
    $("c-zoom-piece").addEventListener("click", () => this.fitJob());
  }

  setArea(area: Area): void {
    this.view.setArea(area);
  }

  /** Carrega um G-code (arquivo escolhido ou desenho enviado). */
  load(name: string, gcode: string): void {
    this.parsed = parseGcode(gcode);
    this.lineToSent.clear();
    let n = 0;
    gcode.split(/\r?\n/).forEach((raw, i) => {
      const clean = raw.replace(/;.*$/, "").replace(/\(.*?\)/g, "").trim();
      if (clean && clean !== "%") this.lineToSent.set(i + 1, ++n);
    });
    this.segSent = this.parsed.segments.map((sg) => this.lineToSent.get(sg.line) ?? Infinity);
    this.sent = 0;
    $("c-name").textContent = name;
    $("c-empty").hidden = true;
    this.requestDraw();
  }

  setProgress(sent: number): void {
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
    const b = this.parsed?.bounds;
    if (b) this.view.fitTo({ minX: b.minX - 5, minY: b.minY - 5, maxX: b.maxX + 5, maxY: b.maxY + 5 }, true);
  }

  private draw(): void {
    const v = this.view;
    v.drawBed();
    const ctx = v.ctx;
    const d = v.dpr;
    if (this.parsed) {
      // três caminhos só (deslocamentos, a gravar, já gravado): rápido mesmo com dezenas de milhares de segmentos
      const travel = new Path2D();
      const todo = new Path2D();
      const done = new Path2D();
      this.parsed.segments.forEach((sg, i) => {
        const path = !sg.burn ? travel : this.segSent[i]! <= this.sent ? done : todo;
        path.moveTo(v.X(sg.from[0]), v.Y(sg.from[1]));
        path.lineTo(v.X(sg.to[0]), v.Y(sg.to[1]));
      });
      ctx.lineCap = "round";
      ctx.setLineDash([4 * d, 4 * d]);
      const col = bedColors();
      ctx.strokeStyle = col.travel;
      ctx.lineWidth = 1 * d;
      ctx.stroke(travel);
      ctx.setLineDash([]);
      ctx.strokeStyle = col.todo;
      ctx.lineWidth = 1.2 * d;
      ctx.stroke(todo);
      ctx.strokeStyle = col.burned;
      ctx.lineWidth = 1.8 * d;
      ctx.stroke(done);
    }
    if (this.head) v.drawHead(this.head, this.lit);
    $("c-hud-zoom").textContent = `${v.zoomPercent}%`;
  }
}
