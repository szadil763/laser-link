import type { Axis, ClientMessage } from "./protocol.js";

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isAxis(v: unknown): v is Axis {
  return v === "X" || v === "Y";
}

/**
 * Confere em tempo de execução uma mensagem recebida do cliente.
 * Devolve `null` para qualquer coisa fora do protocolo.
 */
export function parseClientMessage(value: unknown): ClientMessage | null {
  if (!isObj(value) || typeof value.type !== "string") return null;
  switch (value.type) {
    case "jog":
      if (!isAxis(value.axis) || !isFiniteNumber(value.distance) || !isFiniteNumber(value.feed)) return null;
      return { type: "jog", axis: value.axis, distance: value.distance, feed: value.feed };
    case "home":
    case "setOrigin":
    case "hold":
    case "resume":
    case "stop":
    case "unlock":
      return { type: value.type };
    case "job":
      if (typeof value.name !== "string" || typeof value.gcode !== "string") return null;
      return { type: "job", name: value.name, gcode: value.gcode };
    default:
      return null;
  }
}
