import {
  boundsOf,
  boxDesign,
  carDesign,
  DEFAULT_BOX,
  DEFAULT_CAR,
  DEFAULT_OTTO,
  ottoDesign,
  DEFAULT_MATRIX,
  designToDxf,
  designToSvg,
  generateGcode,
  matrixTest,
  offsetPath,
  parseGcode,
  pointInPolygon,
  segmentSeconds,
  textToPaths,
  buntingParts,
  layoutSheets,
  pencilParts,
  phraseParts,
  type Bounds,
  type PanelPart,
  type Path,
  type GenerateResult,
  type Point,
  type Segment,
  type TextTag,
  type VectorMode,
} from "@laserlink/gcode";
import { DEFAULT_MATERIALS, type AgentLimits, type ClientMessage, type Material, type MaterialMode, type MaterialPreset } from "@laserlink/shared";
import { BedView } from "../bed-view.js";
import { bedColors } from "../theme.js";
import { importDxf, importImage, importSvg } from "./importers.js";
import { parseProject, PROJECT_EXT, serializeProject } from "./project.js";
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
  type ShapeText,
} from "./model.js";
import { addUserFont, allFonts, cssFamily, fontLabel, fontTextToPaths, loadFont, shapeLine, SINGLE_STROKE } from "./fonts.js";
import { sampleDesign } from "./sample.js";

type DrawTool = "rect" | "line" | "circle";
interface DrawResult {
  points: Point[];
  closed: boolean;
  name: string;
  /** Medida mostrada ao lado do cursor enquanto desenha. */
  label: string;
  /** Menor medida útil (para recusar formas que ficaram só um ponto). */
  size: number;
}
const DRAW_INFO: Record<DrawTool, { label: string; hint: string }> = {
  rect: { label: "Retângulo", hint: "Arraste na mesa para desenhar o retângulo. Shift faz um quadrado. Esc sai da ferramenta." },
  line: { label: "Linha", hint: "Arraste na mesa do começo ao fim da linha. Shift prende o ângulo de 15 em 15°. Esc sai da ferramenta." },
  circle: { label: "Círculo", hint: "Arraste na mesa a caixa do círculo. Sem Shift sai uma elipse; com Shift, círculo perfeito. Esc sai da ferramenta." },
};
const DRAW_KEYS: Record<string, DrawTool | undefined> = { r: "rect", l: "line", c: "circle" };
const fmtMm = (v: number): string => v.toFixed(1).replace(/\.0$/, "");

export interface PrepareHost {
  confirm(title: string, text: string, okLabel: string, danger?: boolean): Promise<boolean>;
  toast(message: string): void;
  send(msg: ClientMessage): boolean;
  isConnected(): boolean;
  /** Trabalho enviado: a interface mostra a mesa "Na máquina". */
  onJobSent(name: string, gcode: string): void;
  /** G-code mandado para a fila do agente (ainda não iniciado). */
  onQueued(name: string, gcode: string): void;
  /** Posição do mouse sobre a mesa, em mm (barra de status). */
  onCursor?(mm: Point | null): void;
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

/** Arquivo aberto com o seletor do navegador (Chrome/Edge em https ou localhost), para "Salvar" sem perguntar de novo. */
interface FileHandle {
  readonly name: string;
  createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void> }>;
}
type SavePicker = (options: { suggestedName: string; types: Array<{ description: string; accept: Record<string, string[]> }> }) => Promise<FileHandle>;

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
  private fileHandle: FileHandle | null = null;
  private dragSaved = false;
  /** Ferramenta "Área": arrastar no vazio desenha a caixa de seleção. */
  private areaMode = false;
  /** Copiar/colar: cópia dos elementos com a camada de onde vieram. */
  private clipboard: Array<{ layer: Pick<Layer, "id" | "name" | "color" | "mode" | "materialId" | "settings">; shape: Shape }> = [];
  private pasteCount = 0;
  /** Caixa de seleção sendo desenhada, em pixels do canvas. */
  private marquee: { a: Point; b: Point } | null = null;
  /** Ferramenta de desenho ligada (Editar > Desenhar): arrastar na mesa cria a forma. */
  private drawTool: DrawTool | null = null;
  /** Forma sendo desenhada, em mm (prévia). */
  private drawing: { a: Point; b: Point; shift: boolean; free: boolean } | null = null;

  constructor(private readonly host: PrepareHost) {
    this.view = new BedView($<HTMLCanvasElement>("p-canvas"), this.limits.workArea, () => this.requestDraw(), {
      onTap: (px, ev) => this.pick(px, ev),
      onDragStart: (px, ev) => {
        if (this.anim) return false;
        if (this.drawTool) return "marquee";
        const hit = this.hitTest(px);
        this.dragSaved = false;
        if (hit && this.selected.has(hit.id) && !hit.locked) return true;
        if (this.areaMode || ev.shiftKey) return "marquee";
        // apertar e arrastar uma peça que não estava selecionada: seleciona e já move
        // (com Vários ou Ctrl o clique soma à seleção: aí quem decide é o toque, não o arraste)
        if (hit && !hit.locked && !this.multi && !ev.ctrlKey && !ev.metaKey) {
          this.select(hit.id, false);
          return true;
        }
        return false;
      },
      onMarquee: (a, b, ev) => {
        if (this.drawTool) {
          this.drawing = b ? { a: this.view.toMm(a[0], a[1]), b: this.view.toMm(b[0], b[1]), shift: !!ev?.shiftKey, free: !!ev?.altKey } : null;
          if (this.drawing) this.host.onCursor?.(this.drawing.b);
        } else this.marquee = b ? { a, b } : null;
        this.requestDraw();
      },
      onMarqueeEnd: (a, b, ev) => {
        if (this.drawTool) {
          this.drawing = null;
          this.finishDrawing(this.view.toMm(a[0], a[1]), this.view.toMm(b[0], b[1]), ev.shiftKey, ev.altKey);
          return;
        }
        this.marquee = null;
        this.selectArea(a, b, this.multi || ev.shiftKey || ev.ctrlKey || ev.metaKey);
      },
      onDragMove: (dx, dy) => {
        // só grava o "desfazer" quando o elemento realmente se move (um clique simples não conta)
        if (!this.dragSaved) {
          this.history.push(this.layers);
          this.dragSaved = true;
        }
        for (const { s } of this.movable()) s.points = s.points.map(([x, y]) => [x + dx, y + dy] as Point);
        this.requestDraw();
      },
      onDragEnd: () => this.refresh(),
      onDoubleClick: (px) => this.doubleClick(px),
      onHover: (mm) => this.host.onCursor?.(mm),
    });
    this.bind();
    this.bindProps();
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
  /**
   * Ponto do desenho para "Origem pelo desenho": da seleção, se houver, ou do desenho todo.
   * `a` = linha (t/m/b) + coluna (l/c/r), ex.: "mc" = centro.
   */
  anchorPoint(a: string): { p: Point; what: string } | null {
    const sel = this.selected.size > 0;
    const b = sel ? this.selBounds() : designBounds(this.layers, this.image);
    if (!b) return null;
    const x = a[1] === "l" ? b.minX : a[1] === "r" ? b.maxX : (b.minX + b.maxX) / 2;
    const y = a[0] === "b" ? b.minY : a[0] === "t" ? b.maxY : (b.minY + b.maxY) / 2;
    return { p: [x, y], what: sel ? "da seleção" : "do desenho" };
  }

  /** Tem algo na mesa (para perguntar antes de trocar o desenho). */
  hasDesign(): boolean {
    return this.layers.some((l) => l.shapes.length > 0) || this.image !== null;
  }

  /** Abre um projeto recebido (.laserlink, .svg ou .dxf) como se fosse um arquivo do computador. */
  async openReceived(name: string, content: string): Promise<void> {
    const type = /\.svg$/i.test(name) ? "image/svg+xml" : "text/plain";
    await this.handleFile(new File([content], name, { type }));
  }

  setHead(p: Point): void {
    this.head = p;
    this.headLive = true;
    if (!this.anim && !$("p-box").hidden) this.requestDraw();
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
          this.tagShape(sh, p.text);
          layer.shapes.push(sh);
        }
      }
      this.layers.push(layer);
    }
    this.finishTexts();
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
        this.tagShape(sh, p.text);
        layer.shapes.push(sh);
      });
      this.layers.push(layer);
    }
    this.finishTexts();
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

  // ---------- painel escolar ----------

  private openPanel(): void {
    const dlg = $<HTMLDialogElement>("dlg-panel");
    const sel = $<HTMLSelectElement>("pn-font");
    const kind = $<HTMLSelectElement>("pn-kind");
    const start = this.lastFont();
    this.fillFonts(sel, start === SINGLE_STROKE ? "fredoka" : start);
    const sync = (): void => {
      for (const k of ["phrase", "bunting", "pencil"]) $(`pn-${k}`).hidden = kind.value !== k;
      const sample = $("pn-sample");
      sample.textContent = (kind.value === "phrase" ? $<HTMLTextAreaElement>("ph-text").value.split("\n")[0] : kind.value === "bunting" ? $<HTMLInputElement>("bt-text").value : $<HTMLInputElement>("pc-label").value) || "Escola";
      void cssFamily(sel.value)
        .then((family) => {
          sample.style.fontFamily = family ? `"${family}"` : "var(--mono)";
          sample.classList.toggle("single", !family);
        })
        .catch(() => undefined);
    };
    kind.onchange = sync;
    sel.onchange = () => {
      if (sel.value !== SINGLE_STROKE) this.rememberFont(sel.value);
      sync();
    };
    for (const id of ["ph-text", "bt-text", "pc-label"]) $<HTMLInputElement>(id).oninput = sync;
    $("pn-font-load").onclick = () => this.pickFontFile(sel, sync);
    sync();
    $("pn-error").textContent = "";
    const onClose = async (): Promise<void> => {
      if (dlg.returnValue !== "ok") return;
      const err = await this.loadPanel();
      if (err) {
        $("pn-error").textContent = err;
        dlg.returnValue = "";
        dlg.addEventListener("close", () => void onClose(), { once: true });
        dlg.showModal();
      }
    };
    dlg.addEventListener("close", () => void onClose(), { once: true });
    dlg.returnValue = "";
    dlg.showModal();
  }

  /** Gera as peças do painel e põe na mesa a chapa pedida. Devolve a mensagem de erro, se houver. */
  private async loadPanel(): Promise<string | null> {
    const num = (id: string): number => Number($<HTMLInputElement>(id).value);
    const kind = $<HTMLSelectElement>("pn-kind").value;
    const fontId = $<HTMLSelectElement>("pn-font").value;
    let parts: PanelPart[];
    try {
      const needsOutline = kind !== "pencil" || $<HTMLInputElement>("pc-label").value.trim() !== "";
      if (needsOutline && fontId === SINGLE_STROKE) throw new Error("Escolha uma fonte de contorno (traço único não forma letras para cortar).");
      const font = needsOutline ? await loadFont(fontId) : null;
      const shaper = (text: string, h: number): Path[] => (font ? shapeLine(font, text, h) : []);
      if (kind === "phrase") {
        parts = phraseParts(
          {
            lines: $<HTMLTextAreaElement>("ph-text").value.split("\n"),
            height: num("ph-height"),
            border: num("ph-border"),
            baseBy: $<HTMLSelectElement>("ph-base").value as "letter" | "word" | "line",
            guide: $<HTMLInputElement>("ph-guide").checked,
          },
          shaper,
        );
      } else if (kind === "bunting") {
        parts = buntingParts(
          {
            text: $<HTMLInputElement>("bt-text").value,
            shape: $<HTMLSelectElement>("bt-shape").value as "pencil" | "triangle" | "swallowtail" | "rect",
            width: num("bt-w"),
            height: num("bt-h"),
            holeD: num("bt-hole"),
            letter: $<HTMLSelectElement>("bt-letter").value as "cut" | "engrave" | "hollow",
            letterScale: num("bt-scale") / 100,
          },
          shaper,
        );
      } else {
        parts = pencilParts({ length: num("pc-l"), width: num("pc-w"), split: $<HTMLSelectElement>("pc-split").value === "1", label: $<HTMLInputElement>("pc-label").value }, shaper);
      }
    } catch (err) {
      return (err as Error).message;
    }
    const area = this.limits.workArea;
    const { sheets, tooBig } = layoutSheets(parts, area);
    if (!sheets.length) return `Nenhuma peça cabe na mesa (${area.x} × ${area.y} mm): ${tooBig.slice(0, 3).join(", ")}. Diminua as medidas.`;
    const sheetNo = Math.min(sheets.length, Math.max(1, Math.round(num("pn-sheet")) || 1));
    $<HTMLInputElement>("pn-sheet").value = String(sheetNo);
    $<HTMLInputElement>("pn-sheet").max = String(sheets.length);
    $("pn-sheets").textContent = `de ${sheets.length}`;
    const title = kind === "phrase" ? "Painel: frase" : kind === "bunting" ? "Painel: bandeirolas" : "Painel: lápis";
    this.resetDesign(sheets.length > 1 ? `${title} (chapa ${sheetNo} de ${sheets.length})` : title);
    const mat = this.materials[0];
    const layers: Record<"cut" | "line" | "fill", Layer> = {
      cut: makeLayer("Cortes", MODE_INFO.cut.color, "cut", mat),
      line: makeLayer("Gravar linha", MODE_INFO.line.color, "line", mat),
      fill: makeLayer("Gravar preenchido", MODE_INFO.fill.color, "fill", mat),
    };
    for (const { part, dx, dy } of sheets[sheetNo - 1]!) {
      const group = newId("G");
      const add = (layer: Layer, paths: Path[], suffix: string): void => {
        paths.forEach((p, i) => {
          const sh = makeShape(
            p.points.map(([x, y]) => [x + dx, y + dy] as Point),
            paths.length > 1 ? `${part.name}${suffix} ${i + 1}` : `${part.name}${suffix}`,
            p.closed,
          );
          sh.group = group;
          layer.shapes.push(sh);
        });
      };
      add(layers.cut, part.cut, "");
      add(layers.line, part.engrave, ": gravação");
      add(layers.fill, part.fill, ": preenchido");
    }
    this.layers = [layers.fill, layers.line, layers.cut].filter((l) => l.shapes.length);
    this.view.fitTo(null);
    this.refresh();
    const parts1 = sheets[sheetNo - 1]!.length;
    const more =
      sheets.length <= 1 ? "" : sheetNo < sheets.length ? ` Chapa ${sheetNo} de ${sheets.length}: depois de cortar, abra Painel de novo e gere a chapa ${sheetNo + 1}.` : ` Esta é a última chapa (${sheetNo} de ${sheets.length}).`;
    const big = tooBig.length ? ` Ficaram de fora por serem maiores que a mesa: ${tooBig.slice(0, 3).join(", ")}${tooBig.length > 3 ? "…" : ""}.` : "";
    this.host.toast(`${parts1} peça(s) na mesa.${more}${big}`);
    return null;
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

  private exportDxf(): void {
    const design = toJobDesign(this.designName || "Trabalho", this.layers, null);
    if (!design.vectors.length) return this.host.toast("Nada para exportar: a mesa não tem linhas nem cortes (imagens não vão no DXF).");
    this.download(`${this.fileBase()}.dxf`, designToDxf(design), "application/dxf");
    this.host.toast("DXF baixado em mm, uma camada por operação (CORTAR, GRAVAR_LINHA…).");
  }

  private exportGcode(): void {
    const r = this.regenerateNow();
    if (!r) return this.host.toast("Nada para exportar.");
    this.download(`${this.fileBase()}.gcode`, r.gcode, "text/plain");
  }

  // ---------- desenhar com o mouse: retângulo, linha e círculo ----------

  /** Liga ou desliga uma ferramenta de desenho. A mesma ferramenta de novo desliga. */
  setDrawTool(tool: DrawTool | null): void {
    this.drawTool = tool === this.drawTool ? null : tool;
    this.drawing = null;
    for (const b of document.querySelectorAll<HTMLButtonElement>("[data-draw]")) {
      b.setAttribute("aria-pressed", String(b.dataset.draw === this.drawTool));
    }
    const chip = $("p-hud-draw");
    chip.hidden = !this.drawTool;
    if (this.drawTool) {
      chip.textContent = `Desenhando: ${DRAW_INFO[this.drawTool].label} · Esc sai`;
      this.host.toast(DRAW_INFO[this.drawTool].hint);
    }
    $("p-canvas").classList.toggle("drawing", !!this.drawTool);
    this.requestDraw();
  }

  /** Pontos da forma entre o ponto inicial e o atual (mm). Encaixa em 0,5 mm, a não ser com Alt. */
  private drawGeometry(a: Point, b: Point, shift: boolean, free: boolean): DrawResult | null {
    const tool = this.drawTool;
    if (!tool) return null;
    const snap = (v: number): number => (free ? v : Math.round(v * 2) / 2);
    const [ax, ay] = [snap(a[0]), snap(a[1])];
    let dx = snap(b[0]) - ax;
    let dy = snap(b[1]) - ay;
    if (tool === "line") {
      if (shift) {
        // Shift: ângulo de 15 em 15 graus
        const len = Math.hypot(dx, dy);
        const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 12)) * (Math.PI / 12);
        dx = len * Math.cos(ang);
        dy = len * Math.sin(ang);
      }
      const len = Math.hypot(dx, dy);
      const deg = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
      return {
        points: [[ax, ay], [ax + dx, ay + dy]],
        closed: false,
        name: `Linha ${fmtMm(len)} mm`,
        label: `${fmtMm(len)} mm · ${deg.toFixed(0)}°`,
        size: len,
      };
    }
    if (shift) {
      // Shift: quadrado ou círculo perfeito
      const side = Math.max(Math.abs(dx), Math.abs(dy));
      dx = Math.sign(dx || 1) * side;
      dy = Math.sign(dy || 1) * side;
    }
    const x0 = Math.min(ax, ax + dx);
    const y0 = Math.min(ay, ay + dy);
    const w = Math.abs(dx);
    const h = Math.abs(dy);
    const dims = `${fmtMm(w)} × ${fmtMm(h)} mm`;
    if (tool === "rect") {
      return {
        points: [[x0, y0], [x0 + w, y0], [x0 + w, y0 + h], [x0, y0 + h], [x0, y0]],
        closed: true,
        name: `${w === h ? "Quadrado" : "Retângulo"} ${dims}`,
        label: dims,
        size: Math.min(w, h),
      };
    }
    const [cx, cy, rx, ry] = [x0 + w / 2, y0 + h / 2, w / 2, h / 2];
    // segmentos de no máximo ~0,5 mm, como os furos das peças prontas
    const n = Math.max(24, Math.min(240, Math.ceil((Math.PI * (w + h)) / 2 / 0.5)));
    const points: Point[] = [];
    for (let i = 0; i < n; i++) points.push([cx + rx * Math.cos((i / n) * 2 * Math.PI), cy + ry * Math.sin((i / n) * 2 * Math.PI)]);
    points.push(points[0]!);
    const circ = Math.abs(w - h) < 0.01;
    return {
      points,
      closed: true,
      name: circ ? `Círculo Ø ${fmtMm(w)} mm` : `Elipse ${dims}`,
      label: circ ? `Ø ${fmtMm(w)} mm` : dims,
      size: Math.min(w, h),
    };
  }

  private finishDrawing(a: Point, b: Point, shift: boolean, free: boolean): void {
    const g = this.drawGeometry(a, b, shift, free);
    this.requestDraw();
    if (!g) return;
    if (g.size < 0.5) {
      this.host.toast("Ficou pequeno demais. Arraste mais para desenhar (mínimo 0,5 mm).");
      return;
    }
    // tudo o que é desenhado à mão vai para a camada "Desenho", que corta por padrão
    let layer = this.layers.find((l) => l.name === "Desenho");
    if (!layer) {
      layer = makeLayer("Desenho", MODE_INFO.cut.color, "cut", this.materials[0]);
      this.layers.push(layer);
    }
    if (!layer.enabled) layer.enabled = true;
    this.history.push(this.layers);
    const shape = makeShape(g.points, g.name, g.closed);
    layer.shapes.push(shape);
    this.selected.clear();
    this.selected.add(shape.id);
    if (!this.designName) this.designName = "Desenho";
    this.refresh();
  }

  private async addText(): Promise<void> {
    const text = $<HTMLTextAreaElement>("tx-text").value.replace(/\s+$/, "");
    if (!text.trim()) return;
    const height = Math.max(1, Number($<HTMLInputElement>("tx-height").value));
    const x = Number($<HTMLInputElement>("tx-x").value);
    const y = Number($<HTMLInputElement>("tx-y").value);
    const font = $<HTMLSelectElement>("tx-font").value || SINGLE_STROKE;
    const align = $<HTMLSelectElement>("tx-align").value as "left" | "center" | "right";
    const mode = font === SINGLE_STROKE ? "line" : ($<HTMLSelectElement>("tx-mode").value as VectorMode);
    let paths: Path[];
    try {
      paths = await fontTextToPaths(font, text, { height, x, y, align, tag: newId("T") });
    } catch (err) {
      return this.host.toast((err as Error).message);
    }
    if (!paths.length) return this.host.toast("Nenhuma letra desse texto existe na fonte escolhida.");
    let layer = this.layers.find((l) => l.name === "Texto");
    if (!layer) {
      layer = makeLayer("Texto", "#4da3ff", "line", this.materials[0]);
      this.layers.push(layer);
    }
    this.history.push(this.layers);
    const group = newId("G");
    const oneLine = text.replace(/\n/g, " ");
    const label = oneLine.length > 24 ? `${oneLine.slice(0, 24)}…` : oneLine;
    this.selected.clear();
    for (const p of paths) {
      // a camada Texto grava em linha; preencher ou cortar fica como operação do próprio elemento
      const s = makeShape(p.points, `Texto “${label}”`, p.closed, mode === layer.mode ? null : mode);
      s.group = group;
      if (p.text) s.text = { ...p.text, h0: 0 };
      layer.shapes.push(s);
      this.selected.add(s.id);
    }
    this.finishTexts();
    if (!this.designName) this.designName = "Texto";
    this.refresh();
    this.host.toast("Texto adicionado e selecionado: arraste ou use os campos para posicionar.");
  }

  // ---------- fontes ----------

  /** Preenche um seletor de fontes (as do app e as carregadas pela pessoa). */
  private fillFonts(sel: HTMLSelectElement, current: string): void {
    sel.innerHTML = allFonts()
      .map((f) => `<option value="${esc(f.id)}"${f.id === current ? " selected" : ""}>${esc(f.label)}</option>`)
      .join("");
    if (!sel.value) sel.value = SINGLE_STROKE;
  }

  private lastFont(): string {
    try {
      return localStorage.getItem("laserlink.font") ?? "fredoka";
    } catch {
      return "fredoka";
    }
  }

  private rememberFont(id: string): void {
    try {
      localStorage.setItem("laserlink.font", id);
    } catch {
      /* armazenamento indisponível */
    }
  }

  /** Mostra a amostra da fonte e ajusta as operações possíveis (traço único só grava em linha). */
  private async syncFontUi(sel: HTMLSelectElement, sample: HTMLElement | null, mode: HTMLSelectElement | null, note: HTMLElement | null): Promise<void> {
    const single = sel.value === SINGLE_STROKE;
    if (mode) {
      for (const o of mode.options) o.disabled = single && o.value !== "line";
      if (single) mode.value = "line";
      else if (mode.value === "line" && mode.dataset.touched !== "1") mode.value = "fill";
    }
    if (note) {
      note.textContent = single
        ? "Traço único: risco simples, rápido para gravar em linha. Só maiúsculas; acentos saem sem acento (Ç vira C)."
        : "Fonte de contorno: aceita minúsculas e acentos. Boa para gravar preenchido ou cortar letras de painel.";
    }
    if (!sample) return;
    sample.textContent = ($<HTMLTextAreaElement>("tx-text").value.split("\n")[0] || "Sapienza").slice(0, 40);
    try {
      const family = await cssFamily(sel.value);
      sample.style.fontFamily = family ? `"${family}"` : "var(--mono)";
      sample.classList.toggle("single", !family);
    } catch {
      sample.style.fontFamily = "";
    }
  }

  /** Abre o seletor de arquivo de fonte; ao carregar, escolhe a fonte nova em `sel`. */
  private pickFontFile(sel: HTMLSelectElement, after: () => void): void {
    const input = $<HTMLInputElement>("font-file");
    input.value = "";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const info = await addUserFont(file);
        this.fillFonts(sel, info.id);
        this.host.toast(`Fonte ${info.label} carregada. Ela fica guardada neste navegador.`);
        after();
      } catch (err) {
        this.host.toast((err as Error).message);
      }
    };
    input.click();
  }

  private async handleFile(file: File | undefined): Promise<void> {
    if (!file) return;
    try {
      if (/\.laserlink$/i.test(file.name)) {
        await this.openProjectText(await file.text());
      } else if (/\.dxf$/i.test(file.name)) {
        const { layers, count, skipped } = importDxf(await file.text(), this.materials);
        this.resetDesign(file.name);
        this.layers = layers;
        this.view.fitTo(null);
        this.refresh();
        this.host.toast(
          `${file.name}: ${count} elementos em ${layers.length} camada(s).${skipped ? ` ${skipped} item(ns) sem linhas (textos, cotas, hachuras) ficaram de fora.` : ""}`,
        );
      } else if (/\.svg$/i.test(file.name) || file.type === "image/svg+xml") {
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
        this.host.toast("Formato não suportado. Use SVG, DXF, PNG, JPG ou um projeto .laserlink.");
      }
    } catch (err) {
      this.host.toast((err as Error).message);
    }
  }

  // ---------- textos editáveis ----------

  /** Copia a marca de texto do gerador para o elemento (o id ganha um prefixo único por desenho). */
  private tagShape(sh: Shape, tag: TextTag | undefined): void {
    if (!tag) return;
    sh.text = { id: `${this.textPrefix}${tag.id}`, value: tag.value, height: tag.height, align: tag.align, h0: 0 };
    if (tag.font) sh.text.font = tag.font;
  }

  private textPrefix = "";

  /** Calcula a altura na mesa de cada texto recém-criado (h0) e troca o prefixo para o próximo desenho. */
  private finishTexts(): void {
    const boxes = this.textBoxes(false);
    for (const l of this.layers) for (const s of l.shapes) if (s.text && !s.text.h0) s.text.h0 = boxes.get(s.text.id)?.h ?? s.text.height;
    this.textPrefix = `${newId("T")}:`;
  }

  /** Retângulo de cada texto na mesa. */
  private textBoxes(enabledOnly = true): Map<string, Bounds & { h: number }> {
    const boxes = new Map<string, Bounds & { h: number }>();
    for (const l of this.layers) {
      if (enabledOnly && !l.enabled) continue;
      for (const s of l.shapes) {
        if (!s.text) continue;
        const b = boundsOf(s.points)!;
        const cur = boxes.get(s.text.id);
        const u = cur ? { minX: Math.min(cur.minX, b.minX), minY: Math.min(cur.minY, b.minY), maxX: Math.max(cur.maxX, b.maxX), maxY: Math.max(cur.maxY, b.maxY) } : b;
        boxes.set(s.text.id, { ...u, h: u.maxY - u.minY });
      }
    }
    return boxes;
  }

  /** Dois cliques: num texto, abre a edição; fora, ajusta a vista ao desenho. */
  private doubleClick(px: Point): void {
    if (this.anim) return;
    const p = this.view.toMm(px[0], px[1]);
    const pad = (6 * this.view.dpr) / this.view.s;
    let best: string | null = null;
    let bestArea = Infinity;
    for (const [id, b] of this.textBoxes()) {
      if (p[0] < b.minX - pad || p[0] > b.maxX + pad || p[1] < b.minY - pad || p[1] > b.maxY + pad) continue;
      const area = (b.maxX - b.minX) * (b.maxY - b.minY);
      if (area < bestArea) {
        bestArea = area;
        best = id;
      }
    }
    if (best) this.editText(best);
    else this.fitPiece();
  }

  private editText(id: string): void {
    const found = this.layers.flatMap((l) => l.shapes.filter((s) => s.text?.id === id).map((s) => ({ s, l })));
    const first = found[0];
    if (!first?.s.text) return;
    const tag = first.s.text;
    const old = boundsOf(found.flatMap(({ s }) => s.points))!;
    const stretch = tag.h0 > 0 ? (old.maxY - old.minY) / tag.h0 : 1;
    $<HTMLTextAreaElement>("te-text").value = tag.value;
    this.fillFonts($<HTMLSelectElement>("te-font"), tag.font ?? SINGLE_STROKE);
    $<HTMLInputElement>("te-height").value = String(Math.round(tag.height * stretch * 10) / 10);
    const dlg = $<HTMLDialogElement>("dlg-text-edit");
    dlg.addEventListener(
      "close",
      async () => {
        if (dlg.returnValue !== "ok") return;
        const value = $<HTMLTextAreaElement>("te-text").value.replace(/\s+$/, "");
        const height = Math.max(1, Number($<HTMLInputElement>("te-height").value) || tag.height);
        const font = $<HTMLSelectElement>("te-font").value || SINGLE_STROKE;
        let paths: Path[] = [];
        try {
          paths = value.trim() ? await fontTextToPaths(font, value, { height, x: 0, y: 0, align: tag.align }) : [];
        } catch (err) {
          return this.host.toast((err as Error).message);
        }
        const nb = boundsOf(paths.flatMap((p) => p.points));
        if (!nb) return this.host.toast("Escreva o texto. Para apagar o texto, selecione e use Excluir.");
        // o texto novo fica onde o antigo estava (mesmo centro; mesma ponta quando alinhado à esquerda/direita)
        const dx = tag.align === "left" ? old.minX - nb.minX : tag.align === "right" ? old.maxX - nb.maxX : (old.minX + old.maxX) / 2 - (nb.minX + nb.maxX) / 2;
        const dy = (old.minY + old.maxY) / 2 - (nb.minY + nb.maxY) / 2;
        this.history.push(this.layers);
        const layer = first.l;
        const index = layer.shapes.indexOf(first.s);
        for (const l of this.layers) l.shapes = l.shapes.filter((s) => s.text?.id !== id);
        const label = value.length > 24 ? `${value.slice(0, 24)}…` : value;
        const name = first.s.name.startsWith("Texto “") ? `Texto “${label}”` : first.s.name;
        const text: ShapeText = { ...tag, value, height, h0: nb.maxY - nb.minY };
        if (font === SINGLE_STROKE) delete text.font;
        else text.font = font;
        const fresh = paths.map((p) => {
          const sh = makeShape(p.points.map(([x, y]) => [x + dx, y + dy] as Point), name, p.closed, first.s.mode);
          if (first.s.group) sh.group = first.s.group;
          sh.text = text;
          return sh;
        });
        layer.shapes.splice(Math.max(0, Math.min(index, layer.shapes.length)), 0, ...fresh);
        this.selected.clear();
        for (const sh of fresh) this.selected.add(sh.id);
        this.refresh();
        this.host.toast("Texto trocado. Ctrl+Z desfaz.");
      },
      { once: true },
    );
    dlg.returnValue = "";
    dlg.showModal();
    $<HTMLInputElement>("te-text").select();
  }

  // ---------- projeto (Arquivo) ----------

  private async openProjectText(text: string): Promise<void> {
    const p = await parseProject(text, this.materials);
    this.resetDesign(p.name);
    this.layers = p.layers;
    this.image = p.image;
    this.fileHandle = null;
    this.finishTexts();
    this.view.fitTo(null);
    this.refresh();
    this.host.toast(`Projeto "${p.name}" aberto.`);
  }

  /** Salvar (asNew = Salvar como). Com o seletor de arquivos do navegador quando existe; senão, baixa o arquivo. */
  async saveProject(asNew: boolean): Promise<void> {
    if (!this.layers.some((l) => l.shapes.length) && !this.image) return this.host.toast("Nada para salvar: a mesa está vazia.");
    const picker = (window as unknown as { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
    if (picker) {
      try {
        if (asNew || !this.fileHandle) {
          this.fileHandle = await picker({
            suggestedName: `${this.fileBase()}${PROJECT_EXT}`,
            types: [{ description: "Projeto do Sapienza LaserLink", accept: { "application/json": [PROJECT_EXT] } }],
          });
          this.designName = this.fileHandle.name.replace(/\.laserlink$/i, "");
        }
        const w = await this.fileHandle.createWritable();
        await w.write(serializeProject(this.designName || "Projeto", this.layers, this.image));
        await w.close();
        this.renderLegend();
        return this.host.toast(`Projeto salvo: ${this.fileHandle.name}`);
      } catch (err) {
        if ((err as DOMException).name === "AbortError") return;
        this.fileHandle = null; // sem permissão: cai no download
      }
    }
    if (asNew) {
      const name = await this.askName();
      if (!name) return;
      this.designName = name;
      this.renderLegend();
    }
    this.download(`${this.fileBase()}${PROJECT_EXT}`, serializeProject(this.designName || "Projeto", this.layers, this.image), "application/json");
    this.host.toast(`Projeto baixado como ${this.fileBase()}${PROJECT_EXT} (pasta de downloads).`);
  }

  private askName(): Promise<string | null> {
    const dlg = $<HTMLDialogElement>("dlg-saveas");
    const input = $<HTMLInputElement>("sa-name");
    input.value = this.designName || "Projeto";
    return new Promise((resolve) => {
      dlg.addEventListener("close", () => resolve(dlg.returnValue === "ok" && input.value.trim() ? input.value.trim() : null), { once: true });
      dlg.returnValue = "";
      dlg.showModal();
      input.select();
    });
  }

  /** "Limpar mesa" na vista Desenho. */
  async clear(): Promise<void> {
    if (!this.layers.some((l) => l.shapes.length) && !this.image) return this.host.toast("A mesa já está vazia.");
    if (await this.host.confirm("Limpar a mesa?", "Todos os elementos e a imagem saem da mesa. Salve antes se quiser guardar o projeto.", "Limpar mesa", true)) {
      this.resetDesign("");
      this.fileHandle = null;
      this.refresh();
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
    const ids = this.groupIds(found.s);
    const already = ids.every((x) => this.selected.has(x));
    if (!add) {
      // clique simples sempre deixa a peça selecionada (clicar de novo não tira a seleção)
      this.selected.clear();
      ids.forEach((x) => this.selected.add(x));
    } else if (already) ids.forEach((x) => this.selected.delete(x));
    else ids.forEach((x) => this.selected.add(x));
    this.refreshSelection();
  }

  /** O elemento e todos os do mesmo grupo (em qualquer camada). */
  private groupIds(s: Shape): string[] {
    if (!s.group) return [s.id];
    return this.layers.flatMap((l) => l.shapes.filter((x) => x.group === s.group).map((x) => x.id));
  }

  /**
   * Caixa de seleção. Arrastando para a direita: pega o que está inteiro dentro.
   * Para a esquerda: pega também o que a caixa só encosta. Grupos vêm inteiros.
   */
  private selectArea(a: Point, b: Point, add: boolean): void {
    const [ax, ay] = this.view.toMm(a[0], a[1]);
    const [bx, by] = this.view.toMm(b[0], b[1]);
    const r = { minX: Math.min(ax, bx), maxX: Math.max(ax, bx), minY: Math.min(ay, by), maxY: Math.max(ay, by) };
    const touching = b[0] < a[0];
    const inside = (p: Point): boolean => p[0] >= r.minX && p[0] <= r.maxX && p[1] >= r.minY && p[1] <= r.maxY;
    const picked: Shape[] = [];
    for (const l of this.layers) {
      if (!l.enabled) continue;
      for (const s of l.shapes) {
        const ok = touching ? s.points.some(inside) || s.points.some((p, i) => i > 0 && segmentHitsRect(s.points[i - 1]!, p, r)) : s.points.every(inside);
        if (ok) picked.push(s);
      }
    }
    if (!add) this.selected.clear();
    for (const s of picked) for (const id of this.groupIds(s)) this.selected.add(id);
    this.refreshSelection();
    if (!picked.length) this.host.toast(touching ? "A caixa não encostou em nenhum elemento." : "Nenhum elemento ficou inteiro dentro da caixa. Arraste para a esquerda para pegar o que ela só encosta.");
  }

  private groupSel(): void {
    const items = this.selItems();
    if (new Set(items.map(({ s }) => s.group ?? s.id)).size < 2) return this.host.toast("Selecione dois ou mais elementos para agrupar.");
    this.history.push(this.layers);
    const g = newId("GU"); // "GU" = grupo feito pela pessoa (o nome mostra "Grupo de N elementos")
    for (const { s } of items) s.group = g;
    this.refresh();
    this.host.toast(`${items.length} elementos agrupados: agora andam juntos.`);
  }

  private ungroupSel(): void {
    const items = this.selItems().filter(({ s }) => s.group);
    if (!items.length) return this.host.toast("Nada agrupado na seleção.");
    this.history.push(this.layers);
    for (const { s } of items) delete s.group;
    this.refresh();
    this.host.toast(`Desagrupado: clique num elemento para selecionar só ele.`);
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
      this.refreshSelection();
    }
  }

  /** Selecionados que podem ser mexidos (os travados ficam onde estão). */
  private movable(): Array<{ s: Shape; l: Layer }> {
    return this.selItems().filter(({ s }) => !s.locked);
  }

  private warnLocked(): boolean {
    const locked = this.selItems().filter(({ s }) => s.locked).length;
    if (locked && !this.movable().length) {
      this.host.toast("Peça travada: use Editar > Destravar peça para mexer nela.");
      return true;
    }
    if (locked) this.host.toast(`${locked} elemento(s) travado(s) ficaram onde estavam.`);
    return false;
  }

  private transform(fn: (p: Point) => Point): void {
    const items = this.movable();
    if (this.warnLocked() || !items.length) return;
    this.history.push(this.layers);
    for (const { s } of items) s.points = s.points.map(fn);
    this.refresh();
  }

  private movableBounds(): Bounds | null {
    return boundsOf(this.movable().flatMap(({ s }) => s.points));
  }

  private moveSel(dx: number, dy: number): void {
    this.transform(([x, y]) => [x + dx, y + dy]);
  }

  private rotateSel(deg: number): void {
    const b = this.movableBounds();
    if (!b) return;
    const cx = (b.minX + b.maxX) / 2;
    const cy = (b.minY + b.maxY) / 2;
    const a = (deg * Math.PI) / 180;
    const c = Math.cos(a);
    const sn = Math.sin(a);
    this.transform(([x, y]) => [cx + (x - cx) * c - (y - cy) * sn, cy + (x - cx) * sn + (y - cy) * c]);
  }

  private scaleSel(sx: number, sy: number): void {
    const b = this.movableBounds();
    if (!b) return;
    const cx = (b.minX + b.maxX) / 2;
    const cy = (b.minY + b.maxY) / 2;
    this.transform(([x, y]) => [cx + (x - cx) * sx, cy + (y - cy) * sy]);
  }

  private alignSel(how: string): void {
    const items = this.movable();
    const all = boundsOf(items.flatMap(({ s }) => s.points));
    if (this.warnLocked() || !items.length || !all) return;
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
    const items = this.movable();
    if (this.warnLocked() || !items.length) return;
    this.history.push(this.layers);
    for (const { s, l } of items) l.shapes = l.shapes.filter((x) => x.id !== s.id);
    this.selected.clear();
    this.refresh();
    this.host.toast(`${items.length} elemento(s) excluído(s). Ctrl+Z desfaz.`);
  }

  /** Espaços iguais entre as peças (grupos contam como uma peça), mantendo as duas das pontas. */
  private distributeSel(axis: "x" | "y"): void {
    const units = new Map<string, Shape[]>();
    for (const { s } of this.movable()) units.set(s.group ?? s.id, [...(units.get(s.group ?? s.id) ?? []), s]);
    if (units.size < 3) return this.host.toast("Selecione três ou mais peças (destravadas) para distribuir.");
    const list = [...units.values()].map((shapes) => ({ shapes, b: boundsOf(shapes.flatMap((s) => s.points))! }));
    const lo = (b: Bounds): number => (axis === "x" ? b.minX : b.minY);
    const size = (b: Bounds): number => (axis === "x" ? b.maxX - b.minX : b.maxY - b.minY);
    list.sort((a, b) => lo(a.b) - lo(b.b));
    const first = list[0]!.b;
    const last = list[list.length - 1]!.b;
    const span = (axis === "x" ? last.maxX : last.maxY) - lo(first);
    const gap = (span - list.reduce((acc, u) => acc + size(u.b), 0)) / (list.length - 1);
    this.history.push(this.layers);
    let pos = lo(first);
    for (const u of list) {
      const d = pos - lo(u.b);
      for (const s of u.shapes) s.points = s.points.map(([x, y]) => (axis === "x" ? [x + d, y] : [x, y + d]) as Point);
      pos += size(u.b) + gap;
    }
    this.refresh();
    this.host.toast(gap < 0 ? "Distribuído, mas as peças se sobrepõem: afaste as das pontas." : `Distribuído: ${gap.toFixed(1)} mm entre as peças.`);
  }

  private copySel(): boolean {
    const items = this.selItems();
    if (!items.length) return false;
    this.clipboard = items.map(({ s, l }) => ({
      layer: { id: l.id, name: l.name, color: l.color, mode: l.mode, materialId: l.materialId, settings: structuredClone(l.settings) },
      shape: structuredClone(s),
    }));
    this.pasteCount = 0;
    this.renderSelection();
    return true;
  }

  private cutSel(): void {
    if (!this.copySel()) return;
    const locked = this.selItems().some(({ s }) => s.locked);
    this.deleteSel();
    this.host.toast(locked ? "Recortado (os travados foram copiados, mas ficaram na mesa)." : "Recortado. Ctrl+V cola.");
  }

  /** Cola os copiados 10 mm ao lado (cada colagem anda mais 10 mm), na mesma camada de onde vieram. */
  private paste(): void {
    if (!this.clipboard.length) return this.host.toast("Nada copiado ainda: selecione e use Copiar (Ctrl+C).");
    this.history.push(this.layers);
    this.pasteCount++;
    const off = 10 * this.pasteCount;
    const groups = new Map<string, string>();
    const texts = new Map<string, string>();
    const remap = (map: Map<string, string>, key: string, prefix: string): string => {
      if (!map.has(key)) map.set(key, newId(prefix));
      return map.get(key)!;
    };
    this.selected.clear();
    for (const { layer, shape } of this.clipboard) {
      let target = this.layers.find((l) => l.id === layer.id) ?? this.layers.find((l) => l.name === layer.name);
      if (!target) {
        target = { ...structuredClone(layer), id: newId("L"), enabled: true, shapes: [] };
        this.layers.push(target);
      }
      const copy: Shape = { ...structuredClone(shape), id: newId("S"), points: shape.points.map(([x, y]) => [x + off, y - off] as Point) };
      delete copy.locked;
      if (shape.group) copy.group = remap(groups, shape.group, "G");
      if (shape.text) copy.text = { ...shape.text, id: remap(texts, shape.text.id, "T") };
      target.shapes.push(copy);
      this.selected.add(copy.id);
    }
    this.refresh();
    this.host.toast(`${this.clipboard.length} elemento(s) colado(s) ${off} mm ao lado.`);
  }

  private setLocked(locked: boolean, all = false): void {
    const items = all ? this.layers.flatMap((l) => l.shapes.map((s) => ({ s, l }))) : this.selItems();
    const change = items.filter(({ s }) => !!s.locked !== locked);
    if (!change.length) return this.host.toast(locked ? "Já está travado." : "Nada travado.");
    this.history.push(this.layers);
    for (const { s } of change) {
      if (locked) s.locked = true;
      else delete s.locked;
    }
    this.refresh();
    this.host.toast(locked ? `${change.length} elemento(s) travado(s): não se movem nem são excluídos.` : `${change.length} elemento(s) destravado(s).`);
  }

  /** Ações do menu Editar (e atalhos). */
  private editAction(act: string): void {
    if (act === "undo") this.undo();
    else if (act === "copy") {
      if (this.copySel()) this.host.toast(`${this.clipboard.length} elemento(s) copiado(s). Ctrl+V cola.`);
    } else if (act === "cut") this.cutSel();
    else if (act === "paste") this.paste();
    else if (act === "duplicate") this.duplicateSel();
    else if (act === "delete") this.deleteSel();
    else if (act === "selectall") {
      this.selected.clear();
      for (const l of this.layers) if (l.enabled) for (const s of l.shapes) this.selected.add(s.id);
      this.refreshSelection();
    } else if (act === "group") this.groupSel();
    else if (act === "ungroup") this.ungroupSel();
    else if (act === "dist-h") this.distributeSel("x");
    else if (act === "dist-v") this.distributeSel("y");
    else if (act === "lock") this.setLocked(true);
    else if (act === "unlock") this.setLocked(false);
    else if (act === "unlockall") this.setLocked(false, true);
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
    this.requestDraw();
    return this.result;
  }

  private scheduleGenerate(): void {
    window.clearTimeout(this.genTimer);
    this.genTimer = window.setTimeout(() => this.regenerateNow(), 250);
  }

  // ---------- painéis ----------

  private refresh(): void {
    $("p-empty").hidden = this.layers.some((l) => l.shapes.length) || !!this.image;
    this.renderSelection();
    this.renderLayers();
    this.renderLegend();
    $<HTMLButtonElement>("p-undo").disabled = !this.history.canUndo;
    this.scheduleGenerate();
    this.requestDraw();
  }

  /**
   * Só a seleção mudou: atualiza a barra de medidas, marca os itens da lista e
   * redesenha. Não reconstrói as camadas nem refaz o G-code (era o que deixava
   * cada clique lento).
   */
  private refreshSelection(): void {
    this.renderSelection();
    for (const el of $("p-layers").querySelectorAll<HTMLElement>(".item")) el.dataset.sel = String(this.selected.has(el.dataset.id ?? ""));
    this.requestDraw();
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

  /** Atualiza a barra de medidas e a faixa de operações (fixas no HTML). */
  private renderSelection(): void {
    const items = this.selItems();
    const has = items.length > 0;
    const b = this.selBounds();
    const props = $("p-props");
    props.querySelectorAll<HTMLElement>("input, button, summary").forEach((el) => {
      if (el instanceof HTMLInputElement || el instanceof HTMLButtonElement) el.disabled = !has;
      else el.toggleAttribute("aria-disabled", !has);
    });
    if (!has) props.querySelectorAll("details").forEach((d) => (d.open = false));
    const groups = new Set(items.map(({ s }) => s.group ?? s.id));
    const first = items[0];
    $("ed-name").textContent = !first
      ? "Nada selecionado"
      : groups.size === 1 && first.s.group?.startsWith("GU")
        ? `Grupo de ${items.length} elementos`
        : groups.size === 1
        ? `${first.s.group ? first.s.name.replace(/: (furo \d+|gravação)$/, "") : first.s.name} · camada ${first.l.name}`
        : `${items.length} elementos`;
    $("ed-name").title = $("ed-name").textContent ?? "";
    const setVal = (id: string, v: number | null): void => {
      const input = $<HTMLInputElement>(id);
      if (document.activeElement !== input) input.value = v === null ? "" : v.toFixed(1);
    };
    setVal("ed-x", b ? b.minX : null);
    setVal("ed-y", b ? b.minY : null);
    setVal("ed-w", b ? b.maxX - b.minX : null);
    setVal("ed-h", b ? b.maxY - b.minY : null);
    $("ed-lock").setAttribute("aria-pressed", String(this.lockRatio));
    $("ed-align-label").textContent = groups.size > 1 ? "Alinhar entre si" : "Alinhar na mesa";
    const lockedSel = items.filter(({ s }) => s.locked).length;
    const anyLocked = this.layers.some((l) => l.shapes.some((s) => s.locked));
    const enable: Record<string, boolean> = {
      undo: this.history.canUndo,
      copy: has,
      cut: has,
      paste: this.clipboard.length > 0,
      duplicate: has,
      delete: has && lockedSel < items.length,
      selectall: this.layers.some((l) => l.shapes.length),
      group: groups.size >= 2,
      ungroup: items.some(({ s }) => s.group),
      "dist-h": groups.size >= 3,
      "dist-v": groups.size >= 3,
      lock: has && lockedSel < items.length,
      unlock: lockedSel > 0,
      unlockall: anyLocked,
    };
    for (const btn of $("edit-menu").querySelectorAll<HTMLButtonElement>("button[data-edit]")) btn.disabled = !enable[btn.dataset.edit ?? ""];
    for (const btn of $("edit-menu").querySelectorAll<HTMLButtonElement>("button[data-align]")) btn.disabled = !has;
    if (lockedSel) $("ed-name").textContent = `🔒 ${$("ed-name").textContent ?? ""}`;
    $<HTMLButtonElement>("ed-group").disabled = groups.size < 2;
    $<HTMLButtonElement>("ed-ungroup").disabled = !items.some(({ s }) => s.group);
    // faixa de operações
    const modes = new Set(items.map(({ s, l }) => effectiveMode(s, l)));
    const current = has && modes.size === 1 ? [...modes][0]! : null;
    const custom = items.some(({ s }) => s.mode !== null);
    const anyOpen = items.some(({ s }) => !s.closed);
    $("p-ops-buttons").querySelectorAll<HTMLButtonElement>("button").forEach((btn) => {
      const m = btn.dataset.mode ?? "";
      btn.disabled = !has || (anyOpen && (m === "fill" || m === "detail"));
      btn.setAttribute("aria-pressed", String(has && (m ? current === m : !custom)));
    });
    $("p-ops-hint").textContent = !has
      ? "Selecione um elemento na mesa para mudar a operação."
      : anyOpen
        ? "Caminhos abertos não podem ser preenchidos: ficam como Gravar linha."
        : "";
  }

  /** Liga a barra de medidas e a faixa de operações uma vez só. */
  private bindProps(): void {
    $("p-ops-buttons").innerHTML =
      MODES.map(
        (m) => `<button type="button" data-mode="${m}" style="--c:${MODE_INFO[m].color}" title="${MODE_INFO[m].hint}"><span class="dot"></span>${MODE_INFO[m].label}</button>`,
      ).join("") + `<button type="button" data-mode="">Padrão da camada</button>`;
    $("p-ops-buttons").addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-mode]");
      const items = this.selItems();
      if (!btn || !items.length) return;
      this.history.push(this.layers);
      for (const { s } of items) s.mode = (btn.dataset.mode as VectorMode | "") || null;
      this.refresh();
    });
    const num = (id: string): number => Number($<HTMLInputElement>(id).value);
    const bounds = (): Bounds | null => this.selBounds();
    $("ed-x").addEventListener("change", () => {
      const b = bounds();
      if (b) this.moveSel(num("ed-x") - b.minX, 0);
    });
    $("ed-y").addEventListener("change", () => {
      const b = bounds();
      if (b) this.moveSel(0, num("ed-y") - b.minY);
    });
    $("ed-w").addEventListener("change", () => {
      const b = bounds();
      if (!b) return;
      const k = num("ed-w") / Math.max(1e-6, b.maxX - b.minX);
      if (k > 0) this.scaleSel(k, this.lockRatio ? k : 1);
    });
    $("ed-h").addEventListener("change", () => {
      const b = bounds();
      if (!b) return;
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
    $("edit-menu").addEventListener("click", (e) => {
      const draw = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-draw]");
      if (draw) {
        $<HTMLDetailsElement>("edit-menu").open = false;
        this.setDrawTool(draw.dataset.draw as DrawTool);
        return;
      }
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-edit], button[data-align]");
      if (!btn || btn.disabled) return;
      $<HTMLDetailsElement>("edit-menu").open = false;
      if (btn.dataset.align) this.alignSel(btn.dataset.align);
      else this.editAction(btn.dataset.edit ?? "");
    });
    $("ed-off-go").addEventListener("click", () => {
      this.offsetSel(num("ed-off"));
      $<HTMLDetailsElement>("ed-off-menu").open = false;
    });
    $("ed-group").addEventListener("click", () => this.groupSel());
    $("ed-ungroup").addEventListener("click", () => this.ungroupSel());
    $("ed-dup").addEventListener("click", () => this.duplicateSel());
    $("ed-del").addEventListener("click", () => this.deleteSel());
    $("p-undo").addEventListener("click", () => this.undo());
    $("ed-clear").addEventListener("click", () => {
      this.selected.clear();
      this.refreshSelection();
    });
    // um menu aberto fecha o outro e fecha ao clicar fora
    const menus = [...document.querySelectorAll<HTMLDetailsElement>("details.menu")];
    for (const m of menus) {
      m.addEventListener("toggle", () => {
        if (!m.open) return;
        menus.forEach((o) => o !== m && (o.open = false));
        // perto da borda direita, o menu abre para a esquerda
        m.classList.toggle("flip", m.getBoundingClientRect().left + 360 > window.innerWidth);
      });
    }
    document.addEventListener("pointerdown", (e) => {
      for (const m of menus) if (m.open && !m.contains(e.target as Node)) m.open = false;
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
    } else limitsEl.textContent = "";
    // detalhes do trabalho: aparecem ao parar o mouse sobre o resumo, sem ocupar espaço na barra
    $("p-summary").title = r
      ? `Área útil ${area.x} × ${area.y} mm · maior potência S${r.maxS} de S${this.limits.maxSpindle} · M4 (potência dinâmica)${this.haveLimits ? "" : " · conecte ao agente para usar os limites reais da máquina"}`
      : "";
    const empty = !r;
    $<HTMLButtonElement>("p-send").disabled = empty || out;
    $<HTMLButtonElement>("p-enqueue").disabled = empty || out;
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
      ctx.strokeStyle = bedColors().travel;
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
      ctx.strokeStyle = bedColors().burned;
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
          ctx.strokeStyle = s.locked ? "#9aa0a6" : bedColors().selection;
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
          ctx.strokeStyle = bedColors().burning;
          ctx.lineWidth = 2.2 * d;
          v.polyline([next.from, head]);
          ctx.stroke();
        }
      } else if (last) head = last.to;
    }
    if (anim || this.headLive) v.drawHead(head, lit);
    const mq = this.marquee;
    if (mq) {
      const touching = mq.b[0] < mq.a[0];
      ctx.save();
      ctx.lineWidth = 1.2 * d;
      ctx.setLineDash(touching ? [6 * d, 4 * d] : []);
      ctx.strokeStyle = touching ? "#34a853" : "#4da3ff";
      ctx.fillStyle = touching ? "rgba(52,168,83,.12)" : "rgba(77,163,255,.12)";
      const x = Math.min(mq.a[0], mq.b[0]);
      const y = Math.min(mq.a[1], mq.b[1]);
      ctx.fillRect(x, y, Math.abs(mq.b[0] - mq.a[0]), Math.abs(mq.b[1] - mq.a[1]));
      ctx.strokeRect(x, y, Math.abs(mq.b[0] - mq.a[0]), Math.abs(mq.b[1] - mq.a[1]));
      ctx.restore();
    }
    const dr = this.drawing && this.drawGeometry(this.drawing.a, this.drawing.b, this.drawing.shift, this.drawing.free);
    if (dr) {
      ctx.save();
      ctx.strokeStyle = bedColors().selection;
      ctx.lineWidth = 1.6 * d;
      ctx.setLineDash([6 * d, 4 * d]);
      v.polyline(dr.points);
      ctx.stroke();
      ctx.setLineDash([]);
      // medida perto do cursor
      const end = this.drawing!.b;
      const tx = v.X(end[0]) + 12 * d;
      const ty = v.Y(end[1]) - 12 * d;
      ctx.font = `${12 * d}px ui-monospace, monospace`;
      const tw = ctx.measureText(dr.label).width;
      ctx.fillStyle = "rgba(20, 22, 26, .88)";
      ctx.fillRect(tx - 4 * d, ty - 13 * d, tw + 8 * d, 18 * d);
      ctx.fillStyle = "#fff";
      ctx.fillText(dr.label, tx, ty);
      ctx.restore();
    }
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
    if (!this.host.isConnected()) return this.host.toast("Conecte ao agente (aba Máquina, à direita) para enviar o trabalho.");
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

  /** Guarda na fila do agente. Não liga o laser: iniciar pede confirmação depois. */
  private enqueueJob(): void {
    if (!this.host.isConnected()) return this.host.toast("Conecte ao agente (aba Máquina, à direita) para guardar na fila.");
    const r = this.regenerateNow();
    if (!r) return;
    const name = `${this.designName || "Trabalho"}.gcode`;
    if (this.host.send({ type: "queueAdd", name, gcode: r.gcode })) {
      this.host.onQueued(name, r.gcode);
      this.host.toast(`"${name}" enviado para a fila (${fmtTime(r.estimatedSeconds)}). Inicie pela aba Fila.`);
    }
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
      : "Sem conexão com o agente: você pode ver os exemplos, mas para salvar precisa conectar (aba Máquina).";
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
    $<HTMLInputElement>("p-file-import").addEventListener("change", (e) => {
      const input = e.target as HTMLInputElement;
      void this.handleFile(input.files?.[0]).finally(() => (input.value = ""));
    });
    $<HTMLInputElement>("p-file-project").addEventListener("change", (e) => {
      const input = e.target as HTMLInputElement;
      const file = input.files?.[0];
      input.value = "";
      if (file) void file.text().then((t) => this.openProjectText(t)).catch((err: Error) => this.host.toast(err.message));
    });
    $("file-menu").addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-file]");
      if (!btn) return;
      $<HTMLDetailsElement>("file-menu").open = false;
      const act = btn.dataset.file;
      if (act === "open") $("p-file-project").click();
      else if (act === "save") void this.saveProject(false);
      else if (act === "saveas") void this.saveProject(true);
      else if (act === "import") $("p-file-import").click();
      else if (act === "sample") this.loadSample();
      else if (act === "export-svg") this.exportSvg();
      else if (act === "export-dxf") this.exportDxf();
      else if (act === "export-gcode") this.exportGcode();
    });
    document.addEventListener("keydown", (e) => {
      if (!(e.ctrlKey || e.metaKey) || document.querySelector("dialog[open]")) return;
      const key = e.key.toLowerCase();
      if (key === "s") {
        e.preventDefault();
        void this.saveProject(e.shiftKey);
      } else if (key === "o") {
        e.preventDefault();
        $("p-file-project").click();
      }
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
    $("p-text").addEventListener("click", () => {
      const dlg = $<HTMLDialogElement>("dlg-text");
      const sel = $<HTMLSelectElement>("tx-font");
      const mode = $<HTMLSelectElement>("tx-mode");
      const sync = (): void => void this.syncFontUi(sel, $("tx-sample"), mode, $("tx-font-note"));
      this.fillFonts(sel, this.lastFont());
      sel.onchange = () => {
        this.rememberFont(sel.value);
        sync();
      };
      mode.onchange = () => (mode.dataset.touched = "1");
      $<HTMLTextAreaElement>("tx-text").oninput = sync;
      $("tx-font-load").onclick = () => this.pickFontFile(sel, () => sel.onchange?.(new Event("change")));
      sync();
      dlg.addEventListener("close", () => dlg.returnValue === "ok" && void this.addText(), { once: true });
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
    $("p-panel").addEventListener("click", () => this.openPanel());
    $("p-area").addEventListener("click", (e) => {
      this.areaMode = !this.areaMode;
      (e.currentTarget as HTMLElement).setAttribute("aria-pressed", String(this.areaMode));
      this.host.toast(
        this.areaMode
          ? "Arraste no espaço vazio da mesa: para a direita pega o que fica inteiro dentro; para a esquerda, o que a caixa encosta. Para mover a vista, desligue Área."
          : "Arrastar no vazio volta a mover a vista. Shift + arrastar ainda desenha a caixa.",
      );
    });
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
    $("p-enqueue").addEventListener("click", () => this.enqueueJob());
    document.addEventListener("keydown", (e) => {
      if ($("p-box").hidden) return;
      const tag = (e.target as HTMLElement).tagName.toLowerCase();
      if (tag === "input" || tag === "select" || tag === "textarea" || document.querySelector("dialog[open]")) return;
      const key = e.key.toLowerCase();
      if (e.key === "Escape" && this.drawTool) {
        this.setDrawTool(null);
        return;
      }
      if (!e.ctrlKey && !e.metaKey && !e.altKey && DRAW_KEYS[key]) {
        e.preventDefault();
        this.setDrawTool(DRAW_KEYS[key]!);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && key === "z") {
        e.preventDefault();
        this.undo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && (key === "c" || key === "x" || key === "v" || key === "l")) {
        e.preventDefault();
        this.editAction(key === "c" ? "copy" : key === "x" ? "cut" : key === "v" ? "paste" : e.shiftKey ? "unlock" : "lock");
        return;
      }
      if ((e.ctrlKey || e.metaKey) && key === "a") {
        e.preventDefault();
        this.selected.clear();
        for (const l of this.layers) if (l.enabled) for (const s of l.shapes) this.selected.add(s.id);
        this.refreshSelection();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && key === "g") {
        e.preventDefault();
        if (e.shiftKey) this.ungroupSel();
        else this.groupSel();
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
        this.refreshSelection();
      }
    });
  }

  /** Chamado ao mostrar a mesa "Desenho": o canvas pode ter mudado de tamanho enquanto estava escondido. */
  shown(): void {
    this.view.resize();
  }
}

/** O segmento ab cruza o retângulo? (Liang–Barsky) */
function segmentHitsRect(a: Point, b: Point, r: Bounds): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0;
    const t = q / p;
    if (p < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
    return true;
  };
  return clip(-dx, a[0] - r.minX) && clip(dx, r.maxX - a[0]) && clip(-dy, a[1] - r.minY) && clip(dy, r.maxY - a[1]) && t0 <= t1;
}

function segDist(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}
