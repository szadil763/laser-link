import type { Bounds } from "./types.js";

function fmt(n: number): string {
  const r = Math.round(n * 1000) / 1000;
  return (Object.is(r, -0) ? 0 : r).toString();
}

export interface FrameOptions {
  /** mm/min */
  feed: number;
  /** S durante o contorno. 0 = laser desligado. */
  s: number;
}

/**
 * Percorre o retângulo do trabalho para conferir a posição na peça.
 * Com s = 0 o laser fica desligado (M5); com s > 0 usa M4 (apaga parado).
 * Termina no canto inicial, com M5.
 */
export function frameGcode(b: Bounds, o: FrameOptions): string {
  if (!(o.feed > 0)) throw new Error("A velocidade do enquadramento precisa ser maior que zero.");
  if (!(b.maxX >= b.minX && b.maxY >= b.minY)) throw new Error("Retângulo inválido para enquadrar.");
  const s = Math.max(0, Math.round(o.s));
  const corner = `X${fmt(b.minX)} Y${fmt(b.minY)}`;
  const lines = [
    "; Sapienza LaserLink: enquadrar",
    "G21 G90",
    s > 0 ? "M4 S0" : "M5",
    `G0 ${corner}`,
    `G1 X${fmt(b.maxX)} Y${fmt(b.minY)} F${fmt(o.feed)}${s > 0 ? ` S${s}` : ""}`,
    `G1 X${fmt(b.maxX)} Y${fmt(b.maxY)}`,
    `G1 X${fmt(b.minX)} Y${fmt(b.maxY)}`,
    `G1 ${corner}`,
    "M5",
  ];
  return lines.join("\n") + "\n";
}
