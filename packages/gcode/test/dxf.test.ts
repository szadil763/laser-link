import { describe, expect, it } from "vitest";
import { boundsOf, boxDesign, carDesign, DEFAULT_BOX, DEFAULT_CAR, designToDxf, parseDxf, type JobDesign } from "../src/index.js";

/** Monta um DXF mínimo a partir de pares código/valor. */
const dxf = (header: string[], entities: string[], blocks: string[] = []): string =>
  [
    "0", "SECTION", "2", "HEADER", ...header, "0", "ENDSEC",
    ...(blocks.length ? ["0", "SECTION", "2", "BLOCKS", ...blocks, "0", "ENDSEC"] : []),
    "0", "SECTION", "2", "ENTITIES", ...entities, "0", "ENDSEC", "0", "EOF",
  ].join("\n");

const near = (a: number, b: number, tol = 0.02): void => expect(Math.abs(a - b)).toBeLessThan(tol);

describe("parseDxf", () => {
  it("lê linha, círculo e arco em mm", () => {
    const r = parseDxf(
      dxf(["9", "$INSUNITS", "70", "4"], [
        "0", "LINE", "8", "CORTE", "62", "1", "10", "0", "20", "0", "11", "50", "21", "0",
        "0", "CIRCLE", "8", "CORTE", "10", "100", "20", "100", "40", "10",
        "0", "ARC", "8", "GRAVAR", "10", "0", "20", "0", "40", "20", "50", "0", "51", "90",
      ]),
    );
    expect(r.layers.map((l) => l.name)).toEqual(["CORTE", "GRAVAR"]);
    const [line, circle] = r.layers[0]!.paths;
    expect(line!.points).toEqual([[0, 0], [50, 0]]);
    expect(circle!.closed).toBe(true);
    const cb = boundsOf(circle!.points)!;
    near(cb.minX, 90); near(cb.maxX, 110); near(cb.minY, 90); near(cb.maxY, 110);
    const arc = r.layers[1]!.paths[0]!;
    near(arc.points[0]![0], 20); near(arc.points[0]![1], 0);
    near(arc.points.at(-1)![0], 0); near(arc.points.at(-1)![1], 20);
  });

  it("converte polegadas pelo $INSUNITS", () => {
    const r = parseDxf(dxf(["9", "$INSUNITS", "70", "1"], ["0", "LINE", "8", "0", "10", "0", "20", "0", "11", "2", "21", "0"]));
    expect(r.unitToMm).toBe(25.4);
    expect(r.layers[0]!.paths[0]!.points[1]).toEqual([50.8, 0]);
  });

  it("LWPOLYLINE fechada com bulge vira meio círculo", () => {
    // quadrado 0..20 com o lado de cima trocado por um arco (bulge 1 = 180°)
    const r = parseDxf(
      dxf([], [
        "0", "LWPOLYLINE", "8", "0", "90", "4", "70", "1",
        "10", "0", "20", "0", "10", "20", "20", "0", "10", "20", "20", "20", "42", "1", "10", "0", "20", "20",
      ]),
    );
    const p = r.layers[0]!.paths[0]!;
    expect(p.closed).toBe(true);
    const b = boundsOf(p.points)!;
    // arco de (20,20) a (0,20) anti-horário, centro (10,20), raio 10: sobe até y = 30
    near(b.maxY, 30, 0.05);
    near(b.minX, 0); near(b.maxX, 20);
  });

  it("POLYLINE antigo com VERTEX/SEQEND", () => {
    const r = parseDxf(
      dxf([], [
        "0", "POLYLINE", "8", "P", "66", "1", "70", "1",
        "0", "VERTEX", "8", "P", "10", "0", "20", "0",
        "0", "VERTEX", "8", "P", "10", "10", "20", "0",
        "0", "VERTEX", "8", "P", "10", "10", "20", "10",
        "0", "SEQEND",
      ]),
    );
    expect(r.layers[0]!.paths[0]!.points).toEqual([[0, 0], [10, 0], [10, 10], [0, 0]]);
  });

  it("INSERT aplica escala, giro e posição do bloco", () => {
    const r = parseDxf(
      dxf(
        [],
        ["0", "INSERT", "8", "PECAS", "2", "QUAD", "10", "100", "20", "50", "41", "2", "42", "2", "50", "90"],
        ["0", "BLOCK", "2", "QUAD", "10", "0", "20", "0", "0", "LINE", "8", "0", "10", "0", "20", "0", "11", "10", "21", "0", "0", "ENDBLK"],
      ),
    );
    const l = r.layers[0]!;
    expect(l.name).toBe("PECAS"); // camada 0 do bloco herda a do INSERT
    const [a, b] = l.paths[0]!.points;
    near(a![0], 100); near(a![1], 50);
    near(b![0], 100); near(b![1], 70); // (10,0) × 2, girado 90°
  });

  it("SPLINE passa pelas pontas (nós clamped) e elipse fecha", () => {
    const r = parseDxf(
      dxf([], [
        "0", "SPLINE", "8", "S", "70", "8", "71", "3", "72", "8", "73", "4",
        "40", "0", "40", "0", "40", "0", "40", "0", "40", "1", "40", "1", "40", "1", "40", "1",
        "10", "0", "20", "0", "10", "10", "20", "20", "10", "20", "20", "20", "10", "30", "20", "0",
        "0", "ELLIPSE", "8", "S", "10", "0", "20", "0", "11", "20", "21", "0", "40", "0.5", "41", "0", "42", "6.283185307",
      ]),
    );
    const [spline, ellipse] = r.layers[0]!.paths;
    expect(spline!.points[0]).toEqual([0, 0]);
    near(spline!.points.at(-1)![0], 30); near(spline!.points.at(-1)![1], 0);
    expect(ellipse!.closed).toBe(true);
    const eb = boundsOf(ellipse!.points)!;
    near(eb.maxX, 20); near(eb.maxY, 10, 0.05);
  });

  it("ignora texto e conta o que pulou", () => {
    const r = parseDxf(dxf([], ["0", "TEXT", "8", "0", "1", "OI", "0", "LINE", "8", "0", "10", "0", "20", "0", "11", "1", "21", "1"]));
    expect(r.skipped.TEXT).toBe(1);
  });

  it("recusa arquivo sem desenho", () => {
    expect(() => parseDxf(dxf([], []))).toThrow(/Não achei/);
  });
});

describe("designToDxf", () => {
  it("ida e volta: o DXF exportado volta com as mesmas medidas e camadas por operação", () => {
    const design: JobDesign = boxDesign({ ...DEFAULT_BOX, labels: true });
    const back = parseDxf(designToDxf(design));
    expect(back.layers.map((l) => l.name)).toEqual(["CORTAR", "GRAVAR_LINHA"]);
    expect(back.layers[0]!.color).toBe(1);
    const orig = boundsOf(design.vectors[0]!.paths.flatMap((p) => p.points))!;
    const got = boundsOf(back.layers[0]!.paths.flatMap((p) => p.points))!;
    near(got.minX, orig.minX, 0.001); near(got.maxX, orig.maxX, 0.001); near(got.maxY, orig.maxY, 0.001);
    expect(back.layers[0]!.paths.length).toBe(design.vectors[0]!.paths.length);
    expect(back.layers[0]!.paths.every((p) => p.closed)).toBe(true);
  });
});

describe("textos editáveis", () => {
  it("nomes da caixa e textos do carrinho vêm marcados com o que está escrito", () => {
    const box = boxDesign({ ...DEFAULT_BOX, labels: true });
    const labels = box.vectors.find((v) => v.mode === "line")!.paths;
    const values = new Set(labels.map((p) => p.text?.value));
    expect(values.has("Frente")).toBe(true);
    expect(labels.every((p) => p.text && p.text.height > 0)).toBe(true);
    const car = carDesign(DEFAULT_CAR);
    const tags = new Set(car.vectors.find((v) => v.mode === "line")!.paths.filter((p) => p.text).map((p) => `${p.text!.id}=${p.text!.value}`));
    expect([...tags].sort()).toEqual(["0:esp32=ESP32", "0:label=LASERLINK"]);
  });
});
