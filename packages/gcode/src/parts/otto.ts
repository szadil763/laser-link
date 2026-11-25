import { boxPanels, DEFAULT_BOX } from "../box.js";
import type { OpSettings, Path } from "../types.js";
import { layoutPieces } from "./layout.js";
import { circle, plateWithTabs, rect, rectC, roundedRectPoints, servoCutout, SG90, type Piece, type ServoSize } from "./shapes.js";

/**
 * Robô bípede tipo Otto, todo em MDF: projeto próprio do LaserLink (não usa os
 * arquivos do Otto DIY). Corpo em caixa com encaixes, sensor ultrassônico
 * HC-SR04 na frente e 4 servos SG90: 2 nos quadris (eixo vertical) e 2 nos
 * tornozelos (eixo frente–trás). Versão 1: faça uma montagem de teste.
 */
export interface OttoOptions {
  thickness: number;
  /** Corpo (cabeça), medidas externas, mm. */
  body: { width: number; depth: number; height: number; finger: number };
  servo: ServoSize;
  /** HC-SR04: diâmetro dos furos e distância entre os centros, mm. */
  sensor: { holeD: number; spacing: number };
  /** Distância de cada servo do quadril até o centro do corpo, mm. */
  hipOffset: number;
  legHeight: number;
  foot: { width: number; length: number };
  x: number;
  y: number;
  gap: number;
  maxRowWidth: number;
  cut: OpSettings;
  engrave: OpSettings;
}

export const DEFAULT_OTTO: OttoOptions = {
  thickness: 3,
  body: { width: 64, depth: 56, height: 52, finger: 9 },
  servo: SG90,
  sensor: { holeD: 16.5, spacing: 26 },
  hipOffset: 15,
  legHeight: 36,
  foot: { width: 34, length: 56 },
  x: 10,
  y: 10,
  gap: 5,
  maxRowWidth: 380,
  cut: { speed: 300, power: 85, passes: 2, kerf: 0.15 },
  engrave: { speed: 1500, power: 20, passes: 1 },
};

const TAB_W = 8;
const LEG_W = 30; // largura da perna (esquerda–direita)
const LEG_D = 28; // profundidade da perna (frente–trás)
const SG90_SHAFT_FROM_END = 5.9;
const INSET = 2; // recuo das placas da perna em relação à borda da tampa da perna

export function ottoPieces(o: OttoOptions): Piece[] {
  const t = o.thickness;
  const s = o.servo;
  const pieces: Piece[] = [];

  // ---- corpo: caixa com encaixes + furos ----
  const panels = boxPanels({ ...DEFAULT_BOX, width: o.body.width, depth: o.body.depth, height: o.body.height, measure: "outside", thickness: t, finger: o.body.finger, lid: true, labels: false });
  const X = o.body.width;
  const Y = o.body.depth;
  const Z = o.body.height;
  const minHalf = s.width / 2 + s.clearance + t + 2;
  if (o.hipOffset < minHalf || X / 2 - o.hipOffset < (s.width / 2 + s.clearance + t + 1)) {
    throw new Error("Os servos do quadril não cabem na base com esse afastamento: ajuste a largura do corpo ou o afastamento.");
  }
  if (o.sensor.spacing + o.sensor.holeD > X - 4 * t) throw new Error("O sensor ultrassônico não cabe na frente: aumente a largura do corpo.");
  const extra: Record<string, Path[]> = {
    Frente: [circle(X / 2 - o.sensor.spacing / 2, Z * 0.58, o.sensor.holeD), circle(X / 2 + o.sensor.spacing / 2, Z * 0.58, o.sensor.holeD)],
    Base: [...servoCutout(X / 2 - o.hipOffset, Y / 2, s, false), ...servoCutout(X / 2 + o.hipOffset, Y / 2, s, false)],
    // passagem do cabo USB / chave liga-desliga
    Trás: [rectC(X / 2, t + 9, 14, 9)],
  };
  for (const p of panels) {
    pieces.push({ name: `Corpo: ${p.name.toLowerCase()}`, outline: p.outline, holes: extra[p.name] ?? [], engrave: [], count: 1 });
  }

  // ---- perna (2 de cada): tampa horizontal + placas da frente e de trás ----
  const tabsX = [8, LEG_W - 8];
  const plateY = [INSET + t / 2, LEG_D - INSET - t / 2];
  pieces.push({
    name: "Perna: topo (chifre do servo do quadril)",
    outline: rect(0, 0, LEG_W, LEG_D).points,
    holes: [
      ...plateY.flatMap((py) => tabsX.map((tx) => rectC(tx, py, TAB_W, t))),
      circle(LEG_W / 2, LEG_D / 2, 2.5), // parafuso central do chifre
      circle(LEG_W / 2 + 8, LEG_D / 2, 1.6), // parafusos do braço do chifre
      circle(LEG_W / 2 + 12, LEG_D / 2, 1.6),
    ],
    engrave: [],
    count: 2,
  });
  const H = o.legHeight;
  // eixo do tornozelo perto da base da perna, mas com ≥ 2,5 mm de MDF abaixo do furo da orelha
  const servoCy = Math.max(4 + s.length / 2 + s.clearance, s.earHoles / 2 + s.earHoleD / 2 + 2.5);
  if (servoCy + s.earHoles / 2 + s.earHoleD > H) throw new Error("A perna está baixa demais para o servo do tornozelo: aumente a altura da perna.");
  pieces.push({
    name: "Perna: frente (servo do tornozelo)",
    outline: plateWithTabs(LEG_W, H, TAB_W, t, tabsX),
    holes: servoCutout(LEG_W / 2, servoCy, s, false),
    engrave: [],
    count: 2,
  });
  pieces.push({
    name: "Perna: trás",
    outline: plateWithTabs(LEG_W, H, TAB_W, t, tabsX),
    holes: [rectC(LEG_W / 2, H - 8, 10, 6)], // passagem dos fios
    engrave: [],
    count: 2,
  });

  // ---- pé (2 de cada): sola + suporte vertical que prende no chifre do tornozelo ----
  const fw = o.foot.width;
  const fl = o.foot.length;
  const bracketW = LEG_W;
  const footTabs = [fw / 2 - bracketW / 2 + 8, fw / 2 + bracketW / 2 - 8];
  const bracketY = fl / 2 + LEG_D / 2 + 3; // na frente da perna, com folga para o chifre
  pieces.push({
    name: "Pé: sola",
    outline: roundedRectPoints(0, 0, fw, fl, 6),
    holes: footTabs.map((tx) => rectC(tx, bracketY, TAB_W, t)),
    engrave: [],
    count: 2,
  });
  // eixo do SG90 fica a ~5,9 mm da ponta do corpo; a perna fica 3 mm acima da sola
  const shaftAboveLegBottom = servoCy - s.length / 2 + SG90_SHAFT_FROM_END;
  const hornY = 3 + shaftAboveLegBottom;
  pieces.push({
    name: "Pé: suporte do tornozelo",
    outline: plateWithTabs(bracketW, Math.ceil(hornY + 12 + 4), TAB_W, t, [], [8, bracketW - 8]),
    holes: [circle(bracketW / 2, hornY, 2.5), circle(bracketW / 2, hornY + 8, 1.6), circle(bracketW / 2, hornY + 12, 1.6)],
    engrave: [],
    count: 2,
  });
  return pieces;
}

export function ottoDesign(o: OttoOptions = DEFAULT_OTTO): ReturnType<typeof layoutPieces> {
  return layoutPieces(`Robô bípede (tipo Otto) ${o.body.width}×${o.body.depth}×${o.body.height} mm`, ottoPieces(o), o);
}
