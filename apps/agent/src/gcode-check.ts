import type { JobBounds, JobProblem } from "@laserlink/shared";

export interface Area {
  x: number;
  y: number;
}

export interface MachineLimits {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}

export interface CheckLimits {
  /** Maior S aceito (igual ao $30 do GRBL). */
  maxSpindle: number;
  /** Área útil em mm, a partir da origem de trabalho (0,0). */
  workArea: Area;
  /** Limites em coordenadas de máquina; só usados se `workOffset` for conhecido. */
  machineLimits?: MachineLimits;
}

export interface CheckContext {
  /** Posição de trabalho atual do cabeçote (ponto de partida de movimentos relativos). */
  start?: { x: number; y: number };
  /** MPos − WPos atual. Necessário para conferir `machineLimits`. */
  workOffset?: { x: number; y: number };
}

export interface CheckResult {
  problems: JobProblem[];
  /** Retângulo percorrido pelo cabeçote, em coordenadas de trabalho (mm). */
  bounds: JobBounds | null;
}

const MAX_PROBLEMS = 20;
const EPS = 1e-3;

// G-codes aceitos sem efeito na verificação.
const G_IGNORED = new Set([4, 17, 40, 49, 54, 61, 64, 80, 94]);
const M_ALLOWED = new Set([0, 1, 2, 3, 4, 5, 7, 8, 9, 30]);
const G_REJECTED: Record<string, string> = {
  "10": "G10 muda a origem de trabalho no meio do arquivo.",
  "18": "Só o plano XY (G17) é suportado.",
  "19": "Só o plano XY (G17) é suportado.",
  "28": "G28 vai para uma posição de máquina que o agente não consegue conferir.",
  "30": "G30 vai para uma posição de máquina que o agente não consegue conferir.",
  "53": "G53 usa coordenadas de máquina; use coordenadas de trabalho.",
  "55": "Trocar o sistema de coordenadas (G55–G59) não é suportado.",
  "56": "Trocar o sistema de coordenadas (G55–G59) não é suportado.",
  "57": "Trocar o sistema de coordenadas (G55–G59) não é suportado.",
  "58": "Trocar o sistema de coordenadas (G55–G59) não é suportado.",
  "59": "Trocar o sistema de coordenadas (G55–G59) não é suportado.",
  "90.1": "Centro de arco absoluto (G90.1) não é suportado.",
  "92": "G92 muda a origem no meio do arquivo.",
  "93": "Velocidade em tempo inverso (G93) não é suportada.",
};

const WORD = /([A-Z])\s*([-+]?(?:\d+\.?\d*|\.\d+))/g;

/** Remove comentários `;` e `( )` de uma linha. */
export function stripComment(line: string): string {
  return line.replace(/;.*$/, "").replace(/\(.*?\)/g, "").trim();
}

/**
 * Confere o arquivo inteiro antes de enviar ao GRBL: potência (S) e área
 * percorrida, inclusive deslocamentos G0 e arcos G2/G3. Não corrige nada:
 * qualquer problema recusa o trabalho.
 */
export function checkGcode(gcode: string, limits: CheckLimits, ctx: CheckContext = {}): CheckResult {
  const problems: JobProblem[] = [];
  let outOfArea = 0;
  let outOfMachine = 0;
  let pos = { x: ctx.start?.x ?? 0, y: ctx.start?.y ?? 0 };
  let absolute = true;
  let mmPerUnit = 1;
  let motion: 0 | 1 | 2 | 3 | null = null;
  let bounds: JobBounds | null = null;

  const report = (line: number, text: string, message: string): void => {
    if (problems.length < MAX_PROBLEMS) problems.push({ line, text, message });
  };

  const visit = (line: number, text: string, x: number, y: number): void => {
    bounds = bounds
      ? { minX: Math.min(bounds.minX, x), maxX: Math.max(bounds.maxX, x), minY: Math.min(bounds.minY, y), maxY: Math.max(bounds.maxY, y) }
      : { minX: x, maxX: x, minY: y, maxY: y };
    const { workArea } = limits;
    if (x < -EPS || y < -EPS || x > workArea.x + EPS || y > workArea.y + EPS) {
      outOfArea += 1;
      if (outOfArea <= 3) {
        report(line, text, `Sai da área útil: vai a X${fmt(x)} Y${fmt(y)}; a área vai de X0 Y0 a X${fmt(workArea.x)} Y${fmt(workArea.y)}.`);
      }
    }
    const m = limits.machineLimits;
    const off = ctx.workOffset;
    if (m && off) {
      const mx = x + off.x;
      const my = y + off.y;
      if (mx < m.xMin - EPS || mx > m.xMax + EPS || my < m.yMin - EPS || my > m.yMax + EPS) {
        outOfMachine += 1;
        if (outOfMachine <= 3) {
          report(line, text, `Passa do curso da máquina: X${fmt(mx)} Y${fmt(my)} em coordenadas de máquina.`);
        }
      }
    }
  };

  const lines = gcode.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const raw = lines[i]!;
    const code = stripComment(raw).toUpperCase();
    if (!code || code === "%") continue;
    const text = raw.trim().slice(0, 80);
    if (code.startsWith("$")) {
      report(lineNo, text, "Comandos $ não são permitidos dentro do trabalho.");
      continue;
    }

    const words: Array<[string, number, string]> = [];
    const leftover = code.replace(WORD, (_m, letter: string, num: string) => {
      words.push([letter, Number(num), num]);
      return "";
    });
    if (leftover.trim().length > 0) {
      report(lineNo, text, "Linha não reconhecida como G-code.");
      continue;
    }

    const value = (letter: string): number | undefined => words.find(([l]) => l === letter)?.[1];
    let lineOk = true;
    let explicitMotion = false;

    for (const [letter, num, rawNum] of words) {
      if (letter === "G") {
        const key = String(Number(rawNum));
        if (key in G_REJECTED) {
          report(lineNo, text, G_REJECTED[key]!);
          lineOk = false;
        } else if (num === 0 || num === 1 || num === 2 || num === 3) {
          motion = num;
          explicitMotion = true;
        } else if (num === 20) mmPerUnit = 25.4;
        else if (num === 21) mmPerUnit = 1;
        else if (num === 90) absolute = true;
        else if (num === 91) absolute = false;
        else if (num === 91.1 || G_IGNORED.has(num)) {
          /* sem efeito na verificação */
        } else {
          report(lineNo, text, `G${rawNum} não é suportado.`);
          lineOk = false;
        }
      } else if (letter === "M") {
        if (!M_ALLOWED.has(num)) {
          report(lineNo, text, `M${rawNum} não é suportado.`);
          lineOk = false;
        }
      } else if (letter === "S") {
        if (num < 0) {
          report(lineNo, text, "Potência (S) negativa.");
          lineOk = false;
        } else if (num > limits.maxSpindle) {
          report(lineNo, text, `Potência S${rawNum} acima do máximo configurado (S${limits.maxSpindle}).`);
          lineOk = false;
        }
      } else if (letter === "F") {
        if (num <= 0) {
          report(lineNo, text, "Velocidade (F) precisa ser maior que zero.");
          lineOk = false;
        }
      } else if (!"XYZIJKRPNTL".includes(letter)) {
        report(lineNo, text, `Palavra ${letter} não é suportada.`);
        lineOk = false;
      }
    }
    if (!lineOk) continue;

    const xw = value("X");
    const yw = value("Y");
    if (xw === undefined && yw === undefined) {
      // Arco sem X/Y = círculo completo de volta ao início.
      if (!(explicitMotion && (motion === 2 || motion === 3) && (value("I") !== undefined || value("J") !== undefined))) continue;
    }
    if (motion === null) {
      report(lineNo, text, "Coordenada sem modo de movimento (G0/G1/G2/G3) definido antes.");
      continue;
    }

    const target = {
      x: xw === undefined ? pos.x : absolute ? xw * mmPerUnit : pos.x + xw * mmPerUnit,
      y: yw === undefined ? pos.y : absolute ? yw * mmPerUnit : pos.y + yw * mmPerUnit,
    };

    if (motion === 2 || motion === 3) {
      const r = value("R");
      const i = value("I");
      const j = value("J");
      let center: { x: number; y: number } | null;
      if (r !== undefined) {
        center = centerFromRadius(pos, target, r * mmPerUnit, motion === 2);
      } else if (i !== undefined || j !== undefined) {
        center = { x: pos.x + (i ?? 0) * mmPerUnit, y: pos.y + (j ?? 0) * mmPerUnit };
      } else {
        center = null;
      }
      if (!center) {
        report(lineNo, text, "Arco inválido (sem I/J/R ou raio pequeno demais para os pontos).");
        continue;
      }
      for (const p of arcExtremes(pos, target, center, motion === 2)) visit(lineNo, text, p.x, p.y);
    }
    visit(lineNo, text, target.x, target.y);
    pos = target;
  }

  if (outOfArea > 3) report(0, "", `Mais ${outOfArea - 3} pontos fora da área útil.`);
  if (outOfMachine > 3) report(0, "", `Mais ${outOfMachine - 3} pontos fora do curso da máquina.`);
  return { problems, bounds };
}

function fmt(n: number): string {
  return Number(n.toFixed(3)).toString();
}

/** Centro do arco pelo raio, com a mesma regra do GRBL (R negativo = arco maior que 180°). */
function centerFromRadius(
  a: { x: number; y: number },
  b: { x: number; y: number },
  r: number,
  clockwise: boolean,
): { x: number; y: number } | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d2 = dx * dx + dy * dy;
  if (d2 === 0) return null;
  const h2 = 4 * r * r - d2;
  if (h2 < -EPS) return null;
  let h = -Math.sqrt(Math.max(0, h2)) / Math.sqrt(d2);
  if (!clockwise) h = -h;
  if (r < 0) h = -h;
  return { x: a.x + 0.5 * (dx - dy * h), y: a.y + 0.5 * (dy + dx * h) };
}

/** Pontos de 0°, 90°, 180° e 270° que o arco cruza (onde ele atinge o extremo em X ou Y). */
function arcExtremes(
  start: { x: number; y: number },
  end: { x: number; y: number },
  c: { x: number; y: number },
  clockwise: boolean,
): Array<{ x: number; y: number }> {
  const radius = Math.hypot(start.x - c.x, start.y - c.y);
  const a0 = Math.atan2(start.y - c.y, start.x - c.x);
  const a1 = Math.atan2(end.y - c.y, end.x - c.x);
  const full = Math.abs(start.x - end.x) < EPS && Math.abs(start.y - end.y) < EPS;
  // varredura sempre positiva no sentido do movimento
  let sweep = clockwise ? a0 - a1 : a1 - a0;
  while (sweep <= 0) sweep += 2 * Math.PI;
  if (full) sweep = 2 * Math.PI;
  const out: Array<{ x: number; y: number }> = [];
  for (let k = 0; k < 4; k++) {
    const angle = (k * Math.PI) / 2;
    let delta = clockwise ? a0 - angle : angle - a0;
    while (delta < 0) delta += 2 * Math.PI;
    while (delta >= 2 * Math.PI) delta -= 2 * Math.PI;
    if (delta <= sweep + EPS) out.push({ x: c.x + radius * Math.cos(angle), y: c.y + radius * Math.sin(angle) });
  }
  return out;
}
