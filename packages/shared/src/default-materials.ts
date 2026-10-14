import type { Material } from "./protocol.js";

/**
 * Exemplos para começar. Valores aproximados para laser de diodo de ~10 W:
 * ajuste com o teste de matriz na sua máquina.
 */
export const DEFAULT_MATERIALS: Material[] = [
  {
    id: "mdf-3",
    name: "MDF 3 mm",
    thickness: 3,
    notes: "Exemplo editável. Confira com o teste de matriz antes de usar.",
    presets: [
      { mode: "cut", speed: 300, power: 85, passes: 2, kerf: 0.15 },
      { mode: "line", speed: 1500, power: 25, passes: 1 },
      { mode: "fill", speed: 3000, power: 35, passes: 1, interval: 0.2 },
      { mode: "detail", speed: 1800, power: 30, passes: 1, interval: 0.08 },
      { mode: "raster", speed: 3000, power: 40, passes: 1 },
    ],
  },
  {
    id: "mdf-6",
    name: "MDF 6 mm",
    thickness: 6,
    notes: "Exemplo editável. Confira com o teste de matriz antes de usar.",
    presets: [
      { mode: "cut", speed: 180, power: 100, passes: 4, kerf: 0.2 },
      { mode: "line", speed: 1400, power: 28, passes: 1 },
      { mode: "fill", speed: 2800, power: 38, passes: 1, interval: 0.2 },
      { mode: "detail", speed: 1700, power: 32, passes: 1, interval: 0.08 },
      { mode: "raster", speed: 2800, power: 42, passes: 1 },
    ],
  },
];
