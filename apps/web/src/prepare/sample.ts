import type { Point } from "@laserlink/gcode";
import type { Material } from "@laserlink/shared";
import { makeLayer, makeShape, presetFor, rebuildImage, type ImageItem, type Layer } from "./model.js";

function roundedRect(x: number, y: number, w: number, h: number, r: number): Point[] {
  const pts: Point[] = [];
  const arc = (cx: number, cy: number, a0: number): void => {
    for (let i = 0; i <= 8; i++) {
      const a = a0 + (i / 8) * (Math.PI / 2);
      pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
  };
  arc(x + w - r, y + r, -Math.PI / 2);
  arc(x + w - r, y + h - r, 0);
  arc(x + r, y + h - r, Math.PI / 2);
  arc(x + r, y + r, Math.PI);
  pts.push(pts[0]!);
  return pts;
}

function circle(cx: number, cy: number, r: number, n = 48): Point[] {
  const pts: Point[] = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
}

/** Esfera iluminada desenhada por código (para não depender de arquivo). */
function sphere(): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = c.height = 160;
  const g = c.getContext("2d")!;
  const d = g.createImageData(160, 160);
  for (let y = 0; y < 160; y++) {
    for (let x = 0; x < 160; x++) {
      const nx = (x - 80) / 62;
      const ny = (y - 80) / 62;
      const r2 = nx * nx + ny * ny;
      let v = 255;
      if (r2 <= 1) {
        const nz = Math.sqrt(1 - r2);
        const l = Math.max(0, -0.45 * nx - 0.55 * ny + 0.7 * nz);
        v = 30 + 225 * Math.pow(l, 1.3);
      }
      const i = (y * 160 + x) * 4;
      d.data[i] = d.data[i + 1] = d.data[i + 2] = v;
      d.data[i + 3] = 255;
    }
  }
  g.putImageData(d, 0, 0);
  return c;
}

/** Chassi de carrinho RC: contorno e furos para cortar, gravações e uma imagem. */
export function sampleDesign(material: Material | undefined): { layers: Layer[]; image: ImageItem } {
  const red = makeLayer("Vermelho", "#ff5c5c", "cut", material);
  const blue = makeLayer("Azul", "#4da3ff", "line", material);
  red.shapes.push(makeShape(roundedRect(30, 30, 200, 120, 10), "Contorno do chassi"));
  [[42, 42], [218, 42], [42, 138], [218, 138]].forEach(([x, y], i) => red.shapes.push(makeShape(circle(x!, y!, 3, 32), `Furo ${i + 1}`)));
  red.shapes.push(makeShape(roundedRect(60, 70, 40, 20, 3), "Encaixe do servo"));
  red.shapes.push(makeShape(roundedRect(165, 62, 12, 36, 2), "Rasgo da bateria"));
  blue.shapes.push(makeShape(circle(80, 120, 14), "Roda (aro)"));
  blue.shapes.push(makeShape(circle(80, 120, 9, 40), "Roda (cubo)", false, "fill"));
  blue.shapes.push(makeShape([[112, 58], [124, 80], [116, 80], [128, 102], [110, 76], [118, 76], [106, 58], [112, 58]], "Raio", false, "detail"));
  blue.shapes.push(makeShape(roundedRect(38, 46, 62, 14, 3), "Placa do nome", false, "fill"));
  const src = sphere();
  const image: ImageItem = {
    name: "esfera (exemplo)",
    source: src,
    sourceWidth: 160,
    sourceHeight: 160,
    x: 185,
    y: 105,
    w: 38,
    h: 38,
    res: 8,
    threshold: 128,
    dither: "floyd-steinberg",
    overscan: 3,
    bidirectional: true,
    settings: presetFor(material, "raster"),
    enabled: true,
    materialId: material?.id ?? null,
    bitmap: new Uint8Array(0),
    bw: 0,
    bh: 0,
    preview: document.createElement("canvas"),
  };
  rebuildImage(image);
  return { layers: [blue, red], image };
}
