import type { ServerMessage } from "@laserlink/shared";
import { vi } from "vitest";
import type { ClientConn } from "../src/agent.js";
import type { AgentConfig } from "../src/config.js";
import { Grbl } from "../src/grbl.js";
import { FakeGrbl, type FakeGrblOptions } from "../src/sim/fake-grbl.js";

export async function openGrbl(options: FakeGrblOptions = {}): Promise<{ fake: FakeGrbl; grbl: Grbl }> {
  const fake = new FakeGrbl(options);
  const grbl = new Grbl(fake, { statusPollMs: 100 });
  await grbl.open();
  await vi.advanceTimersByTimeAsync(1); // banner do reset inicial
  return { fake, grbl };
}

export function testConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    serialPort: "sim",
    baudRate: 115200,
    wsPort: 0,
    host: "127.0.0.1",
    token: "token-de-teste-com-16+",
    maxFeed: 6000,
    reconnectGraceSec: 60,
    maxSpindle: 1000,
    workArea: { x: 400, y: 300 },
    logDir: "",
    webDir: "",
    dataDir: "",
    framePower: 10,
    frameFeed: 3000,
    ...overrides,
  };
}

export class TestClient implements ClientConn {
  readonly messages: ServerMessage[] = [];
  constructor(readonly id: string) {}
  send(msg: ServerMessage): void {
    this.messages.push(msg);
  }
  of<T extends ServerMessage["type"]>(type: T): Extract<ServerMessage, { type: T }>[] {
    return this.messages.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type);
  }
}

/** Gera um G-code com `n` linhas de comprimentos variados. */
export function sampleJob(n: number): string[] {
  const lines: string[] = ["G21", "G90", "M4 S300"];
  for (let i = 0; lines.length < n; i++) {
    lines.push(i % 3 === 0 ? `G1 X${(i % 50).toFixed(3)} Y${((i * 7) % 40).toFixed(3)} F1500` : `G1 X${i % 50} Y${i % 40}`);
  }
  return lines.slice(0, n);
}
