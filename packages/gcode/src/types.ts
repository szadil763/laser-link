/** Ponto em mm, coordenadas de trabalho (Y para cima, como na máquina). */
export type Point = readonly [number, number];

export interface Path {
  points: Point[];
  closed: boolean;
  /** Letras de um texto editável: todas as letras do mesmo texto têm o mesmo `id`. */
  text?: TextTag;
}

/** O que foi escrito, para a interface poder editar o texto depois. */
export interface TextTag {
  id: string;
  value: string;
  /** Altura das maiúsculas, mm. */
  height: number;
  align: "left" | "center" | "right";
}

/**
 * - `cut`: corta (atravessa o material).
 * - `line`: grava só o contorno.
 * - `fill`: grava preenchido (hachura).
 * - `detail`: preenchimento fino (hachura com intervalo pequeno).
 */
export type VectorMode = "cut" | "line" | "fill" | "detail";

export interface OpSettings {
  /** mm/min */
  speed: number;
  /** 0–100 % de maxSpindle */
  power: number;
  passes: number;
  /** Largura do corte em mm (só `cut`). O caminho é deslocado kerf/2 para fora das peças e para dentro dos furos. */
  kerf?: number;
  /** Distância entre linhas da hachura em mm (`fill` e `detail`). */
  interval?: number;
}

/** Caminhos de uma camada que recebem a mesma operação. */
export interface VectorGroup {
  name: string;
  mode: VectorMode;
  settings: OpSettings;
  paths: Path[];
}

/** Imagem já convertida em pontos (1 = gravar). Linha 0 é a de cima. */
export interface RasterGroup {
  name: string;
  bitmap: Uint8Array;
  width: number;
  height: number;
  /** Canto inferior esquerdo da imagem, mm. */
  x: number;
  y: number;
  /** Tamanho da imagem na peça, mm. */
  widthMm: number;
  heightMm: number;
  settings: OpSettings;
  /** Folga em mm antes e depois de cada linha para o cabeçote acelerar com o laser apagado. */
  overscan: number;
  bidirectional: boolean;
}

export interface MachineProfile {
  /** Valor de S que corresponde a 100 % (igual ao $30 do GRBL). */
  maxSpindle: number;
}

export interface JobDesign {
  name: string;
  rasters: RasterGroup[];
  vectors: VectorGroup[];
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}
