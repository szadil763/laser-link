import { textToPaths } from "../text.js";
import type { OpSettings } from "../types.js";
import { layoutPieces } from "./layout.js";
import { circle, plateWithTabs, rectC, roundedRectPoints, slot, type Piece } from "./shapes.js";

/**
 * Chassi de carrinho com 2 motores TT (tração traseira), roda boba na frente,
 * ESP32 DevKit e suporte de pilhas. Projeto próprio do LaserLink.
 * Medidas dos componentes variam entre fabricantes: confira com paquímetro.
 */
export interface CarOptions {
  /** Placa: comprimento (frente–trás) e largura, mm. */
  length: number;
  width: number;
  cornerRadius: number;
  thickness: number;
  motor: {
    /** Espessura do motor (distância entre as faces onde ficam os suportes), mm. */
    thickness: number;
    /** Altura do motor, mm. */
    height: number;
    /** Do fim da caixa de redução até o centro do eixo, mm. */
    axleFromEnd: number;
    /** Do eixo até o primeiro furo de fixação, mm. */
    axleToFirstHole: number;
    /** Entre os dois furos de fixação, mm. */
    holeSpacing: number;
    holeD: number;
    /** Distância do eixo dos motores até a traseira da placa, mm. */
    fromRear: number;
  };
  /** Roda boba: distância entre os dois furos e distância da frente, mm. */
  caster: { holeSpacing: number; holeD: number; fromFront: number };
  /** ESP32 DevKit (30 pinos): placa e furos de fixação, mm. */
  board: { length: number; width: number; holesX: number; holesY: number; holeD: number };
  /** Suporte de pilhas (ex.: 2× 18650), contorno gravado e rasgos para abraçadeira/velcro. */
  battery: { length: number; width: number };
  /** Texto gravado na placa (vazio = nenhum). */
  label: string;
  x: number;
  y: number;
  gap: number;
  maxRowWidth: number;
  cut: OpSettings;
  engrave: OpSettings;
}

export const DEFAULT_CAR: CarOptions = {
  length: 150,
  width: 120,
  cornerRadius: 10,
  thickness: 3,
  motor: { thickness: 18.8, height: 22.5, axleFromEnd: 11.3, axleToFirstHole: 8.5, holeSpacing: 17.5, holeD: 3.2, fromRear: 35 },
  caster: { holeSpacing: 23, holeD: 3.2, fromFront: 20 },
  board: { length: 51.5, width: 28.5, holesX: 47, holesY: 23.5, holeD: 2.8 },
  battery: { length: 77, width: 41 },
  label: "LASERLINK",
  x: 10,
  y: 10,
  gap: 5,
  maxRowWidth: 380,
  cut: { speed: 300, power: 85, passes: 2, kerf: 0.15 },
  engrave: { speed: 1500, power: 20, passes: 1 },
};

const TAB_W = 8;
const BRACKET_LEN = 45;
const MOTOR_GAP = 4; // entre a placa e o topo do motor
const MOTOR_CLEARANCE = 0.4;

/** Posições (ao longo do suporte, a partir da borda da placa) das duas abas. */
function bracketTabs(): number[] {
  return [12, BRACKET_LEN - 12];
}

export function carPieces(o: CarOptions): Piece[] {
  const t = o.thickness;
  const L = o.length;
  const W = o.width;
  const m = o.motor;
  if (W < 2 * BRACKET_LEN + 20) throw new Error(`A largura precisa de pelo menos ${2 * BRACKET_LEN + 20} mm para os dois motores.`);
  if (L < 110) throw new Error("O comprimento precisa de pelo menos 110 mm.");
  const holes = [];
  const engrave = [];
  // rasgos dos suportes dos motores: dois suportes por motor, um de cada face
  const half = m.thickness / 2 + MOTOR_CLEARANCE / 2 + t / 2;
  for (const xb of [m.fromRear - half, m.fromRear + half]) {
    for (const along of bracketTabs()) {
      holes.push(rectC(xb, along, t, TAB_W)); // motor esquerdo
      holes.push(rectC(xb, W - along, t, TAB_W)); // motor direito
    }
  }
  // passagem dos fios dos motores
  holes.push(circle(m.fromRear, W / 2 - 14, 8), circle(m.fromRear, W / 2 + 14, 8));
  // roda boba
  const cx = L - o.caster.fromFront;
  holes.push(circle(cx, W / 2 - o.caster.holeSpacing / 2, o.caster.holeD), circle(cx, W / 2 + o.caster.holeSpacing / 2, o.caster.holeD));
  // suporte de pilhas sobre os motores: contorno gravado + 4 rasgos para abraçadeira
  const bx = Math.max(m.fromRear + 5, L * 0.36);
  const bat = o.battery;
  engrave.push(rectC(bx, W / 2, bat.length, bat.width));
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      const yy = W / 2 + sy * (bat.width / 2 + 4);
      holes.push(slot(bx + sx * 20 - 6, yy, bx + sx * 20 + 6, yy, 3.5));
    }
  }
  // ESP32 na frente: furos e contorno gravado
  const ex = Math.min(L - o.caster.fromFront - 30, L * 0.7);
  const b = o.board;
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) holes.push(circle(ex + (sx * b.holesX) / 2, W / 2 + (sy * b.holesY) / 2, b.holeD));
  engrave.push(rectC(ex, W / 2, b.length, b.width));
  engrave.push(...textToPaths("ESP32", { height: 4, x: ex, y: W / 2 - 2, align: "center", tag: "esp32" }));
  if (o.label.trim()) engrave.push(...textToPaths(o.label, { height: 5, x: L / 2, y: 6, align: "center", tag: "label" }));
  const plate: Piece = { name: "Base do carrinho", outline: roundedRectPoints(0, 0, L, W, o.cornerRadius), holes, engrave, count: 1 };

  // suporte do motor: placa vertical pendurada, abas em cima
  const bh = MOTOR_GAP + m.height + 4;
  const axleY = bh - MOTOR_GAP - m.height / 2;
  const bracket: Piece = {
    name: "Suporte do motor",
    outline: plateWithTabs(BRACKET_LEN, bh, TAB_W, t, bracketTabs()),
    holes: [
      circle(m.axleFromEnd, axleY, 7.5), // eixo duplo do TT atravessa os dois suportes
      circle(m.axleFromEnd + m.axleToFirstHole, axleY, m.holeD),
      circle(m.axleFromEnd + m.axleToFirstHole + m.holeSpacing, axleY, m.holeD),
    ],
    engrave: [],
    count: 4,
  };
  if (m.axleFromEnd + m.axleToFirstHole + m.holeSpacing + m.holeD > BRACKET_LEN) {
    throw new Error("Os furos do motor passam do suporte: confira as medidas do motor.");
  }
  return [plate, bracket];
}

export function carDesign(o: CarOptions = DEFAULT_CAR): ReturnType<typeof layoutPieces> {
  return layoutPieces(`Chassi do carrinho ${o.length}×${o.width} mm`, carPieces(o), o);
}
