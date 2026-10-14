import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_MATERIALS, parseMaterials, type Material } from "@laserlink/shared";

export { DEFAULT_MATERIALS };

/** Biblioteca de materiais em `materials.json` na pasta de dados do agente. */
export class MaterialStore {
  readonly file: string;
  private list: Material[];

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, "materials.json");
    this.list = this.load();
  }

  get all(): Material[] {
    return structuredClone(this.list);
  }

  /** Grava (escrita atômica: arquivo temporário + renomear). */
  save(materials: Material[]): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(materials, null, 2) + "\n", "utf8");
    renameSync(tmp, this.file);
    this.list = structuredClone(materials);
  }

  private load(): Material[] {
    if (!existsSync(this.file)) return structuredClone(DEFAULT_MATERIALS);
    try {
      const parsed = parseMaterials(JSON.parse(readFileSync(this.file, "utf8")));
      if (parsed) return parsed;
      console.warn(`${this.file} tem um formato inválido. Usando os materiais de exemplo; o arquivo não foi alterado.`);
    } catch (err) {
      console.warn(`Não foi possível ler ${this.file}: ${(err as Error).message}. Usando os materiais de exemplo.`);
    }
    return structuredClone(DEFAULT_MATERIALS);
  }
}
