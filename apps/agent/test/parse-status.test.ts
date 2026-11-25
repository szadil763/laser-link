import { describe, expect, it } from "vitest";
import { parseStatus } from "../src/grbl.js";

describe("parseStatus", () => {
  it("lê estado, posição de máquina, velocidade e potência", () => {
    expect(parseStatus("<Idle|MPos:10.000,-2.500,0.000|FS:1200,300>")).toEqual({
      state: "Idle",
      mpos: { x: 10, y: -2.5, z: 0 },
      feed: 1200,
      spindle: 300,
    });
  });

  it("aceita subestado (Hold:0) e campos extras", () => {
    const s = parseStatus("<Hold:0|MPos:1.000,2.000,3.000|Bf:15,128|FS:0,0|Ov:100,100,100>");
    expect(s?.state).toBe("Hold");
    expect(s?.mpos).toEqual({ x: 1, y: 2, z: 3 });
  });

  it("devolve Unknown para estado desconhecido", () => {
    expect(parseStatus("<Weird|MPos:0,0,0|FS:0,0>")?.state).toBe("Unknown");
  });

  it("recusa linhas que não são relatório de status", () => {
    expect(parseStatus("ok")).toBeNull();
    expect(parseStatus("<Idle")).toBeNull();
    expect(parseStatus("")).toBeNull();
  });
});
