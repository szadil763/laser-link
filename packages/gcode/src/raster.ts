export type DitherMethod = "threshold" | "floyd-steinberg";

/**
 * Converte tons de cinza (0 = preto, 255 = branco) em pontos a gravar (1).
 * Floyd-Steinberg espalha o erro de cada pixel para os vizinhos, imitando
 * meios-tons com pontos; limiar simplesmente corta em `threshold`.
 */
export function dither(gray: ArrayLike<number>, width: number, height: number, method: DitherMethod, threshold = 128): Uint8Array {
  if (gray.length !== width * height) throw new Error(`Imagem com ${gray.length} pixels, esperado ${width}×${height}.`);
  const out = new Uint8Array(width * height);
  if (method === "threshold") {
    for (let i = 0; i < out.length; i++) out[i] = gray[i]! < threshold ? 1 : 0;
    return out;
  }
  const lum = Float32Array.from(gray);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const old = lum[i]!;
      const isBlack = old < threshold;
      out[i] = isBlack ? 1 : 0;
      const err = old - (isBlack ? 0 : 255);
      if (x + 1 < width) lum[i + 1]! += (err * 7) / 16;
      if (y + 1 < height) {
        if (x > 0) lum[i + width - 1]! += (err * 3) / 16;
        lum[i + width]! += (err * 5) / 16;
        if (x + 1 < width) lum[i + width + 1]! += err / 16;
      }
    }
  }
  return out;
}

/** Converte RGBA (ImageData.data) em tons de cinza, com fundo branco onde é transparente. */
export function rgbaToGray(rgba: ArrayLike<number>, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height);
  for (let i = 0; i < out.length; i++) {
    const a = rgba[i * 4 + 3]! / 255;
    const l = 0.299 * rgba[i * 4]! + 0.587 * rgba[i * 4 + 1]! + 0.114 * rgba[i * 4 + 2]!;
    out[i] = Math.round(l * a + 255 * (1 - a));
  }
  return out;
}

/** Trechos contínuos a gravar numa linha da imagem: [início, fim) em pixels. */
export function runsOfRow(bitmap: Uint8Array, width: number, row: number): Array<[number, number]> {
  const runs: Array<[number, number]> = [];
  let start = -1;
  for (let x = 0; x <= width; x++) {
    const on = x < width && bitmap[row * width + x] === 1;
    if (on && start < 0) start = x;
    if (!on && start >= 0) {
      runs.push([start, x]);
      start = -1;
    }
  }
  return runs;
}
