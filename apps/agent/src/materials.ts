import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_MATERIALS, parseMaterials, type Material } from "@laserlink/shared";

export { DEFAULT_MATERIALS };

/**
 * Biblioteca de materiais em `materials.json` na pasta de dados do agente.
 *
 * Materiais de exemplo novos (de uma atualização) entram sozinhos numa biblioteca já salva,
 * no fim da lista. `materiais-padrao.json` guarda quais exemplos já foram oferecidos:
 * assim um exemplo que a pessoa apagou não volta, e os que ela editou ficam como estão.
 */
export class MaterialStore {
  readonly file: string;
  private readonly offeredFile: string;
  private list: Material[];

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, "materials.json");
    this.offeredFile = join(dir, "materiais-padrao.json");
    this.list = this.load();
  }

  get all(): Material[] {
    return structuredClone(this.list);
  }

  /** Grava (escrita atômica: arquivo temporário + renomear). */
  save(materials: Material[]): void {
    this.writeJson(this.file, materials);
    // quem salvou já viu todos os exemplos atuais
    this.writeJson(this.offeredFile, DEFAULT_MATERIALS.map((m) => m.id));
    this.list = structuredClone(materials);
  }

  private writeJson(file: string, data: unknown): void {
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
    renameSync(tmp, file);
  }

  /** Exemplos já oferecidos. Sem o arquivo (biblioteca salva antes desta versão): só os dois MDF originais. */
  private offered(): Set<string> {
    try {
      const v: unknown = JSON.parse(readFileSync(this.offeredFile, "utf8"));
      if (Array.isArray(v) && v.every((x) => typeof x === "string")) return new Set(v as string[]);
    } catch {
      /* sem arquivo ou inválido */
    }
    return new Set(["mdf-3", "mdf-6"]);
  }

  private load(): Material[] {
    if (!existsSync(this.file)) return structuredClone(DEFAULT_MATERIALS);
    let saved: Material[] | null = null;
    try {
      saved = parseMaterials(JSON.parse(readFileSync(this.file, "utf8")));
      if (!saved) console.warn(`${this.file} tem um formato inválido. Usando os materiais de exemplo; o arquivo não foi alterado.`);
    } catch (err) {
      console.warn(`Não foi possível ler ${this.file}: ${(err as Error).message}. Usando os materiais de exemplo.`);
    }
    if (!saved) return structuredClone(DEFAULT_MATERIALS);
    const offered = this.offered();
    const have = new Set(saved.map((m) => m.id));
    const fresh = DEFAULT_MATERIALS.filter((m) => !offered.has(m.id) && !have.has(m.id));
    if (!fresh.length) return saved;
    const merged = [...saved, ...structuredClone(fresh)].slice(0, 200);
    try {
      this.save(merged);
      console.log(`Materiais novos adicionados à biblioteca: ${fresh.map((m) => m.name).join(", ")}.`);
    } catch (err) {
      console.warn(`Não foi possível gravar os materiais novos: ${(err as Error).message}.`);
    }
    return merged;
  }
}
