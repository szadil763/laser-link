import { describe, expect, it } from "vitest";
import { DEFAULT_MATRIX, dither, frameGcode, generateGcode, matrixTest, parseGcode, powerToS, textToPaths, normalizeText, textWidth, type JobDesign, type Path } from "../src/index.js";

const machine = { maxSpindle: 1000 };
const date = new Date("2026-10-14T12:00:00Z");
const rect = (x: number, y: number, w: number, h: number): Path => ({
  closed: true,
  points: [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]],
});
const codeLines = (g: string) => g.split("\n").filter((l) => l && !l.startsWith(";"));

describe("generateGcode", () => {
  const design: JobDesign = {
    name: "teste",
    rasters: [],
    vectors: [
      { name: "Contorno", mode: "cut", settings: { speed: 300, power: 85, passes: 2 }, paths: [rect(10, 10, 50, 30), rect(20, 20, 5, 5)] },
      { name: "Marca", mode: "line", settings: { speed: 1500, power: 25, passes: 1 }, paths: [{ closed: false, points: [[15, 15], [40, 15]] }] },
    ],
  };

  it("usa M4, S proporcional e termina com M5 na origem", () => {
    const r = generateGcode(design, machine, { date });
    const lines = codeLines(r.gcode);
    expect(lines[0]).toBe("G21 G90");
    expect(lines[1]).toBe("M4 S0");
    expect(r.gcode).toContain("S850");
    expect(r.gcode).toContain("S250");
    expect(lines.at(-2)).toBe("M5");
    expect(lines.at(-1)).toBe("G0 X0 Y0 S0");
    expect(r.maxS).toBe(850);
    expect(powerToS(33.3, machine)).toBe(333);
    expect(powerToS(150, machine)).toBe(1000);
  });

  it("nenhum deslocamento G0 com o laser aceso (S0 antes de andar sem queimar)", () => {
    for (const passOrder of ["pass", "piece"] as const) {
      let sNow = 0;
      let motion = "";
      for (const l of codeLines(generateGcode(design, machine, { date, passOrder }).gcode)) {
        const g = /\bG([01])\b/.exec(l);
        if (g) motion = g[1]!;
        const sw = /\bS(\d+)/.exec(l);
        if (sw) sNow = Number(sw[1]);
        if (motion === "0" && /[XY]/.test(l)) expect(sNow, `${passOrder}: ${l}`).toBe(0);
      }
    }
  });

  it("grava linhas antes de cortar e corta o furo antes do contorno", () => {
    const r = generateGcode(design, machine, { date });
    const iLine = r.gcode.indexOf("Marca:");
    const iCut = r.gcode.indexOf("Contorno:");
    expect(iLine).toBeGreaterThan(0);
    expect(iCut).toBeGreaterThan(iLine);
    const burns = parseGcode(r.gcode).segments.filter((s) => s.burn && s.s === 850);
    // primeiro trecho de corte é do furo (x entre 20 e 25)
    expect(burns[0]!.from[0]).toBeGreaterThanOrEqual(20);
    expect(burns[0]!.from[0]).toBeLessThanOrEqual(25);
  });

  it("o G-code lido de volta grava exatamente o desenho, com passes repetidos", () => {
    const r = generateGcode(design, machine, { date });
    const parsed = parseGcode(r.gcode);
    expect(parsed.burnBounds).toEqual({ minX: 10, minY: 10, maxX: 60, maxY: 40 });
    const cutLen = parsed.segments.filter((s) => s.burn && s.s === 850).reduce((a, s) => a + Math.hypot(s.to[0] - s.from[0], s.to[1] - s.from[1]), 0);
    expect(cutLen).toBeCloseTo((160 + 20) * 2, 3);
    expect(r.burnMm).toBeCloseTo((160 + 20) * 2 + 25, 3);
  });

  it("não repete palavras modais", () => {
    const r = generateGcode(design, machine, { date });
    const repeated = codeLines(r.gcode).filter((l) => /^G1 .*G1/.test(l) || /F300.*F300/.test(l));
    expect(repeated).toEqual([]);
    expect(r.gcode.split("\n").filter((l) => l.includes("F300"))).toHaveLength(1);
  });

  it("kerf desloca o corte", () => {
    const withKerf: JobDesign = { ...design, vectors: [{ ...design.vectors[0]!, settings: { speed: 300, power: 85, passes: 1, kerf: 0.2 } }] };
    const b = parseGcode(generateGcode(withKerf, machine, { date }).gcode).burnBounds!;
    expect(b.minX).toBeCloseTo(9.9);
    expect(b.maxX).toBeCloseTo(60.1);
  });

  it("preenchido e detalhado usam o intervalo e ficam antes das linhas", () => {
    const d: JobDesign = {
      name: "p",
      rasters: [],
      vectors: [
        { name: "Linha", mode: "line", settings: { speed: 1000, power: 20, passes: 1 }, paths: [{ closed: false, points: [[0, 0], [5, 0]] }] },
        { name: "Fino", mode: "detail", settings: { speed: 1000, power: 30, passes: 1, interval: 0.1 }, paths: [rect(10, 10, 2, 1)] },
        { name: "Cheio", mode: "fill", settings: { speed: 2000, power: 40, passes: 1 }, paths: [rect(20, 10, 2, 2)] },
      ],
    };
    const g = generateGcode(d, machine, { date }).gcode;
    expect(g.indexOf("Fino:")).toBeLessThan(g.indexOf("Cheio:"));
    expect(g.indexOf("Cheio:")).toBeLessThan(g.indexOf("Linha:"));
    const parsed = parseGcode(g);
    expect(parsed.segments.filter((s) => s.burn && s.s === 300)).toHaveLength(10); // 1 mm / 0,1 mm
    expect(parsed.segments.filter((s) => s.burn && s.s === 400)).toHaveLength(10); // 2 mm / 0,2 mm (padrão)
  });

  it("recusa configuração inválida", () => {
    expect(() => generateGcode({ name: "x", rasters: [], vectors: [{ name: "Ruim", mode: "line", settings: { speed: 0, power: 10, passes: 1 }, paths: [rect(0, 0, 1, 1)] }] }, machine)).toThrow(/Ruim/);
  });
});

describe("imagem", () => {
  it("limiar e Floyd-Steinberg", () => {
    expect([...dither([0, 100, 200, 255], 4, 1, "threshold", 128)]).toEqual([1, 1, 0, 0]);
    const gray = new Array(100 * 100).fill(128);
    const on = dither(gray, 100, 100, "floyd-steinberg").reduce((a, v) => a + v, 0);
    expect(on / 10000).toBeGreaterThan(0.45);
    expect(on / 10000).toBeLessThan(0.55);
  });

  it("raster nos dois sentidos com overscan e S0 nas folgas", () => {
    // 4×2 px: linha de cima liga 1..2, linha de baixo liga 0..3
    const bitmap = Uint8Array.from([0, 1, 1, 0, 1, 1, 1, 1]);
    const r = generateGcode(
      { name: "img", vectors: [], rasters: [{ name: "Foto", bitmap, width: 4, height: 2, x: 10, y: 10, widthMm: 4, heightMm: 2, overscan: 2, bidirectional: true, settings: { speed: 3000, power: 50, passes: 1 } }] },
      machine,
      { date },
    );
    const segs = parseGcode(r.gcode).segments.filter((s) => s.line > 0);
    const burns = segs.filter((s) => s.burn);
    expect(burns[0]).toMatchObject({ from: [11, 11.5], to: [13, 11.5], s: 500 }); // ida, linha de cima
    expect(burns[1]).toMatchObject({ from: [14, 10.5], to: [10, 10.5], s: 500 }); // volta, linha de baixo
    const xs = segs.flatMap((s) => [s.from[0], s.to[0]]);
    expect(Math.min(...xs.filter((x) => x > 0))).toBe(8); // 10 − overscan
    expect(Math.max(...xs)).toBe(16); // 14 + overscan
  });
});

describe("texto, matriz e enquadrar", () => {
  it("tira acentos e mede o texto", () => {
    expect(normalizeText("Ação ç")).toBe("ACAO C");
    expect(textWidth("AB", 6)).toBe(10);
    const paths = textToPaths("LT", { height: 6, x: 0, y: 0 });
    const xs = paths.flatMap((p) => p.points.map((q) => q[0]));
    expect(Math.min(...xs)).toBe(0);
    expect(Math.max(...xs)).toBe(10);
  });

  it("caractere desconhecido vira ?", () => {
    expect(textToPaths("€", { height: 6, x: 0, y: 0 })).toEqual(textToPaths("?", { height: 6, x: 0, y: 0 }));
  });

  it("matriz tem uma camada por quadrado e rótulos", () => {
    const d = matrixTest({ ...DEFAULT_MATRIX, rows: 3, cols: 4, powerFrom: 20, powerTo: 60, speedFrom: 1000, speedTo: 4000 });
    const fills = d.vectors.filter((v) => v.mode === "fill");
    expect(fills).toHaveLength(12);
    expect(new Set(fills.map((f) => f.settings.power))).toEqual(new Set([20, 40, 60]));
    expect(new Set(fills.map((f) => f.settings.speed))).toEqual(new Set([1000, 2000, 3000, 4000]));
    expect(d.vectors.at(-1)!.mode).toBe("line");
    expect(generateGcode(d, machine).gcode).toContain("M4 S0");
  });

  it("enquadrar com laser desligado não tem S", () => {
    const g = frameGcode({ minX: 10, minY: 20, maxX: 50, maxY: 40 }, { feed: 3000, s: 0 });
    expect(g).toContain("M5\nG0 X10 Y20");
    expect(g).not.toMatch(/S\d/);
    expect(parseGcode(g).bounds).toEqual({ minX: 0, minY: 0, maxX: 50, maxY: 40 });
    expect(frameGcode({ minX: 0, minY: 0, maxX: 1, maxY: 1 }, { feed: 1000, s: 10 })).toContain("S10");
  });
});

describe("parseGcode", () => {
  it("lê arcos e movimentos relativos", () => {
    const p = parseGcode("G90 G21\nM4 S500\nG0 X10 Y10\nG2 X30 Y10 I10 J0 F500\nG91\nG1 X5\n");
    expect(p.burnBounds!.maxY).toBeCloseTo(20); // topo do semicírculo
    expect(p.segments.at(-1)!.to).toEqual([35, 10]);
  });
});

describe("ordem dos passes", () => {
  // duas peças longe uma da outra, cada uma com um furo; 3 passes
  const piece = (x: number): Path[] => [rect(x, 10, 40, 40), rect(x + 15, 25, 10, 10)];
  const design: JobDesign = {
    name: "pecas",
    rasters: [],
    vectors: [
      { name: "Corte", mode: "cut", settings: { speed: 300, power: 90, passes: 3 }, paths: [...piece(10), ...piece(200)] },
      { name: "Risco", mode: "line", settings: { speed: 1500, power: 20, passes: 2 }, paths: [{ closed: false, points: [[12, 5], [48, 5]] }] },
    ],
  };
  /** Sequência de pontos queimados (G1 com S > 0), na ordem do arquivo. */
  const burns = (g: string): Array<[number, number]> => {
    const segs = parseGcode(g).segments.filter((s) => s.burn);
    return segs.map((s) => [s.to[0], s.to[1]]);
  };

  it("passe por passe continua o padrão e peça por peça gasta menos deslocamento", () => {
    const byPass = generateGcode(design, machine, { date });
    const byPiece = generateGcode(design, machine, { date, passOrder: "piece" });
    expect(generateGcode(design, machine, { date, passOrder: "pass" }).gcode).toBe(byPass.gcode);
    expect(byPiece.burnMm).toBeCloseTo(byPass.burnMm, 3);
    expect(byPiece.travelMm).toBeLessThan(byPass.travelMm);
    expect(byPiece.estimatedSeconds).toBeLessThan(byPass.estimatedSeconds);
  });

  it("peça por peça: todos os passes da primeira peça (furo antes do contorno) antes de tocar a segunda", () => {
    const pts = burns(generateGcode(design, machine, { date, passOrder: "piece" }).gcode);
    const firstFar = pts.findIndex(([x]) => x >= 200);
    expect(firstFar).toBeGreaterThan(0);
    // nada da peça da esquerda depois que a da direita começou
    expect(pts.slice(firstFar).every(([x]) => x >= 200)).toBe(true);
    // na peça da esquerda: os 3 passes do furo (x entre 25 e 35) vêm antes de qualquer ponto do contorno
    const left = pts.slice(0, firstFar).filter(([, y]) => y >= 10);
    const firstOutline = left.findIndex(([x, y]) => x === 10 || x === 50 || y === 10 || y === 50);
    const lastHole = left.map(([x, y]) => x >= 25 && x <= 35 && y >= 25 && y <= 35).lastIndexOf(true);
    expect(lastHole).toBeLessThan(firstOutline);
    // o contorno da esquerda passa 3 vezes seguidas pelo canto de partida
    const corner = left.filter(([x, y]) => (x === 10 || x === 50) && (y === 10 || y === 50)).length;
    expect(corner).toBe(12);
  });

  it("linha aberta com vários passes vai e volta, sem deslocamento vazio", () => {
    const g = generateGcode({ name: "l", rasters: [], vectors: [design.vectors[1]!] }, machine, { date, passOrder: "piece" });
    const segs = parseGcode(g.gcode).segments;
    const firstBurn = segs.findIndex((s) => s.burn);
    expect(segs.slice(firstBurn).filter((s) => !s.burn && s.to[0] !== 0)).toHaveLength(0);
  });
});
