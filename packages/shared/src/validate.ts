import { QUEUE_MAX_NAME } from "./protocol.js";
import type { Axis, ClientMessage, FrameBounds, Material, MaterialMode, MaterialPreset } from "./protocol.js";

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isAxis(v: unknown): v is Axis {
  return v === "X" || v === "Y";
}

/**
 * Confere em tempo de execução uma mensagem recebida do cliente.
 * Devolve `null` para qualquer coisa fora do protocolo.
 */
export function parseClientMessage(value: unknown): ClientMessage | null {
  if (!isObj(value) || typeof value.type !== "string") return null;
  switch (value.type) {
    case "jog":
      if (!isAxis(value.axis) || !isFiniteNumber(value.distance) || !isFiniteNumber(value.feed)) return null;
      return { type: "jog", axis: value.axis, distance: value.distance, feed: value.feed };
    case "setOrigin": {
      if (value.x === undefined && value.y === undefined) return { type: "setOrigin" };
      if (!isFiniteNumber(value.x) || !isFiniteNumber(value.y)) return null;
      return { type: "setOrigin", x: value.x, y: value.y };
    }
    case "home":
    case "hold":
    case "stop":
    case "unlock":
      return { type: value.type };
    case "resume":
      if (value.confirmLaserOn !== true) return null;
      return { type: "resume", confirmLaserOn: true };
    case "job":
      if (typeof value.name !== "string" || typeof value.gcode !== "string") return null;
      if (value.confirmLaserOn !== true) return null;
      return { type: "job", name: value.name, gcode: value.gcode, confirmLaserOn: true };
    case "ping":
      if (!isFiniteNumber(value.t)) return null;
      return { type: "ping", t: value.t };
    case "frame": {
      const bounds = parseBounds(value.bounds);
      if (!bounds) return null;
      if (value.laser === "off") return { type: "frame", bounds, laser: "off" };
      if (value.laser === "min" && value.confirmLaserOn === true) return { type: "frame", bounds, laser: "min", confirmLaserOn: true };
      return null;
    }
    case "materialsSave": {
      const materials = parseMaterials(value.materials);
      return materials ? { type: "materialsSave", materials } : null;
    }
    case "queueAdd":
      if (typeof value.name !== "string" || typeof value.gcode !== "string") return null;
      if (value.name.trim().length === 0 || value.name.length > QUEUE_MAX_NAME) return null;
      return { type: "queueAdd", name: value.name.trim(), gcode: value.gcode };
    case "projectsList":
      return { type: "projectsList" };
    case "projectGet":
      if (typeof value.path !== "string" || value.path.length > 300) return null;
      return { type: "projectGet", path: value.path };
    case "queueRemove":
      if (!isId(value.id)) return null;
      return { type: "queueRemove", id: value.id };
    case "queueMove":
      if (!isId(value.id) || !isFiniteNumber(value.index) || !Number.isInteger(value.index)) return null;
      return { type: "queueMove", id: value.id, index: value.index };
    case "queueStart":
      if (!isId(value.id) || value.confirmLaserOn !== true) return null;
      return { type: "queueStart", id: value.id, confirmLaserOn: true };
    default:
      return null;
  }
}

function isId(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= 64;
}

function parseBounds(v: unknown): FrameBounds | null {
  if (!isObj(v)) return null;
  const { minX, minY, maxX, maxY } = v;
  if (!isFiniteNumber(minX) || !isFiniteNumber(minY) || !isFiniteNumber(maxX) || !isFiniteNumber(maxY)) return null;
  if (maxX < minX || maxY < minY) return null;
  return { minX, minY, maxX, maxY };
}

const MATERIAL_MODES: readonly MaterialMode[] = ["cut", "line", "fill", "detail", "raster"];

function parsePreset(v: unknown): MaterialPreset | null {
  if (!isObj(v)) return null;
  const mode = MATERIAL_MODES.find((m) => m === v.mode);
  const { speed, power, passes } = v;
  if (!mode || !isFiniteNumber(speed) || speed <= 0 || speed > 100000) return null;
  if (!isFiniteNumber(power) || power < 0 || power > 100) return null;
  if (!isFiniteNumber(passes) || !Number.isInteger(passes) || passes < 1 || passes > 50) return null;
  const preset: MaterialPreset = { mode, speed, power, passes };
  if (v.kerf !== undefined) {
    if (!isFiniteNumber(v.kerf) || v.kerf < 0 || v.kerf > 2) return null;
    preset.kerf = v.kerf;
  }
  if (v.interval !== undefined) {
    if (!isFiniteNumber(v.interval) || v.interval < 0.02 || v.interval > 2) return null;
    preset.interval = v.interval;
  }
  return preset;
}

/** Biblioteca de materiais: até 200 materiais, nomes de até 80 caracteres. */
export function parseMaterials(v: unknown): Material[] | null {
  if (!Array.isArray(v) || v.length > 200) return null;
  const out: Material[] = [];
  const ids = new Set<string>();
  for (const item of v) {
    if (!isObj(item)) return null;
    const { id, name, thickness, notes, presets } = item;
    if (typeof id !== "string" || id.length === 0 || id.length > 64 || ids.has(id)) return null;
    if (typeof name !== "string" || name.trim().length === 0 || name.length > 80) return null;
    if (!isFiniteNumber(thickness) || thickness < 0 || thickness > 100) return null;
    if (notes !== undefined && (typeof notes !== "string" || notes.length > 500)) return null;
    if (!Array.isArray(presets) || presets.length > 10) return null;
    const parsed = presets.map(parsePreset);
    if (parsed.some((p) => p === null)) return null;
    ids.add(id);
    const m: Material = { id, name: name.trim(), thickness, presets: parsed as MaterialPreset[] };
    if (typeof notes === "string" && notes) m.notes = notes;
    out.push(m);
  }
  return out;
}
