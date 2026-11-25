import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { JobOutcome } from "@laserlink/shared";

export type JobLogRecord =
  | { event: "start"; id: string; name: string; at: string; lines: number }
  | {
      event: "end";
      id: string;
      name: string;
      startedAt: string;
      at: string;
      outcome: JobOutcome;
      reason: string;
      sent: number;
      total: number;
    }
  | { event: "rejected"; name: string; at: string; problems: number; first: string };

export interface UnfinishedJob {
  id: string;
  name: string;
  startedAt: string;
  lines: number;
}

/**
 * Log de trabalhos em JSON Lines (um registro por linha), em `logs/jobs.jsonl`.
 * Escrita síncrona: se o PC desligar no meio do trabalho, o início já está no disco.
 */
export class JobLog {
  readonly file: string;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, "jobs.jsonl");
  }

  write(record: JobLogRecord): void {
    try {
      appendFileSync(this.file, JSON.stringify(record) + "\n", "utf8");
    } catch (err) {
      console.error(`Não foi possível gravar o log de trabalhos em ${this.file}:`, (err as Error).message);
    }
  }

  /** Lê todos os registros válidos (linhas corrompidas são ignoradas). */
  read(): JobLogRecord[] {
    if (!existsSync(this.file)) return [];
    const out: JobLogRecord[] = [];
    for (const line of readFileSync(this.file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as JobLogRecord);
      } catch {
        /* linha incompleta (queda de energia no meio da escrita) */
      }
    }
    return out;
  }

  /** Trabalhos que começaram e nunca terminaram (o agente caiu ou o PC desligou), do mais antigo ao mais novo. */
  findUnfinished(): UnfinishedJob[] {
    const open = new Map<string, UnfinishedJob>();
    for (const r of this.read()) {
      if (r.event === "start") open.set(r.id, { id: r.id, name: r.name, startedAt: r.at, lines: r.lines });
      else if (r.event === "end") open.delete(r.id);
    }
    return [...open.values()];
  }
}
