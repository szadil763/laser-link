import type { Point } from "@laserlink/gcode";

export interface Area {
  x: number;
  y: number;
}

export interface BedInteractions {
  /** Toque/clique sem arrastar, em pixels do canvas. */
  onTap?(px: Point, ev: PointerEvent): void;
  /** Começo de arraste: devolva true para arrastar um objeto em vez da vista. */
  onDragStart?(px: Point): boolean;
  /** Arraste de objeto, deslocamento em mm desde o último evento. */
  onDragMove?(dxMm: number, dyMm: number): void;
  onDragEnd?(): void;
  onDoubleClick?(): void;
}

/**
 * Mesa da laser num canvas: câmera com zoom (roda do mouse, pinça, botões),
 * arrastar para mover, grade e régua em mm que se adaptam ao zoom.
 * Y para cima, como na máquina.
 */
export class BedView {
  readonly ctx: CanvasRenderingContext2D;
  dpr = 1;
  /** px de canvas por mm */
  s = 1;
  ox = 0;
  oy = 0;
  /** escala que mostra a mesa inteira */
  fitS = 1;
  private zoomed = false;
  private readonly pointers = new Map<number, Point>();
  private drag: { p: Point; moved: boolean; object: boolean } | null = null;
  private pinch: { d: number; mid: Point } | null = null;

  constructor(
    readonly canvas: HTMLCanvasElement,
    public area: Area,
    private readonly redraw: () => void,
    private readonly interactions: BedInteractions = {},
  ) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D indisponível neste navegador.");
    this.ctx = ctx;
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.attach();
  }

  get zoomPercent(): number {
    return Math.round((this.s / this.fitS) * 100);
  }

  X(x: number): number {
    return this.ox + x * this.s;
  }

  Y(y: number): number {
    return this.oy - y * this.s;
  }

  toMm(px: number, py: number): Point {
    return [(px - this.ox) / this.s, (this.oy - py) / this.s];
  }

  setArea(area: Area): void {
    if (area.x === this.area.x && area.y === this.area.y) return;
    this.area = area;
    this.zoomed = false;
    this.resize();
  }

  resize(): void {
    const r = this.canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const c = this.canvas;
    const center = c.width ? this.toMm(c.width / 2, c.height / 2) : null;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const newW = Math.round(r.width * dpr);
    const ratio = c.width ? newW / c.width : 1;
    c.width = newW;
    c.height = Math.round(r.height * dpr);
    this.dpr = dpr;
    const m = 30 * dpr;
    this.fitS = Math.min((c.width - 2 * m) / this.area.x, (c.height - 2 * m) / this.area.y);
    if (!this.zoomed || !center) this.fitTo(null);
    else {
      this.s *= ratio;
      this.ox = c.width / 2 - center[0] * this.s;
      this.oy = c.height / 2 + center[1] * this.s;
    }
    this.redraw();
  }

  /** Enquadra um retângulo em mm (null = mesa inteira). */
  fitTo(b: { minX: number; minY: number; maxX: number; maxY: number } | null, markZoomed = false): void {
    const c = this.canvas;
    const m = 30 * this.dpr;
    const x0 = b ? b.minX : 0;
    const y0 = b ? b.minY : 0;
    const w = Math.max(5, b ? b.maxX - b.minX : this.area.x);
    const h = Math.max(5, b ? b.maxY - b.minY : this.area.y);
    this.s = Math.min(this.fitS * 120, (c.width - 2 * m) / w, (c.height - 2 * m) / h);
    this.ox = c.width / 2 - (x0 + w / 2) * this.s;
    this.oy = c.height / 2 + (y0 + h / 2) * this.s;
    this.zoomed = markZoomed;
    this.redraw();
  }

  zoomAt(px: number, py: number, factor: number): void {
    const [mx, my] = this.toMm(px, py);
    this.s = Math.max(this.fitS * 0.5, Math.min(this.fitS * 120, this.s * factor));
    this.ox = px - mx * this.s;
    this.oy = py + my * this.s;
    this.zoomed = true;
    this.redraw();
  }

  zoomCenter(factor: number): void {
    this.zoomAt(this.canvas.width / 2, this.canvas.height / 2, factor);
  }

  polyline(pts: readonly Point[]): void {
    const ctx = this.ctx;
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(this.X(p[0]), this.Y(p[1])) : ctx.moveTo(this.X(p[0]), this.Y(p[1]))));
  }

  /** Fundo, área útil, grade e régua. */
  drawBed(): void {
    const { ctx, canvas: c, area } = this;
    const d = this.dpr;
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.fillStyle = "#101216";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.fillStyle = "#14171c";
    ctx.fillRect(this.X(0), this.Y(area.y), area.x * this.s, area.y * this.s);
    const [vx0, vy0] = this.toMm(0, c.height);
    const [vx1, vy1] = this.toMm(c.width, 0);
    const gx0 = Math.max(0, vx0);
    const gx1 = Math.min(area.x, vx1);
    const gy0 = Math.max(0, vy0);
    const gy1 = Math.min(area.y, vy1);
    const minor = [0.5, 1, 5, 10].find((st) => st * this.s >= 9 * d) ?? 10;
    const major = minor === 0.5 ? 5 : minor === 10 ? 50 : minor * 10;
    const isMajor = (v: number): boolean => Math.abs(v / major - Math.round(v / major)) < 1e-6;
    ctx.lineWidth = 1;
    if (gx1 > gx0 && gy1 > gy0) {
      for (let x = Math.ceil(gx0 / minor) * minor; x <= gx1 + 1e-9; x += minor) {
        ctx.strokeStyle = isMajor(x) ? "#2c323a" : "#1f2329";
        ctx.beginPath();
        ctx.moveTo(this.X(x), this.Y(gy0));
        ctx.lineTo(this.X(x), this.Y(gy1));
        ctx.stroke();
      }
      for (let y = Math.ceil(gy0 / minor) * minor; y <= gy1 + 1e-9; y += minor) {
        ctx.strokeStyle = isMajor(y) ? "#2c323a" : "#1f2329";
        ctx.beginPath();
        ctx.moveTo(this.X(gx0), this.Y(y));
        ctx.lineTo(this.X(gx1), this.Y(y));
        ctx.stroke();
      }
    }
    ctx.strokeStyle = "#3c4043";
    ctx.strokeRect(this.X(0), this.Y(area.y), area.x * this.s, area.y * this.s);
    const lab = [1, 2, 5, 10, 25, 50, 100].find((st) => st * this.s >= 46 * d) ?? 100;
    ctx.fillStyle = "#9aa0a6";
    ctx.font = `${11 * d}px ui-monospace, monospace`;
    const ly = Math.min(c.height - 5 * d, this.Y(0) + 14 * d);
    const lx = Math.max(30 * d, this.X(0) - 4 * d);
    const fmt = (n: number): string => (Math.abs(n - Math.round(n)) < 1e-6 ? String(Math.round(n)) : n.toFixed(1));
    ctx.textAlign = "center";
    for (let x = Math.ceil(gx0 / lab) * lab; x <= gx1 + 1e-9; x += lab) ctx.fillText(fmt(x), this.X(x), ly);
    ctx.textAlign = "right";
    for (let y = Math.ceil(Math.max(gy0, lab * 0.5) / lab) * lab; y <= gy1 + 1e-9; y += lab) ctx.fillText(fmt(y), lx, this.Y(y) + 4 * d);
    ctx.textAlign = "left";
    if (this.X(0) > 0 && this.Y(0) < c.height) ctx.fillText("origem", this.X(0) + 4 * d, this.Y(0) - 5 * d);
  }

  /** Cabeçote: mira azul; laranja com o laser aceso. */
  drawHead(p: Point, lit: boolean): void {
    const { ctx } = this;
    const d = this.dpr;
    const hx = this.X(p[0]);
    const hy = this.Y(p[1]);
    ctx.strokeStyle = lit ? "#ffb84d" : "#8ab4f8";
    ctx.lineWidth = 1.5 * d;
    ctx.beginPath();
    ctx.arc(hx, hy, 7 * d, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(hx - 11 * d, hy);
    ctx.lineTo(hx + 11 * d, hy);
    ctx.moveTo(hx, hy - 11 * d);
    ctx.lineTo(hx, hy + 11 * d);
    ctx.stroke();
    if (lit) {
      ctx.fillStyle = "rgba(255,184,77,.85)";
      ctx.beginPath();
      ctx.arc(hx, hy, 2.5 * d, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private local(e: PointerEvent | WheelEvent | MouseEvent): Point {
    const r = this.canvas.getBoundingClientRect();
    return [(e.clientX - r.left) * this.dpr, (e.clientY - r.top) * this.dpr];
  }

  private attach(): void {
    const c = this.canvas;
    c.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
        const k = e.ctrlKey ? 0.01 : 0.0015; // pinça no touchpad chega como roda com Ctrl
        const [px, py] = this.local(e);
        this.zoomAt(px, py, Math.exp(-e.deltaY * unit * k));
      },
      { passive: false },
    );
    c.addEventListener("pointerdown", (e) => {
      c.setPointerCapture(e.pointerId);
      const p = this.local(e);
      this.pointers.set(e.pointerId, p);
      if (this.pointers.size === 1) {
        this.drag = { p, moved: false, object: this.interactions.onDragStart?.(p) ?? false };
      } else if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()] as [Point, Point];
        this.pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] };
        this.drag = null;
      }
    });
    c.addEventListener("pointermove", (e) => {
      if (!this.pointers.has(e.pointerId)) return;
      const p = this.local(e);
      this.pointers.set(e.pointerId, p);
      if (this.pinch && this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()] as [Point, Point];
        const d2 = Math.hypot(a[0] - b[0], a[1] - b[1]);
        const mid: Point = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        this.ox += mid[0] - this.pinch.mid[0];
        this.oy += mid[1] - this.pinch.mid[1];
        if (this.pinch.d > 0) this.zoomAt(mid[0], mid[1], d2 / this.pinch.d);
        this.pinch = { d: d2, mid };
        return;
      }
      const drag = this.drag;
      if (!drag) return;
      const dx = p[0] - drag.p[0];
      const dy = p[1] - drag.p[1];
      if (!drag.moved && Math.hypot(dx, dy) < 5 * this.dpr) return;
      drag.moved = true;
      drag.p = p;
      if (drag.object) {
        this.interactions.onDragMove?.(dx / this.s, -dy / this.s);
        return;
      }
      c.classList.add("panning");
      this.ox += dx;
      this.oy += dy;
      this.zoomed = true;
      this.redraw();
    });
    const end = (e: PointerEvent): void => {
      if (!this.pointers.has(e.pointerId)) return;
      const drag = this.drag;
      const tap = drag && !drag.moved && this.pointers.size === 1 && e.type === "pointerup";
      this.pointers.delete(e.pointerId);
      if (this.pointers.size < 2) this.pinch = null;
      if (this.pointers.size === 0) {
        this.drag = null;
        c.classList.remove("panning");
      }
      if (tap) this.interactions.onTap?.(this.local(e), e);
      if (drag?.moved && drag.object) this.interactions.onDragEnd?.();
    };
    c.addEventListener("pointerup", end);
    c.addEventListener("pointercancel", end);
    c.addEventListener("dblclick", () => this.interactions.onDoubleClick?.());
  }
}
