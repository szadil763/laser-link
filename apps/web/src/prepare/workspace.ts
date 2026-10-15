import {
  boundsOf,
  boxDesign,
  carDesign,
  DEFAULT_BOX,
  DEFAULT_CAR,
  DEFAULT_OTTO,
  ottoDesign,
  DEFAULT_MATRIX,
  designToSvg,
  generateGcode,
  matrixTest,
  offsetPath,
  parseGcode,
  pointInPolygon,
  segmentSeconds,
  textToPaths,
  type Bounds,
  type GenerateResult,
  type Point,
  type Segment,
  type VectorMode,
} from "@laserlink/gcode";
import { DEFAULT_MATERIALS, type AgentLimits, type ClientMessage, type Material, type MaterialMode, type MaterialPreset } from "@laserlink/shared";
import { BedView } from "../bed-view.js";
import { importImage, importSvg } from "./importers.js";
import {
  History,
  MODE_INFO,
  MODES,
  designBounds,
  effectiveMode,
  makeLayer,
  makeShape,
  newId,
  presetFor,
  rebuildImage,
  toJobDesign,
  type ImageItem,
  type Layer,
  type Shape,
} from "./model.js";
import { sampleDesign } from "./sample.js";

export interface PrepareHost {
  confirm(title: string, text: string, okLabel: string, danger?: boolean): Promise<boolean>;
  toast(message: string): void;
  send(msg: ClientMessage): boolean;
  isConnected(): boolean;
  /** Trabalho enviado: a interface mostra a aba Controle com a pré-visualização. */
  onJobSent(name: string, gcode: string): void;
}

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Elemento #${id} não encontrado`);
  return el as T;
};
const EXEC_ORDER: readonly VectorMode[] = ["detail", "fill", "line", "cut"];
const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const fmtTime = (sec: number): string => {
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h ? `${h} h ${m} min` : m ? `${m} min ${String(r).padStart(2, "0")} s` : `${r} s`;
};

interface Anim {
  segments: Segment[];
  cumulative: number[];
  total: number;
  t: number;
  speedup: number;
  last: number;
  label: string;
}

export class Workspace {
  private layers: Layer[] = [];
  private image: ImageItem | null = null;
  private designName = "";
  private readonly selected = new Set<string>();
  private readonly history = new History();
  private multi = false;
  private showTravel = true;
  private frameMode: "off" | "min" = "off";
  private lockRatio = true;
  private limits: AgentLimits = { maxSpindle: 1000, workArea: { x: 400, y: 400 }, framePower: 10, frameFeed: 3000 };
  private haveLimits = false;
  private materials: Material[] = structuredClone(DEFAULT_MATERIALS);
  private result: GenerateResult | null = null;
  private resultError: string | null = null;
  private segments: Segment[] = [];
  private genTimer: number | undefined;
  private anim: Anim | null = null;
  private head: Point = [0, 0];
  private headLive = false;
  private readonly view: BedView;

  constructor(private readonly host: PrepareHost) {
    this.view = new BedView($<HTMLCanvasElement>("p-canvas"), this.limits.workArea, () => this.requestDraw(), {
      onTap: (px, ev) => this.pick(px, ev),
      onDragStart: (px) => {
        if (this.anim) return false;
        const hit = this.hitTest(px);
        if (hit && this.selected.has(hit.id)) {
          this.history.push(this.layers);
          return true;
        }
        return false;
      },
      onDragMove: (dx, dy) => {
        for (const { s } of this.selItems()) s.points = s.points.map(([x, y]) => [x + dx, y + dy] as Point);
        this.draw();
      },
      onDragEnd: () => this.refresh(),
      onDoubleClick: () => this.fitPiece(),
    });
    this.bind();
    this.refresh();
  }

  // ---------- dados vindos do agente ----------

  setLimits(limits: AgentLimits): void {
    this.limits = limits;
    this.haveLimits = true;
    this.view.setArea(limits.workArea);
    $("p-frame-min").textContent = `Potência mínima (${((limits.framePower / limits.maxSpindle) * 100).toFixed(1).replace(/\.0$/, "")}%)`;
    this.refresh();
  }

  setMaterials(list: Material[]): void {
    this.materials = list;
    this.renderLayers();
  }

  /** Posição real do cabeçote (status do GRBL), mostrada quando não há simulação. */
  setHead(p: Point): void {
    this.head = p;
    this.headLive = true;
    if (!this.anim && !$("view-prepare").hidden) this.requestDraw();
  }

  private drawQueued = false;
  private requestDraw(): void {
    if (this.drawQueued) return;
    this.drawQueued = true;
    requestAnimationFrame(() => {
      this.drawQueued = false;
      this.draw();
    });
  }

  // ---------- desenho do projeto ----------

  private material(id: string | null): Material | undefined {
    return this.materials.find((m) => m.id === id);
  }

  private resetDesign(name: string): void {
    this.stopAnim();
    this.layers = [];
    this.image = null;
    this.selected.clear();
    this.history.clear();
    this.designName = name;
  }

  private loadSample(): void {
    this.resetDesign("Chassi do carrinho RC (exemplo)");
    const d = sampleDesign(this.materials[0]);
    this.layers = d.layers;
    this.image = d.image;
    this.view.fitTo(null);
    this.refresh();
  }

  private loadMatrix(): void {
    const num = (id: string): number => Number($<HTMLInputElement>(id).value);
    const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));
    const design = matrixTest({
      ...DEFAULT_MATRIX,
      powerFrom: clamp(num("mx-p0"), 1, 100),
      powerTo: clamp(num("mx-p1"), 1, 100),
      speedFrom: Math.max(10, num("mx-s0")),
      speedTo: Math.max(10, num("mx-s1")),
      rows: clamp(Math.round(num("mx-rows")), 2, 10),
      cols: clamp(Math.round(num("mx-cols")), 2, 10),
      size: clamp(num("mx-size"), 3, 30),
    });
    this.resetDesign(design.name);
    design.vectors.forEach((g, i) => {
      const isLabel = g.mode === "line";
      const layer = makeLayer(g.name, isLabel ? "#4da3ff" : `hsl(${30 + (i % 9) * 18}, 70%, 58%)`, g.mode, undefined);
      layer.materialId = null;
      layer.settings[g.mode] = { ...g.settings };
      const group = newId("G");
      for (const p of g.paths) {
        const s = makeShape(p.points.slice(), isLabel ? "Rótulo" : g.name, p.closed);
        if (isLabel) s.group = group;
        layer.shapes.push(s);
      }
      this.layers.push(layer);
    });
    this.view.fitTo(null);
    this.refresh();
    this.host.toast("Matriz gerada: cada quadrado é uma camada com sua potência e velocidade.");
  }

  /** Gera a caixa com encaixes a partir do diálogo; devolve a mensagem de erro, se houver. */
  private loadBox(): string | null {
    const num = (id: string): number => Number($<HTMLInputElement>(id).value);
    const mat = this.material($<HTMLSelectElement>("bx-material").value || null);
    const cut = presetFor(mat, "cut");
    cut.kerf = Math.max(0, num("bx-kerf"));
    const area = this.limits.workArea;
    let design: ReturnType<typeof boxDesign>;
    try {
      design = boxDesign({
        ...DEFAULT_BOX,
        width: num("bx-w"),
        depth: num("bx-d"),
        height: num("bx-h"),
        measure: $<HTMLSelectElement>("bx-measure").value === "inside" ? "inside" : "outside",
        thickness: num("bx-t"),
        finger: num("bx-f"),
        lid: $<HTMLInputElement>("bx-lid").checked,
        labels: $<HTMLInputElement>("bx-labels").checked,
        maxRowWidth: area.x - 20,
        cut,
        label: presetFor(mat, "line"),
      });
    } catch (err) {
      return (err as Error).message;
    }
    this.resetDesign(design.name);
    for (const g of design.vectors) {
      const isCut = g.mode === "cut";
      const layer = makeLayer(isCut ? "Peças" : "Nomes", isCut ? "#ff5c5c" : "#4da3ff", g.mode, mat);
      layer.settings[g.mode] = { ...g.settings };
      if (isCut) {
        g.paths.forEach((p, i) => layer.shapes.push(makeShape(p.points.slice(), design.panels[i]?.name ?? `Peça ${i + 1}`, true)));
      } else {
        const group = newId("G");
        for (const p of g.paths) {
          const sh = makeShape(p.points.slice(), "Nomes das peças", p.closed);
          sh.group = group;
          layer.shapes.push(sh);
        }
      }
      this.layers.push(layer);
    }
    this.view.fitTo(null);
    this.refresh();
    const b = designBounds(this.layers, null);
    const fits = !!b && b.maxX <= area.x && b.maxY <= area.y;
    this.host.toast(
      fits
        ? `${design.panels.length} peças geradas. Confira o kerf com um teste antes de cortar a caixa inteira.`
        : "As peças não cabem todas na mesa: reduza a caixa ou corte em duas vezes (desligue peças na lista).",
    );
    return null;
  }

  private openBox(): void {
    const dlg = $<HTMLDialogElement>("dlg-box");
    const sel = $<HTMLSelectElement>("bx-material");
    sel.innerHTML = this.materials.map((m) => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join("");
    const syncMaterial = (): void => {
      const mat = this.material(sel.value || null);
      if (!mat) return;
      $<HTMLInputElement>("bx-t").value = String(mat.thickness || 3);
      $<HTMLInputElement>("bx-kerf").value = String(presetFor(mat, "cut").kerf ?? 0.15);
    };
    sel.onchange = syncMaterial;
    syncMaterial();
    $("bx-error").textContent = "";
    const onClose = (): void => {
      if (dlg.returnValue !== "ok") return;
      const err = this.loadBox();
      if (err) {
        // reabre com o motivo, sem perder o que foi digitado
        $("bx-error").textContent = err;
        dlg.returnValue = "";
        dlg.addEventListener("close", onClose, { once: true });
        dlg.showModal();
      }
    };
    dlg.addEventListener("close", onClose, { once: true });
    dlg.returnValue = "";
    dlg.showModal();
  }

  /** Peças educacionais: carrinho ou robô bípede. Devolve a mensagem de erro, se houver. */
  private loadParts(): string | null {
    const num = (id: string): number => Number($<HTMLInputElement>(id).value);
    const mat = this.material($<HTMLSelectElement>("pt-material").value || null);
    const cut = presetFor(mat, "cut");
    cut.kerf = Math.max(0, num("pt-kerf"));
    const engrave = presetFor(mat, "line");
    const t = num("pt-t");
    const area = this.limits.workArea;
    const common = { x: 10, y: 10, gap: 5, maxRowWidth: area.x - 20, cut, engrave, thickness: t };
    let design: ReturnType<typeof carDesign>;
    try {
      if ($<HTMLSelectElement>("pt-kind").value === "otto") {
        design = ottoDesign({
          ...DEFAULT_OTTO,
          ...common,
          body: { ...DEFAULT_OTTO.body, width: num("ot-w"), depth: num("ot-d"), height: num("ot-h") },
          legHeight: num("ot-leg"),
          sensor: { spacing: num("ot-ss"), holeD: num("ot-sd") },
        });
      } else {
        design = carDesign({
          ...DEFAULT_CAR,
          ...common,
          length: num("car-l"),
          width: num("car-w"),
          label: $<HTMLInputElement>("car-label").value,
          motor: { ...DEFAULT_CAR.motor, thickness: num("car-mt"), axleFromEnd: num("car-axle"), axleToFirstHole: num("car-h1"), holeSpacing: num("car-hs") },
          board: { ...DEFAULT_CAR.board, holesX: num("car-bx"), holesY: num("car-by") },
          caster: { ...DEFAULT_CAR.caster, holeSpacing: num("car-cs") },
        });
      }
    } catch (err) {
      return (err as Error).message;
    }
    this.resetDesign(design.name);
    const groups = new Map<string, string>();
    const groupOf = (owner: string): string => {
      if (!groups.has(owner)) groups.set(owner, newId("G"));
      return groups.get(owner)!;
    };
    for (const g of design.vectors) {
      const isCut = g.mode === "cut";
      const owners = isCut ? design.cutOwners : design.engraveOwners;
      const layer = makeLayer(isCut ? "Peças" : "Gravações", isCut ? "#ff5c5c" : "#4da3ff", g.mode, mat);
      layer.settings[g.mode] = { ...g.settings };
      const isHole = new Map<string, number>();
      g.paths.forEach((p, i) => {
        const owner = owners[i] ?? `Peça ${i + 1}`;
        // nos cortes, os caminhos de cada peça vêm como furos… e por último o contorno
        const next = owners[i + 1];
        const label = isCut ? (next === owner ? `${owner}: furo ${(isHole.get(owner) ?? 0) + 1}` : owner) : `${owner}: gravação`;
        if (isCut && next === owner) isHole.set(owner, (isHole.get(owner) ?? 0) + 1);
        const sh = makeShape(p.points.slice(), label, p.closed);
        sh.group = groupOf(owner);
        layer.shapes.push(sh);
      });
      this.layers.push(layer);
    }
    this.view.fitTo(null);
    this.refresh();
    const b = designBounds(this.layers, null);
    const fits = !!b && b.maxX <= area.x && b.maxY <= area.y;
    this.host.toast(
      fits
        ? `${design.placed.length} peças geradas. Tocar numa peça seleciona ela inteira, com os furos.`
        : "As peças não cabem todas na mesa: corte em duas vezes (desligue peças) ou use uma mesa maior.",
    );
    return null;
  }

  private openParts(): void {
    const dlg = $<HTMLDialogElement>("dlg-parts");
    const sel = $<HTMLSelectElement>("pt-material");
    sel.innerHTML = this.materials.map((m) => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join("");
    const syncMaterial = (): void => {
      const mat = this.material(sel.value || null);
      if (!mat) return;
      $<HTMLInputElement>("pt-t").value = String(mat.thickness || 3);
      $<HTMLInputElement>("pt-kerf").value = String(presetFor(mat, "cut").kerf ?? 0.15);
    };
    const syncKind = (): void => {
      const otto = $<HTMLSelectElement>("pt-kind").value === "otto";
      $("pt-car").hidden = otto;
      $("pt-otto").hidden = !otto;
    };
    sel.onchange = syncMaterial;
    $<HTMLSelectElement>("pt-kind").onchange = syncKind;
    syncMaterial();
    syncKind();
    $("pt-error").textContent = "";
    const onClose = (): void => {
      if (dlg.returnValue !== "ok") return;
      const err = this.loadParts();
      if (err) {
        $("pt-error").textContent = err;
        dlg.returnValue = "";
        dlg.addEventListener("close", onClose, { once: true });
        dlg.showModal();
      }
    };
    dlg.addEventListener("close", onClose, { once: true });
    dlg.returnValue = "";
    dlg.showModal();
  }

  /** Baixa um arquivo gerado no navegador. */
  private download(name: string, content: string, type: string): void {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  private fileBase(): string {
    return (this.designName || "trabalho").replace(/\.(svg|png|jpe?g|gcode)$/i, "").replace(/×/g, "x").replace(/[^\p{L}\p{N}._ -]+/gu, "").trim().replace(/\s+/g, "-") || "trabalho";
  }

  private exportSvg(): void {
    const design = toJobDesign(this.designName || "Trabalho", this.layers, null);
    if (!design.vectors.length) return this.host.toast("Não há vetores para exportar (a imagem não vai para o SVG).");
    this.download(`${this.fileBase()}.svg`, designToSvg(design), "image/svg+xml");
    if (this.image?.enabled) this.host.toast("SVG baixado. A imagem não entra no SVG; use Baixar G-code para levá-la junto.");
  }

  private exportGcode(): void {
    const r = this.regenerateNow();
    if (!r) return this.host.toast("Nada para exportar.");
    this.download(`${this.fileBase()}.gcode`, r.gcode, "text/plain");
  }

  private addText(): void {
    const text = $<HTMLInputElement>("tx-text").value.trim();
    if (!text) return;
    const height = Math.max(1, Number($<HTMLInputElement>("tx-height").value));
    const x = Number($<HTMLInputElement>("tx-x").value);
    const y = Number($<HTMLInputElement>("tx-y").value);
    let layer = this.layers.find((l) => l.name === "Texto");
    if (!layer) {
      layer = makeLayer("Texto", "#4da3ff", "line", this.materials[0]);
      this.layers.push(layer);
    }
    this.history.push(this.layers);
    const group = newId("G");
    const label = text.length > 24 ? `${text.slice(0, 24)}…` : text;
    this.selected.clear();
    for (const p of textToPaths(text, { height, x, y })) {
      const s = makeShape(p.points, `Texto “${label}”`, p.closed);
      s.group = group;
      layer.shapes.push(s);
      this.selected.add(s.id);
    }
    if (!this.designName) this.designName = "Texto";
    this.refresh();
    this.host.toast("Texto adicionado e selecionado: arraste ou use os campos para posicionar.");
  }

  private async handleFile(file: File | undefined): Promise<void> {
    if (!file) return;
    try {
      if (/\.svg$/i.test(file.name) || file.type === "image/svg+xml") {
        const { layers, count } = importSvg(await file.text(), this.materials);
        this.resetDesign(file.name);
        this.layers = layers;
        this.view.fitTo(null);
        this.refresh();
        this.host.toast(`${file.name}: ${count} elementos em ${layers.length} camada(s) por cor. Toque num elemento para mudar a operação dele.`);
      } else if (/^image\/(png|jpeg)$/.test(file.type) || /\.(png|jpe?g)$/i.test(file.name)) {
        const mat = this.materials[0];
        const img = await importImage(file, mat, presetFor(mat, "raster"));
        this.stopAnim();
        this.image = img;
        if (!this.designName) this.designName = file.name;
        this.refresh();
        this.host.toast(`${file.name}: ${img.w} × ${img.h} mm, ${img.res} linhas/mm. Ajuste posição e tamanho no cartão da imagem.`);
      } else {
        this.host.toast("Formato não suportado. Use SVG, PNG ou JPG.");
      }
    } catch (err) {
      this.host.toast((err as Error).message);
    }
  }

  // ---------- seleção e edição ----------

  private findShape(id: string): { s: Shape; l: Layer } | null {
    for (const l of this.layers) for (const s of l.shapes) if (s.id === id) return { s, l };
    return null;
  }

  private selItems(): Array<{ s: Shape; l: Layer }> {
    return [...this.selected].map((id) => this.findShape(id)).filter((x): x is { s: Shape; l: Layer } => x !== null);
  }

  private selBounds(): Bounds | null {
    return boundsOf(this.selItems().flatMap(({ s }) => s.points));
  }

  /** Seleciona (com o grupo: as letras de um texto andam juntas). */
  private select(id: string, add: boolean): void {
    const found = this.findShape(id);
    if (!found) return;
    const ids = found.s.group ? found.l.shapes.filter((x) => x.group === found.s.group).map((x) => x.id) : [id];
    const already = ids.every((x) => this.selected.has(x));
    if (!add) {
      const only = already && this.selected.size === ids.length;
      this.selected.clear();
      if (!only) ids.forEach((x) => this.selected.add(x));
    } else if (already) ids.forEach((x) => this.selected.delete(x));
    else ids.forEach((x) => this.selected.add(x));
    this.refresh();
  }

  private hitTest(px: Point): Shape | null {
    const p = this.view.toMm(px[0], px[1]);
    const tol = (10 * this.view.dpr) / this.view.s;
    let best: Shape | null = null;
    let bestD = tol;
    let inside: Shape | null = null;
    let insideArea = Infinity;
    for (const l of this.layers) {
      if (!l.enabled) continue;
      for (const s of l.shapes) {
        const pts = s.points;
        for (let i = 1; i < pts.length; i++) {
          const d = segDist(p, pts[i - 1]!, pts[i]!);
          if (d < bestD) {
            bestD = d;
            best = s;
          }
        }
        if (s.closed && pointInPolygon(p, pts)) {
          const b = boundsOf(pts)!;
          const a = (b.maxX - b.minX) * (b.maxY - b.minY);
          if (a < insideArea) {
            insideArea = a;
            inside = s;
          }
        }
      }
    }
    return best ?? inside;
  }

  private pick(px: Point, ev: PointerEvent): void {
    if (this.anim) return;
    const hit = this.hitTest(px);
    if (hit) this.select(hit.id, this.multi || ev.shiftKey || ev.ctrlKey || ev.metaKey);
    else if (this.selected.size) {
      this.selected.clear();
      this.refresh();
    }
  }

  private transform(fn: (p: Point) => Point): void {
    const items = this.selItems();
    if (!items.length) return;
    this.history.push(this.layers);
    for (const { s } of items) s.points = s.points.map(fn);
    this.refresh();
  }

  private moveSel(dx: number, dy: number): void {
    this.transform(([x, y]) => [x + dx, y + dy]);
  }

  private rotateSel(deg: number): void {
    const b = this.selBounds();
    if (!b) return;
    const cx = (b.minX + b.maxX) / 2;
    const cy = (b.minY + b.maxY) / 2;
    const a = (deg * Math.PI) / 180;
    const c = Math.cos(a);
    const sn = Math.sin(a);
    this.transform(([x, y]) => [cx + (x - cx) * c - (y - cy) * sn, cy + (x - cx) * sn + (y - cy) * c]);
  }

  private scaleSel(sx: number, sy: number): void {
    const b = this.selBounds();
    if (!b) return;
    const cx = (b.minX + b.maxX) / 2;
    const cy = (b.minY + b.maxY) / 2;
    this.transform(([x, y]) => [cx + (x - cx) * sx, cy + (y - cy) * sy]);
  }

  private alignSel(how: string): void {
    const items = this.selItems();
    const all = this.selBounds();
    if (!items.length || !all) return;
    this.history.push(this.layers);
    const area = this.limits.workArea;
    // agrupa por grupo (texto) para alinhar o texto inteiro, não cada letra
    const units = new Map<string, Shape[]>();
    for (const { s } of items) {
      const key = s.group ?? s.id;
      units.set(key, [...(units.get(key) ?? []), s]);
    }
    const single = units.size === 1 || how === "table-center";
    const target: Bounds = single ? { minX: 0, minY: 0, maxX: area.x, maxY: area.y } : all;
    const shiftOf = (b: Bounds): Point => {
      let dx = 0;
      let dy = 0;
      if (how === "left") dx = target.minX - b.minX;
      if (how === "right") dx = target.maxX - b.maxX;
      if (how === "hcenter" || how === "table-center") dx = (target.minX + target.maxX) / 2 - (b.minX + b.maxX) / 2;
      if (how === "bottom") dy = target.minY - b.minY;
      if (how === "top") dy = target.maxY - b.maxY;
      if (how === "vcenter" || how === "table-center") dy = (target.minY + target.maxY) / 2 - (b.minY + b.maxY) / 2;
      return [dx, dy];
    };
    if (how === "table-center") {
      const [dx, dy] = shiftOf(all);
      for (const { s } of items) s.points = s.points.map(([x, y]) => [x + dx, y + dy] as Point);
    } else {
      for (const shapes of units.values()) {
        const [dx, dy] = shiftOf(boundsOf(shapes.flatMap((s) => s.points))!);
        for (const s of shapes) s.points = s.points.map(([x, y]) => [x + dx, y + dy] as Point);
      }
    }
    this.refresh();
  }

  private duplicateSel(): void {
    const items = this.selItems();
    if (!items.length) return;
    this.history.push(this.layers);
    const groups = new Map<string, string>();
    this.selected.clear();
    for (const { s, l } of items) {
      const copy = makeShape(s.points.map(([x, y]) => [x + 5, y - 5] as Point), `${s.name} (cópia)`, s.closed, s.mode);
      if (s.group) {
        if (!groups.has(s.group)) groups.set(s.group, newId("G"));
        copy.group = groups.get(s.group);
      }
      l.shapes.push(copy);
      this.selected.add(copy.id);
    }
    this.refresh();
    this.host.toast(`${items.length} elemento(s) duplicado(s) 5 mm ao lado.`);
  }

  private deleteSel(): void {
    const items = this.selItems();
    if (!items.length) return;
    this.history.push(this.layers);
    for (const { s, l } of items) l.shapes = l.shapes.filter((x) => x.id !== s.id);
    this.selected.clear();
    this.refresh();
    this.host.toast(`${items.length} elemento(s) excluído(s). Ctrl+Z desfaz.`);
  }

  /** Cria cópias deslocadas (offset) do contorno selecionado. */
  private offsetSel(distance: number): void {
    const items = this.selItems();
    if (!items.length || !distance) return;
    this.history.push(this.layers);
    let made = 0;
    this.selected.clear();
    for (const { s, l } of items) {
      for (const p of offsetPath({ points: s.points, closed: s.closed }, distance, "round")) {
        const copy = makeShape(p.points, `${s.name} (deslocado ${distance > 0 ? "+" : ""}${distance} mm)`, true, s.mode);
        l.shapes.push(copy);
        this.selected.add(copy.id);
        made++;
      }
    }
    this.refresh();
    this.host.toast(made ? `${made} contorno(s) deslocado(s) criado(s).` : "O contorno sumiu ao encolher. Use uma distância menor.");
  }

  private undo(): void {
    if (this.history.undo(this.layers)) {
      for (const id of [...this.selected]) if (!this.findShape(id)) this.selected.delete(id);
      this.refresh();
      this.host.toast("Desfeito.");
    } else this.host.toast("Nada para desfazer.");
  }

  // ---------- geração (com atraso para não travar enquanto edita) ----------

  private regenerateNow(): GenerateResult | null {
    window.clearTimeout(this.genTimer);
    try {
      const design = toJobDesign(this.designName || "Trabalho", this.layers, this.image);
      if (!design.vectors.length && !design.rasters.length) {
        this.result = null;
        this.segments = [];
      } else {
        this.result = generateGcode(design, { maxSpindle: this.limits.maxSpindle });
        this.segments = parseGcode(this.result.gcode).segments;
      }
      this.resultError = null;
    } catch (err) {
      this.result = null;
      this.segments = [];
      this.resultError = (err as Error).message;
    }
    this.renderSummary();
    this.draw();
    return this.result;
  }

  private scheduleGenerate(): void {
    window.clearTimeout(this.genTimer);
    this.genTimer = window.setTimeout(() => this.regenerateNow(), 150);
  }

  // ---------- painéis ----------

  private refresh(): void {
    $("p-empty").hidden = this.layers.some((l) => l.shapes.length) || !!this.image;
    this.renderSelection();
    this.renderLayers();
    this.renderLegend();
    this.scheduleGenerate();
    this.draw();
  }

  private modeButtons(current: VectorMode | null, extra = ""): string {
    return (
      MODES.map(
        (m) =>
          `<button type="button" data-mode="${m}" aria-pressed="${current === m}" style="--c:${MODE_INFO[m].color}"><span class="dot"></span>${MODE_INFO[m].label}</button>`,
      ).join("") + extra
    );
  }

  private materialOptions(selected: string | null): string {
    return (
      `<option value="" ${selected ? "" : "selected"}>Personalizado</option>` +
      this.materials.map((m) => `<option value="${esc(m.id)}" ${m.id === selected ? "selected" : ""}>${esc(m.name)}</option>`).join("")
    );
  }

  private describe(s: Shape): string {
    const b = boundsOf(s.points)!;
    return `${(b.maxX - b.minX).toFixed(1)} × ${(b.maxY - b.minY).toFixed(1)} mm${s.closed ? "" : ", aberto"}`;
  }

  private renderSelection(): void {
    const box = $("p-selection");
    const items = this.selItems();
    if (!items.length) {
      box.hidden = true;
      box.replaceChildren();
      return;
    }
    box.hidden = false;
    const b = this.selBounds()!;
    const modes = new Set(items.map(({ s, l }) => effectiveMode(s, l)));
    const current = modes.size === 1 ? [...modes][0]! : null;
    const anyOpen = items.some(({ s }) => !s.closed);
    const groups = new Set(items.map(({ s }) => s.group ?? s.id));
    const first = items[0]!;
    const title =
      groups.size === 1
        ? `<b>${esc(first.s.group ? first.s.name.replace(/: (furo \d+|gravação)$/, "") : first.s.name)}</b> <span class="muted">${(b.maxX - b.minX).toFixed(1)} × ${(b.maxY - b.minY).toFixed(1)} mm · camada ${esc(first.l.name)}</span>`
        : `<b>${items.length} elementos selecionados</b>`;
    box.innerHTML = `<p>${title}</p>
      <div class="label">Operação</div>
      <div class="seg" role="group" aria-label="Operação da seleção">${this.modeButtons(current, `<button type="button" data-mode="">Padrão da camada</button>`)}</div>
      ${anyOpen ? `<p class="note">Caminhos abertos não podem ser preenchidos: ficam como Gravar linha.</p>` : ""}
      <div class="edit">
        <div class="label">Editar · arraste na mesa ou use as setas (Shift = 10 mm)</div>
        <div class="fields">
          <label class="field">X <span class="val"><input type="number" step="0.1" id="ed-x" value="${b.minX.toFixed(1)}"><span class="unit">mm</span></span></label>
          <label class="field">Y <span class="val"><input type="number" step="0.1" id="ed-y" value="${b.minY.toFixed(1)}"><span class="unit">mm</span></span></label>
          <label class="field">Largura <span class="val"><input type="number" step="0.1" min="0.1" id="ed-w" value="${(b.maxX - b.minX).toFixed(1)}"><span class="unit">mm</span></span></label>
          <label class="field">Altura <span class="val"><input type="number" step="0.1" min="0.1" id="ed-h" value="${(b.maxY - b.minY).toFixed(1)}"><span class="unit">mm</span></span></label>
        </div>
        <div class="row">
          <button type="button" id="ed-lock" aria-pressed="${this.lockRatio}">${this.lockRatio ? "Proporção travada" : "Proporção livre"}</button>
          <label class="field" style="flex:1 1 150px">Girar <span class="val"><input type="number" step="1" id="ed-angle" value="15"><span class="unit">graus</span><button type="button" id="ed-rot">Girar</button></span></label>
        </div>
        <div class="seg" role="group" aria-label="Transformar">
          <button type="button" id="ed-rl" title="Girar 90° anti-horário">↺ 90°</button>
          <button type="button" id="ed-rr" title="Girar 90° horário">↻ 90°</button>
          <button type="button" id="ed-fh">Espelhar ↔</button>
          <button type="button" id="ed-fv">Espelhar ↕</button>
        </div>
        <div class="label">${groups.size > 1 ? "Alinhar entre si" : "Alinhar na mesa"}</div>
        <div class="seg" role="group" aria-label="Alinhar">
          <button type="button" data-align="left">Esquerda</button>
          <button type="button" data-align="hcenter">Centro ↔</button>
          <button type="button" data-align="right">Direita</button>
          <button type="button" data-align="top">Topo</button>
          <button type="button" data-align="vcenter">Centro ↕</button>
          <button type="button" data-align="bottom">Base</button>
          ${groups.size > 1 ? `<button type="button" data-align="table-center">Centralizar grupo na mesa</button>` : ""}
        </div>
        <div class="row">
          <label class="field" style="flex:1 1 150px">Contorno deslocado <span class="val"><input type="number" step="0.1" id="ed-off" value="2"><span class="unit">mm</span><button type="button" id="ed-off-go">Criar</button></span></label>
        </div>
        <p class="note">Contorno deslocado cria uma cópia do contorno afastada para fora (valor positivo) ou para dentro (negativo).</p>
        <div class="row">
          <button type="button" id="ed-dup">Duplicar</button>
          <button type="button" id="ed-del">Excluir</button>
          <button type="button" id="ed-undo" ${this.history.canUndo ? "" : "disabled"}>Desfazer</button>
          <button type="button" id="ed-clear">Limpar seleção</button>
        </div>
      </div>`;
    const num = (id: string): number => Number($<HTMLInputElement>(id).value);
    box.querySelectorAll<HTMLButtonElement>("button[data-mode]").forEach((btn) =>
      btn.addEventListener("click", () => {
        for (const { s } of items) s.mode = (btn.dataset.mode as VectorMode | "") || null;
        this.refresh();
      }),
    );
    $("ed-x").addEventListener("change", () => this.moveSel(num("ed-x") - b.minX, 0));
    $("ed-y").addEventListener("change", () => this.moveSel(0, num("ed-y") - b.minY));
    $("ed-w").addEventListener("change", () => {
      const k = num("ed-w") / Math.max(1e-6, b.maxX - b.minX);
      if (k > 0) this.scaleSel(k, this.lockRatio ? k : 1);
    });
    $("ed-h").addEventListener("change", () => {
      const k = num("ed-h") / Math.max(1e-6, b.maxY - b.minY);
      if (k > 0) this.scaleSel(this.lockRatio ? k : 1, k);
    });
    $("ed-lock").addEventListener("click", () => {
      this.lockRatio = !this.lockRatio;
      this.renderSelection();
    });
    $("ed-rot").addEventListener("click", () => this.rotateSel(-num("ed-angle")));
    $("ed-rl").addEventListener("click", () => this.rotateSel(90));
    $("ed-rr").addEventListener("click", () => this.rotateSel(-90));
    $("ed-fh").addEventListener("click", () => this.scaleSel(-1, 1));
    $("ed-fv").addEventListener("click", () => this.scaleSel(1, -1));
    box.querySelectorAll<HTMLButtonElement>("[data-align]").forEach((btn) => btn.addEventListener("click", () => this.alignSel(btn.dataset.align ?? "")));
    $("ed-off-go").addEventListener("click", () => this.offsetSel(num("ed-off")));
    $("ed-dup").addEventListener("click", () => this.duplicateSel());
    $("ed-del").addEventListener("click", () => this.deleteSel());
    $("ed-undo").addEventListener("click", () => this.undo());
    $("ed-clear").addEventListener("click", () => {
      this.selected.clear();
      this.refresh();
    });
  }

  private settingRow(l: Layer, mode: VectorMode, count: number): string {
    const s = l.settings[mode];
    const extra =
      mode === "cut"
        ? `<label class="field">Kerf <span class="val"><input type="number" min="0" max="1" step="0.01" value="${s.kerf ?? 0}" data-k="kerf"><span class="unit">mm</span></span></label>`
        : mode === "fill" || mode === "detail"
          ? `<label class="field">Intervalo <span class="val"><input type="number" min="0.03" max="1" step="0.01" value="${s.interval ?? 0.2}" data-k="interval"><span class="unit">mm</span></span></label>`
          : "";
    return `<div class="setrow" style="--c:${MODE_INFO[mode].color}" data-set="${mode}">
      <div class="setrow-title">${MODE_INFO[mode].label}<small>${count} elemento(s) · ${MODE_INFO[mode].hint}</small></div>
      <div class="fields">
        <label class="field">Velocidade <span class="val"><input type="number" min="10" step="10" value="${s.speed}" data-k="speed"><span class="unit">mm/min</span></span></label>
        <label class="field">Potência <span class="val"><input type="number" min="0" max="100" value="${s.power}" data-k="power"><span class="unit">%</span></span></label>
        <label class="field">Passes <span class="val"><input type="number" min="1" max="20" value="${s.passes}" data-k="passes"></span></label>
        ${extra}
      </div>
    </div>`;
  }

  private renderLayers(): void {
    const box = $("p-layers");
    box.replaceChildren();
    const make = (html: string): HTMLElement => {
      const t = document.createElement("template");
      t.innerHTML = html.trim();
      return t.content.firstElementChild as HTMLElement;
    };
    const img = this.image;
    if (img) {
      const el = make(`
        <div class="card" style="--c:${MODE_INFO.raster.color}" data-off="${!img.enabled}">
          <div class="card-head">
            <div class="card-title">Imagem <small>${esc(img.name)}</small></div>
            <div class="row"><button data-k="enabled" aria-pressed="${img.enabled}">${img.enabled ? "Ativa" : "Desligada"}</button><button data-k="remove">Remover</button></div>
          </div>
          <div class="fields">
            <label class="field">X <span class="val"><input type="number" step="0.5" value="${img.x}" data-k="x"><span class="unit">mm</span></span></label>
            <label class="field">Y <span class="val"><input type="number" step="0.5" value="${img.y}" data-k="y"><span class="unit">mm</span></span></label>
            <label class="field">Largura <span class="val"><input type="number" step="0.5" min="2" value="${img.w}" data-k="w"><span class="unit">mm</span></span></label>
            <label class="field">Altura <span class="val"><input type="number" value="${img.h.toFixed(1)}" disabled><span class="unit">mm</span></span></label>
          </div>
          <div class="seg" role="group" aria-label="Conversão da imagem">
            <button data-k="dither" data-v="floyd-steinberg" aria-pressed="${img.dither === "floyd-steinberg"}">Pontilhado (Floyd-Steinberg)</button>
            <button data-k="dither" data-v="threshold" aria-pressed="${img.dither === "threshold"}">Limiar</button>
          </div>
          <div class="fields">
            <label class="field">Material <select data-k="material">${this.materialOptions(img.materialId)}</select></label>
            <label class="field">Limiar <span class="val"><input type="range" min="20" max="235" value="${img.threshold}" data-k="threshold"><span class="unit">${img.threshold}</span></span></label>
            <label class="field">Resolução <span class="val"><input type="number" min="2" max="20" value="${img.res}" data-k="res"><span class="unit">linhas/mm</span></span></label>
            <label class="field">Velocidade <span class="val"><input type="number" min="100" step="100" value="${img.settings.speed}" data-k="speed"><span class="unit">mm/min</span></span></label>
            <label class="field">Potência <span class="val"><input type="number" min="0" max="100" value="${img.settings.power}" data-k="power"><span class="unit">%</span></span></label>
            <label class="field">Overscan <span class="val"><input type="number" min="0" max="15" step="0.5" value="${img.overscan}" data-k="overscan"><span class="unit">mm</span></span></label>
          </div>
          <div class="seg"><button data-k="bidir" aria-pressed="${img.bidirectional}">Varredura nos dois sentidos</button></div>
        </div>`);
      el.addEventListener("click", (e) => {
        const btn = (e.target as HTMLElement).closest("button");
        if (!btn) return;
        const k = btn.dataset.k;
        if (k === "enabled") img.enabled = !img.enabled;
        else if (k === "remove") this.image = null;
        else if (k === "dither") img.dither = btn.dataset.v === "threshold" ? "threshold" : "floyd-steinberg";
        else if (k === "bidir") img.bidirectional = !img.bidirectional;
        else return;
        if (this.image) rebuildImage(img);
        this.refresh();
      });
      el.addEventListener("change", (e) => {
        const t = e.target as HTMLInputElement | HTMLSelectElement;
        const k = t.dataset.k;
        if (!k) return;
        const v = Number(t.value);
        if (k === "material") {
          img.materialId = t.value || null;
          if (img.materialId) img.settings = presetFor(this.material(img.materialId), "raster");
        } else if (k === "speed" || k === "power") {
          img.settings[k] = v;
          img.materialId = null;
        } else if (k === "w" && v > 0) {
          img.h = (v * img.sourceHeight) / img.sourceWidth;
          img.w = v;
        } else if (k === "x" || k === "y" || k === "res" || k === "threshold" || k === "overscan") img[k] = v;
        if (k === "res" || k === "threshold" || k === "w") rebuildImage(img);
        this.refresh();
      });
      el.addEventListener("input", (e) => {
        const t = e.target as HTMLInputElement;
        if (t.dataset.k === "threshold" && t.nextElementSibling) t.nextElementSibling.textContent = t.value;
      });
      box.append(el);
    }
    for (const l of this.layers) {
      if (!l.shapes.length) continue;
      const counts = new Map<VectorMode, number>();
      for (const s of l.shapes) counts.set(effectiveMode(s, l), (counts.get(effectiveMode(s, l)) ?? 0) + 1);
      const overrides = l.shapes.filter((s) => s.mode && s.mode !== l.mode).length;
      const items = l.shapes
        .map(
          (s) => `
          <div class="item" data-id="${s.id}" data-sel="${this.selected.has(s.id)}">
            <span class="swatch" style="background:${MODE_INFO[effectiveMode(s, l)].color}"></span>
            <span class="name" title="${esc(s.name)} (${this.describe(s)})">${esc(s.name)} <span class="muted">${this.describe(s)}</span></span>
            <select aria-label="Operação de ${esc(s.name)}" data-shape="${s.id}">
              <option value="" ${s.mode ? "" : "selected"}>Padrão (${MODE_INFO[l.mode].label})</option>
              ${MODES.map((m) => `<option value="${m}" ${s.mode === m ? "selected" : ""} ${!s.closed && (m === "fill" || m === "detail") ? "disabled" : ""}>${MODE_INFO[m].label}</option>`).join("")}
            </select>
          </div>`,
        )
        .join("");
      const el = make(`
        <div class="card" style="--c:${l.color}" data-off="${!l.enabled}">
          <div class="card-head">
            <div class="card-title"><span class="swatch" style="background:${l.color}"></span>${esc(l.name)} <small>${l.shapes.length} elemento(s)${overrides ? ` · ${overrides} com operação própria` : ""}</small></div>
            <button data-k="enabled" aria-pressed="${l.enabled}">${l.enabled ? "Ativa" : "Desligada"}</button>
          </div>
          <div class="label">Operação padrão da camada</div>
          <div class="seg" role="group" aria-label="Operação padrão">${this.modeButtons(l.mode)}</div>
          <label class="field" style="font-size:13px">Material <select class="plain" data-k="material">${this.materialOptions(l.materialId)}</select></label>
          <div class="settings" style="display:grid;gap:8px">${EXEC_ORDER.filter((m) => counts.get(m)).map((m) => this.settingRow(l, m, counts.get(m)!)).join("")}</div>
          <details class="items" ${l.shapes.length <= 12 || l.shapes.some((s) => this.selected.has(s.id)) ? "open" : ""}>
            <summary>Elementos (${l.shapes.length}): escolha a operação de cada um</summary>
            <div class="item-list">${items}</div>
          </details>
        </div>`);
      el.addEventListener("click", (e) => {
        const target = e.target as HTMLElement;
        const btn = target.closest("button");
        if (btn?.dataset.k === "enabled") {
          l.enabled = !l.enabled;
          this.refresh();
          return;
        }
        if (btn?.dataset.mode) {
          l.mode = btn.dataset.mode as VectorMode;
          this.refresh();
          return;
        }
        const name = target.closest(".name");
        const id = name?.parentElement?.dataset.id;
        if (id) this.select(id, this.multi);
      });
      el.addEventListener("change", (e) => {
        const t = e.target as HTMLInputElement | HTMLSelectElement;
        if (t.dataset.shape) {
          const f = this.findShape(t.dataset.shape);
          if (f) f.s.mode = (t.value as VectorMode | "") || null;
          this.refresh();
          return;
        }
        if (t.dataset.k === "material") {
          l.materialId = t.value || null;
          const mat = this.material(l.materialId);
          if (mat) for (const m of MODES) l.settings[m] = presetFor(mat, m);
          this.refresh();
          return;
        }
        const row = t.closest<HTMLElement>("[data-set]");
        const k = t.dataset.k;
        if (row && (k === "speed" || k === "power" || k === "passes" || k === "kerf" || k === "interval")) {
          const mode = row.dataset.set as VectorMode;
          l.settings[mode][k] = Number(t.value);
          if (k !== "kerf" && k !== "interval") l.materialId = null;
          this.refresh();
        }
      });
      box.append(el);
    }
    if (!box.children.length) box.innerHTML = `<p class="note">Nenhum desenho ainda.</p>`;
  }

  private renderLegend(): void {
    const used = new Set<VectorMode | "raster">();
    if (this.image) used.add("raster");
    for (const l of this.layers) for (const s of l.shapes) used.add(effectiveMode(s, l));
    const order: Array<VectorMode | "raster"> = ["raster", ...EXEC_ORDER];
    $("p-legend").innerHTML =
      order
        .filter((m) => used.has(m))
        .map((m) => `<span style="--c:${MODE_INFO[m].color}">${MODE_INFO[m].label}</span>`)
        .join("") +
      `<span class="dash" style="--c:#6b7480">Deslocamento sem laser</span>` +
      (this.designName ? `<b>${esc(this.designName)}</b>` : "");
  }

  private renderSummary(): void {
    const r = this.result;
    const area = this.limits.workArea;
    const b = designBounds(this.layers, this.image);
    $("p-sum-size").textContent = b ? `${(b.maxX - b.minX).toFixed(0)} × ${(b.maxY - b.minY).toFixed(0)}` : "—";
    $("p-sum-time").textContent = r ? fmtTime(r.estimatedSeconds) : "—";
    $("p-sum-lines").textContent = r ? r.lines.toLocaleString("pt-BR") : "—";
    const out = !!b && (b.minX < -1e-6 || b.minY < -1e-6 || b.maxX > area.x + 1e-6 || b.maxY > area.y + 1e-6);
    const limitsEl = $("p-limits");
    if (this.resultError) limitsEl.innerHTML = `<div class="warnbox">${esc(this.resultError)}</div>`;
    else if (out) {
      limitsEl.innerHTML = `<div class="warnbox">O trabalho passa da área útil (${area.x} × ${area.y} mm${this.image ? ", contando o overscan da imagem" : ""}). O agente vai recusar. Mova os elementos ou reduza o desenho.</div>`;
    } else if (r) {
      limitsEl.textContent = `Área útil ${area.x} × ${area.y} mm · maior potência S${r.maxS} de S${this.limits.maxSpindle} · M4 (potência dinâmica)${this.haveLimits ? "" : " · conecte ao agente para usar os limites reais da máquina"}`;
    } else limitsEl.textContent = "";
    const empty = !r;
    $<HTMLButtonElement>("p-send").disabled = empty || out;
    $<HTMLButtonElement>("p-sim").disabled = empty;
    $<HTMLButtonElement>("p-frame").disabled = empty || out;
  }

  // ---------- mesa ----------

  private fitPiece(): void {
    const b = designBounds(this.layers, this.image);
    if (b) this.view.fitTo({ minX: b.minX - 5, minY: b.minY - 5, maxX: b.maxX + 5, maxY: b.maxY + 5 }, true);
  }

  private draw(): void {
    const v = this.view;
    v.drawBed();
    const ctx = v.ctx;
    const d = v.dpr;
    const anim = this.anim;
    let doneIdx = -1;
    let frac = 0;
    if (anim) {
      // busca binária no tempo acumulado
      let lo = 0;
      let hi = anim.segments.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (anim.cumulative[mid]! <= anim.t) {
          doneIdx = mid;
          lo = mid + 1;
        } else hi = mid - 1;
      }
      const next = anim.segments[doneIdx + 1];
      if (next) {
        const start = doneIdx >= 0 ? anim.cumulative[doneIdx]! : 0;
        frac = (anim.t - start) / Math.max(1e-9, anim.cumulative[doneIdx + 1]! - start);
      }
    }
    const img = this.image;
    if (img?.enabled) {
      ctx.imageSmoothingEnabled = false;
      ctx.globalAlpha = anim ? 0.25 : 1;
      ctx.drawImage(img.preview, v.X(img.x), v.Y(img.y + img.h), img.w * v.s, img.h * v.s);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = "rgba(201,178,138,.45)";
      ctx.setLineDash([3 * d, 3 * d]);
      ctx.strokeRect(v.X(img.x), v.Y(img.y + img.h), img.w * v.s, img.h * v.s);
      ctx.setLineDash([]);
    }
    if (!anim) {
      // preenchimentos: área par-ímpar por camada e operação
      for (const l of this.layers) {
        if (!l.enabled) continue;
        for (const mode of ["fill", "detail"] as const) {
          const group = l.shapes.filter((s) => effectiveMode(s, l) === mode);
          if (!group.length) continue;
          ctx.beginPath();
          for (const s of group) s.points.forEach((p, i) => (i ? ctx.lineTo(v.X(p[0]), v.Y(p[1])) : ctx.moveTo(v.X(p[0]), v.Y(p[1]))));
          ctx.fillStyle = mode === "fill" ? "rgba(224,164,88,.28)" : "rgba(197,138,249,.3)";
          ctx.fill("evenodd");
        }
      }
    }
    const segs = anim ? anim.segments : this.segments;
    if (this.showTravel || anim) {
      ctx.lineWidth = 1 * d;
      ctx.setLineDash([4 * d, 4 * d]);
      ctx.strokeStyle = "rgba(140,150,165,.4)";
      ctx.beginPath();
      for (const sg of segs) {
        if (sg.burn) continue;
        ctx.moveTo(v.X(sg.from[0]), v.Y(sg.from[1]));
        ctx.lineTo(v.X(sg.to[0]), v.Y(sg.to[1]));
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    if (anim) {
      // tudo que já foi gravado, na cor de madeira queimada
      ctx.strokeStyle = "#f1e3c8";
      ctx.lineWidth = Math.max(1, 0.2 * v.s);
      ctx.beginPath();
      for (let i = 0; i <= doneIdx; i++) {
        const sg = anim.segments[i]!;
        if (!sg.burn) continue;
        ctx.moveTo(v.X(sg.from[0]), v.Y(sg.from[1]));
        ctx.lineTo(v.X(sg.to[0]), v.Y(sg.to[1]));
      }
      ctx.stroke();
    }
    for (const l of this.layers) {
      if (!l.enabled) continue;
      for (const s of l.shapes) {
        const m = effectiveMode(s, l);
        const color = l.color.startsWith("hsl") && m === "fill" ? l.color : MODE_INFO[m].color;
        ctx.strokeStyle = color;
        ctx.lineWidth = (m === "cut" ? 1.7 : 1.2) * d;
        ctx.globalAlpha = anim ? 0.35 : 1;
        v.polyline(s.points);
        ctx.stroke();
        if (this.selected.has(s.id) && !anim) {
          ctx.globalAlpha = 1;
          ctx.strokeStyle = "#ffffff";
          ctx.lineWidth = 3.4 * d;
          ctx.setLineDash([5 * d, 3 * d]);
          v.polyline(s.points);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.strokeStyle = color;
          ctx.lineWidth = 1.6 * d;
          v.polyline(s.points);
          ctx.stroke();
        }
      }
    }
    ctx.globalAlpha = 1;
    let head = this.head;
    let lit = false;
    if (anim) {
      const next = anim.segments[doneIdx + 1];
      const last = anim.segments[doneIdx];
      if (next) {
        head = [next.from[0] + (next.to[0] - next.from[0]) * frac, next.from[1] + (next.to[1] - next.from[1]) * frac];
        lit = next.burn;
        if (next.burn) {
          ctx.strokeStyle = "#fff4d6";
          ctx.lineWidth = 2.2 * d;
          v.polyline([next.from, head]);
          ctx.stroke();
        }
      } else if (last) head = last.to;
    }
    if (anim || this.headLive) v.drawHead(head, lit);
    $("p-hud-pos").textContent = `X ${head[0].toFixed(1)} Y ${head[1].toFixed(1)}`;
    $("p-hud-zoom").textContent = `${v.zoomPercent}%`;
  }

  // ---------- simular, enquadrar, enviar ----------

  private startSim(): void {
    const r = this.regenerateNow();
    if (!r) return;
    const segments = this.segments.slice();
    const cumulative: number[] = [];
    let acc = 0;
    for (const sg of segments) {
      acc += segmentSeconds(sg);
      cumulative.push(acc);
    }
    this.stopAnim();
    const speedup = Math.max(10, Math.round(acc / 25));
    this.anim = { segments, cumulative, total: acc, t: 0, speedup, last: performance.now(), label: "Simulação" };
    $("p-sim-bar").hidden = false;
    $("p-hud-mode").textContent = "Simulação";
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const tick = (now: number): void => {
      const a = this.anim;
      if (!a) return;
      const dt = (now - a.last) / 1000;
      a.last = now;
      a.t = reduce ? a.total : Math.min(a.total, a.t + dt * a.speedup);
      $<HTMLProgressElement>("p-sim-progress").value = a.total ? a.t / a.total : 1;
      $("p-sim-text").textContent = `${a.label}: ${fmtTime(a.t)} de ${fmtTime(a.total)} (${a.speedup}× mais rápido)`;
      this.draw();
      if (a.t >= a.total) {
        this.host.toast("Simulação concluída.");
        window.setTimeout(() => this.stopAnim(), 1200);
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  private stopAnim(): void {
    this.anim = null;
    $("p-sim-bar").hidden = true;
    $("p-hud-mode").textContent = "Pré-visualização";
    this.draw();
  }

  private async frame(): Promise<void> {
    if (!this.host.isConnected()) return this.host.toast("Conecte ao agente para enquadrar na laser.");
    const r = this.regenerateNow();
    const b = r ? parseGcode(r.gcode).burnBounds : null;
    if (!b) return this.host.toast("Nada para enquadrar.");
    if (this.frameMode === "min") {
      const pct = ((this.limits.framePower / this.limits.maxSpindle) * 100).toFixed(1);
      const ok = await this.host.confirm(
        "Enquadrar com potência mínima?",
        `O laser fica aceso em ${pct}% (S${this.limits.framePower}) enquanto percorre o contorno. Use óculos de proteção.`,
        "Enquadrar com laser aceso",
      );
      if (!ok) return;
      this.host.send({ type: "frame", bounds: b, laser: "min", confirmLaserOn: true });
    } else {
      this.host.send({ type: "frame", bounds: b, laser: "off" });
    }
    this.host.toast(`Enquadrando ${(b.maxX - b.minX).toFixed(0)} × ${(b.maxY - b.minY).toFixed(0)} mm na laser.`);
  }

  private async sendJob(): Promise<void> {
    if (!this.host.isConnected()) return this.host.toast("Conecte ao agente (aba Controle) para enviar o trabalho.");
    const r = this.regenerateNow();
    if (!r) return;
    const name = `${this.designName || "Trabalho"}.gcode`;
    const ok = await this.host.confirm(
      `Enviar "${name}"?`,
      `Isto liga o laser. Tempo estimado: ${fmtTime(r.estimatedSeconds)}.\n\nConfirme que a área está livre, a exaustão ligada e que há alguém presente ou câmera ao vivo.\n\nMantenha esta aba aberta: se ela fechar ou perder a conexão, o agente pausa o trabalho.`,
      "Enviar e ligar o laser",
    );
    if (!ok) return;
    if (this.host.send({ type: "job", name, gcode: r.gcode, confirmLaserOn: true })) this.host.onJobSent(name, r.gcode);
  }

  // ---------- materiais ----------

  private openMaterials(): void {
    const dlg = $<HTMLDialogElement>("dlg-materials");
    const draft: Material[] = structuredClone(this.materials);
    let current = draft[0]?.id ?? "";
    const modes: MaterialMode[] = ["cut", "line", "fill", "detail", "raster"];
    const render = (): void => {
      $<HTMLSelectElement>("mat-select").innerHTML = draft.map((m) => `<option value="${esc(m.id)}" ${m.id === current ? "selected" : ""}>${esc(m.name)}</option>`).join("");
      const m = draft.find((x) => x.id === current);
      $<HTMLInputElement>("mat-name").value = m?.name ?? "";
      $<HTMLInputElement>("mat-thickness").value = String(m?.thickness ?? "");
      $("mat-body").innerHTML = m
        ? modes
            .map((mode) => {
              const p = m.presets.find((x) => x.mode === mode) ?? { mode, ...presetFor(undefined, mode) };
              const extraKey = mode === "cut" ? "kerf" : mode === "fill" || mode === "detail" ? "interval" : "";
              const extraVal = extraKey === "kerf" ? (p.kerf ?? 0) : extraKey === "interval" ? (p.interval ?? 0.2) : "";
              return `<tr data-mode="${mode}"><td>${MODE_INFO[mode].label}</td>
                <td><input type="number" min="10" data-k="speed" value="${p.speed}" aria-label="Velocidade"></td>
                <td><input type="number" min="0" max="100" data-k="power" value="${p.power}" aria-label="Potência"></td>
                <td><input type="number" min="1" max="50" data-k="passes" value="${p.passes}" aria-label="Passes"></td>
                <td>${extraKey ? `<input type="number" step="0.01" data-k="${extraKey}" value="${extraVal}" aria-label="${extraKey === "kerf" ? "Kerf" : "Intervalo"}">` : "—"}</td></tr>`;
            })
            .join("")
        : "";
      $<HTMLButtonElement>("mat-delete").disabled = draft.length <= 1;
    };
    const readCurrent = (): void => {
      const m = draft.find((x) => x.id === current);
      if (!m) return;
      m.name = $<HTMLInputElement>("mat-name").value.trim() || m.name;
      m.thickness = Number($<HTMLInputElement>("mat-thickness").value) || 0;
      m.presets = [...$("mat-body").querySelectorAll<HTMLTableRowElement>("tr")].map((tr) => {
        const get = (k: string): number | undefined => {
          const inp = tr.querySelector<HTMLInputElement>(`[data-k="${k}"]`);
          return inp ? Number(inp.value) : undefined;
        };
        const preset: MaterialPreset = { mode: tr.dataset.mode as MaterialMode, speed: get("speed") ?? 1000, power: get("power") ?? 10, passes: Math.max(1, Math.round(get("passes") ?? 1)) };
        const kerf = get("kerf");
        const interval = get("interval");
        if (kerf !== undefined) preset.kerf = kerf;
        if (interval !== undefined) preset.interval = interval;
        return preset;
      });
    };
    $<HTMLSelectElement>("mat-select").onchange = (e) => {
      readCurrent();
      current = (e.target as HTMLSelectElement).value;
      render();
    };
    $("mat-new").onclick = () => {
      readCurrent();
      const m: Material = { id: `mat-${Date.now().toString(36)}`, name: "Novo material", thickness: 3, presets: modes.map((mode) => ({ mode, ...presetFor(undefined, mode) })) };
      draft.push(m);
      current = m.id;
      render();
    };
    $("mat-delete").onclick = () => {
      if (draft.length <= 1) return;
      const i = draft.findIndex((x) => x.id === current);
      draft.splice(i, 1);
      current = draft[0]!.id;
      render();
    };
    $("mat-note").textContent = this.host.isConnected()
      ? "A biblioteca fica salva no agente e vale para todos os aparelhos. Os valores de exemplo precisam ser ajustados com o teste de matriz na sua máquina."
      : "Sem conexão com o agente: você pode ver os exemplos, mas para salvar precisa conectar (aba Controle).";
    render();
    dlg.addEventListener(
      "close",
      () => {
        if (dlg.returnValue !== "ok") return;
        readCurrent();
        if (!this.host.isConnected()) return this.host.toast("Conecte ao agente para salvar os materiais.");
        this.host.send({ type: "materialsSave", materials: draft });
      },
      { once: true },
    );
    dlg.returnValue = "";
    dlg.showModal();
  }

  // ---------- eventos ----------

  private bind(): void {
    $<HTMLInputElement>("p-file-svg").addEventListener("change", (e) => {
      const input = e.target as HTMLInputElement;
      void this.handleFile(input.files?.[0]).finally(() => (input.value = ""));
    });
    $<HTMLInputElement>("p-file-img").addEventListener("change", (e) => {
      const input = e.target as HTMLInputElement;
      void this.handleFile(input.files?.[0]).finally(() => (input.value = ""));
    });
    const box = $("p-box");
    box.addEventListener("dragover", (e) => {
      e.preventDefault();
      box.classList.add("drag");
    });
    box.addEventListener("dragleave", () => box.classList.remove("drag"));
    box.addEventListener("drop", (e) => {
      e.preventDefault();
      box.classList.remove("drag");
      void this.handleFile(e.dataTransfer?.files[0]);
    });
    $("p-sample").addEventListener("click", () => this.loadSample());
    $("p-clear").addEventListener("click", async () => {
      if (!this.layers.length && !this.image) return;
      if (await this.host.confirm("Limpar o desenho?", "Todos os elementos e a imagem saem da mesa.", "Limpar", true)) {
        this.resetDesign("");
        this.refresh();
      }
    });
    $("p-text").addEventListener("click", () => {
      const dlg = $<HTMLDialogElement>("dlg-text");
      dlg.addEventListener("close", () => dlg.returnValue === "ok" && this.addText(), { once: true });
      dlg.returnValue = "";
      dlg.showModal();
    });
    $("p-matrix").addEventListener("click", () => {
      const dlg = $<HTMLDialogElement>("dlg-matrix");
      dlg.addEventListener("close", () => dlg.returnValue === "ok" && this.loadMatrix(), { once: true });
      dlg.returnValue = "";
      dlg.showModal();
    });
    $("p-materials").addEventListener("click", () => this.openMaterials());
    $("p-box-gen").addEventListener("click", () => this.openBox());
    $("p-parts").addEventListener("click", () => this.openParts());
    $("p-export-svg").addEventListener("click", () => this.exportSvg());
    $("p-export-gcode").addEventListener("click", () => this.exportGcode());
    $("p-multi").addEventListener("click", (e) => {
      this.multi = !this.multi;
      (e.currentTarget as HTMLElement).setAttribute("aria-pressed", String(this.multi));
      this.host.toast(this.multi ? "Toque nos elementos para juntar à seleção." : "Seleção de um elemento por vez.");
    });
    $("p-travel").addEventListener("click", (e) => {
      this.showTravel = !this.showTravel;
      (e.currentTarget as HTMLElement).setAttribute("aria-pressed", String(this.showTravel));
      this.draw();
    });
    $("p-zoom-in").addEventListener("click", () => this.view.zoomCenter(1.4));
    $("p-zoom-out").addEventListener("click", () => this.view.zoomCenter(1 / 1.4));
    $("p-zoom-fit").addEventListener("click", () => this.view.fitTo(null));
    $("p-zoom-piece").addEventListener("click", () => this.fitPiece());
    $("p-frame-mode").addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest("button");
      if (!btn) return;
      this.frameMode = btn.dataset.v === "min" ? "min" : "off";
      for (const b of $("p-frame-mode").querySelectorAll("button")) b.setAttribute("aria-pressed", String(b === btn));
    });
    $("p-frame").addEventListener("click", () => void this.frame());
    $("p-sim").addEventListener("click", () => this.startSim());
    $("p-sim-stop").addEventListener("click", () => this.stopAnim());
    $("p-send").addEventListener("click", () => void this.sendJob());
    document.addEventListener("keydown", (e) => {
      if ($("view-prepare").hidden) return;
      const tag = (e.target as HTMLElement).tagName.toLowerCase();
      if (tag === "input" || tag === "select" || tag === "textarea" || document.querySelector("dialog[open]")) return;
      const key = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && key === "z") {
        e.preventDefault();
        this.undo();
        return;
      }
      if (!this.selected.size) return;
      const step = e.shiftKey ? 10 : 1;
      const moves: Record<string, Point> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
      const mv = moves[e.key];
      if (mv) {
        e.preventDefault();
        this.moveSel(mv[0], mv[1]);
      } else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        this.deleteSel();
      } else if ((e.ctrlKey || e.metaKey) && key === "d") {
        e.preventDefault();
        this.duplicateSel();
      } else if (e.key === "Escape") {
        this.selected.clear();
        this.refresh();
      }
    });
  }

  /** Chamado ao mostrar a aba: o canvas pode ter mudado de tamanho enquanto estava escondido. */
  shown(): void {
    this.view.resize();
  }
}

function segDist(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}
