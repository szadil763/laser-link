import { DEFAULT_MATERIALS, type Material } from "@laserlink/shared";
import { importImage } from "./importers.js";
import { newId, rebuildImage, type ImageItem, type Layer, type Shape } from "./model.js";

/**
 * Arquivo de projeto próprio do LaserLink (.laserlink): JSON com as camadas,
 * os elementos, as operações e a imagem (em PNG embutido).
 */
export const PROJECT_FORMAT = "laserlink-projeto";
export const PROJECT_EXT = ".laserlink";

interface SavedImage extends Omit<ImageItem, "source" | "bitmap" | "bw" | "bh" | "preview"> {
  dataUrl: string;
}

interface ProjectFile {
  format: typeof PROJECT_FORMAT;
  version: 1;
  name: string;
  savedAt: string;
  layers: Layer[];
  image: SavedImage | null;
}

function imageToDataUrl(img: ImageItem): string {
  const c = document.createElement("canvas");
  c.width = img.sourceWidth;
  c.height = img.sourceHeight;
  c.getContext("2d")!.drawImage(img.source, 0, 0);
  return c.toDataURL("image/png");
}

export function serializeProject(name: string, layers: readonly Layer[], image: ImageItem | null): string {
  let saved: SavedImage | null = null;
  if (image) {
    const { source: _s, bitmap: _b, bw: _bw, bh: _bh, preview: _p, ...rest } = image;
    saved = { ...rest, dataUrl: imageToDataUrl(image) };
  }
  const file: ProjectFile = { format: PROJECT_FORMAT, version: 1, name, savedAt: new Date().toISOString(), layers: [...layers], image: saved };
  return JSON.stringify(file);
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Lê um projeto salvo. Gera ids novos para não colidir com os que a mesa já usa. */
export async function parseProject(text: string, materials: readonly Material[]): Promise<{ name: string; layers: Layer[]; image: ImageItem | null }> {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Esse arquivo não é um projeto do Sapienza LaserLink.");
  }
  if (!isObj(data) || data.format !== PROJECT_FORMAT || !Array.isArray(data.layers)) throw new Error("Esse arquivo não é um projeto do Sapienza LaserLink.");
  if (data.version !== 1) throw new Error("Projeto salvo por uma versão mais nova do Sapienza LaserLink. Atualize o app.");
  const groups = new Map<string, string>();
  const texts = new Map<string, string>();
  const remap = (map: Map<string, string>, key: string, prefix: string): string => {
    if (!map.has(key)) map.set(key, newId(prefix));
    return map.get(key)!;
  };
  const layers = (data.layers as Layer[]).map((l) => ({
    ...l,
    id: newId("L"),
    shapes: l.shapes.map((s): Shape => {
      const sh: Shape = { ...s, id: newId("S") };
      if (s.group) sh.group = remap(groups, s.group, "G");
      if (s.text) sh.text = { ...s.text, id: remap(texts, s.text.id, "T") };
      return sh;
    }),
  }));
  let image: ImageItem | null = null;
  if (isObj(data.image) && typeof data.image.dataUrl === "string") {
    const saved = data.image as unknown as SavedImage;
    const blob = await (await fetch(saved.dataUrl)).blob();
    const mat = materials.find((m) => m.id === saved.materialId) ?? materials[0] ?? DEFAULT_MATERIALS[0];
    image = await importImage(new File([blob], saved.name, { type: "image/png" }), mat, saved.settings);
    const { dataUrl: _d, ...props } = saved;
    Object.assign(image, props);
    rebuildImage(image);
  }
  return { name: typeof data.name === "string" ? data.name : "Projeto", layers, image };
}
