export type Axis = "X" | "Y";

export type ClientMessage =
  | { type: "jog"; axis: Axis; distance: number; feed: number }
  | { type: "home" }
  | { type: "setOrigin" }
  | { type: "hold" }
  | { type: "resume" }
  | { type: "stop" }
  | { type: "unlock" }
  | { type: "job"; name: string; gcode: string };

export interface Position {
  x: number;
  y: number;
  z: number;
}

export type MachineState =
  | "Idle"
  | "Run"
  | "Hold"
  | "Jog"
  | "Alarm"
  | "Door"
  | "Check"
  | "Home"
  | "Sleep"
  | "Unknown";

export type ServerMessage =
  | { type: "hello"; version: string; port: string; connected: boolean }
  | { type: "status"; state: MachineState; mpos: Position; feed: number; spindle: number }
  | { type: "log"; level: "info" | "warn" | "error"; text: string }
  | { type: "progress"; sent: number; total: number; running: boolean }
  | { type: "error"; message: string };

export const PROTOCOL_VERSION = "0.1.0";
