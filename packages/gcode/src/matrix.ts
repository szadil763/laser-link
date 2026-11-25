import { textToPaths } from "./text.js";
import type { JobDesign, OpSettings, Path, VectorGroup } from "./types.js";

export interface MatrixOptions {
  /** Potência da primeira e da última linha, %. */
  powerFrom: number;
  powerTo: number;
  /** Velocidade da primeira e da última coluna, mm/min. */
  speedFrom: number;
  speedTo: number;
  rows: number;
  cols: number;
  /** Lado de cada quadrado, mm. */
  size: number;
  /** Espaço entre quadrados, mm. */
  gap: number;
  /** Intervalo da hachura dos quadrados, mm. */
  interval: number;
  /** Canto inferior esquerdo da matriz (incluindo rótulos), mm. */
  x: number;
  y: number;
  /** Rótulos gravados em linha com esta configuração. */
  label: OpSettings;
}

export const DEFAULT_MATRIX: MatrixOptions = {
  powerFrom: 10,
  powerTo: 90,
  speedFrom: 600,
  speedTo: 3000,
  rows: 5,
  cols: 5,
  size: 8,
  gap: 3,
  interval: 0.2,
  x: 10,
  y: 10,
  label: { speed: 1500, power: 20, passes: 1 },
};

function lerp(a: number, b: number, i: number, n: number): number {
  return n <= 1 ? a : a + ((b - a) * i) / (n - 1);
}

function square(x: number, y: number, s: number): Path {
  return { closed: true, points: [[x, y], [x + s, y], [x + s, y + s], [x, y + s], [x, y]] };
}

/**
 * Teste de matriz potência × velocidade: cada coluna uma velocidade, cada
 * linha uma potência (a mais forte em cima). Rótulos de potência à esquerda e
 * de velocidade embaixo, gravados em linha.
 */
export function matrixTest(o: MatrixOptions = DEFAULT_MATRIX): JobDesign {
  if (o.rows < 1 || o.cols < 1 || o.rows > 20 || o.cols > 20) throw new Error("Use de 1 a 20 linhas e colunas.");
  const labelH = Math.max(2, Math.min(4, o.size * 0.35));
  const left = o.x + labelH * 4 + 2; // espaço para "100" à esquerda
  const bottom = o.y + labelH * 2 + 3; // espaço para velocidades embaixo
  const step = o.size + o.gap;
  const vectors: VectorGroup[] = [];
  const labels: Path[] = [];
  for (let r = 0; r < o.rows; r++) {
    const power = Math.round(lerp(o.powerFrom, o.powerTo, r, o.rows));
    const y = bottom + r * step;
    labels.push(...textToPaths(String(power), { height: labelH, x: left - 2, y: y + (o.size - labelH) / 2, align: "right" }));
    for (let c = 0; c < o.cols; c++) {
      const speed = Math.round(lerp(o.speedFrom, o.speedTo, c, o.cols));
      vectors.push({
        name: `P${power}% V${speed}`,
        mode: "fill",
        settings: { speed, power, passes: 1, interval: o.interval },
        paths: [square(left + c * step, y, o.size)],
      });
    }
  }
  for (let c = 0; c < o.cols; c++) {
    const speed = Math.round(lerp(o.speedFrom, o.speedTo, c, o.cols));
    labels.push(...textToPaths(String(speed), { height: labelH * 0.8, x: left + c * step + o.size / 2, y: bottom - labelH - 2, align: "center" }));
  }
  const gridTop = bottom + o.rows * step - o.gap;
  labels.push(...textToPaths("P%", { height: labelH, x: left - 2, y: gridTop + 2, align: "right" }));
  labels.push(...textToPaths("MM/MIN", { height: labelH * 0.8, x: left + (o.cols * step - o.gap) / 2, y: o.y, align: "center" }));
  vectors.push({ name: "Rótulos", mode: "line", settings: o.label, paths: labels });
  return { name: `Teste de matriz ${o.rows}×${o.cols}`, rasters: [], vectors };
}
