// Confere se um SVG vai abrir direito no LaserLink, sem precisar do navegador.
// Uso: node scripts/conferir-svg.mjs arquivo.svg [--area 400x400]
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const MM = { mm: 1, cm: 10, in: 25.4, pt: 25.4 / 72, pc: 25.4 / 6, px: 25.4 / 96, "": 25.4 / 96 };

function lengthMm(v) {
  const m = /^\s*([\d.]+)\s*(mm|cm|in|pt|pc|px)?\s*$/.exec(v ?? "");
  return m ? Number(m[1]) * MM[m[2] ?? ""] : null;
}

function isRed(c) {
  const v = c.trim().toLowerCase();
  if (v === "red" || v === "#f00" || v === "#ff0000") return true;
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/.exec(v);
  if (hex) return parseInt(hex[1], 16) >= 200 && parseInt(hex[2], 16) < 100 && parseInt(hex[3], 16) < 100;
  const rgb = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(v);
  return !!rgb && Number(rgb[1]) >= 200 && Number(rgb[2]) < 100 && Number(rgb[3]) < 100;
}

/** Devolve erros (não abre ou sai errado), avisos e o resumo de operações por cor. */
export function checkSvg(text, { area } = {}) {
  const errors = [];
  const warnings = [];
  const ops = new Map();
  const root = /<svg\b([^>]*)>/i.exec(text);
  if (!root) return { errors: ["não encontrei a tag <svg>."], warnings, ops, size: null };
  const attr = (src, name) => new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, "i").exec(src)?.[1] ?? null;
  const w = attr(root[1], "width");
  const h = attr(root[1], "height");
  const vb = attr(root[1], "viewBox");
  const wmm = lengthMm(w);
  const hmm = lengthMm(h);
  if (!w || !h) errors.push('o <svg> precisa de width e height em mm (ex.: width="200mm" height="100mm").');
  else if (!/mm$/i.test(w.trim()) || !/mm$/i.test(h.trim())) warnings.push(`width/height não estão em mm (${w} × ${h}); o tamanho pode sair diferente do esperado.`);
  if (!vb) warnings.push('sem viewBox: use viewBox="0 0 L A" com L e A iguais à largura e altura em mm, assim 1 unidade = 1 mm.');
  if (area && wmm && hmm && (wmm > area.x + 0.01 || hmm > area.y + 0.01)) {
    errors.push(`o desenho tem ${wmm.toFixed(1)} × ${hmm.toFixed(1)} mm e a mesa ${area.x} × ${area.y} mm.`);
  }
  for (const [tag, why] of [
    ["text", "<text> é ignorado: converta o texto em caminhos (scripts/texto-svg.mjs)."],
    ["image", "<image> é ignorado: imagens vão separadas (Arquivo > Importar PNG/JPG)."],
    ["use", "<use> é ignorado: repita o caminho em vez de referenciar."],
    ["foreignObject", "<foreignObject> é ignorado."],
  ]) {
    if (new RegExp(`<${tag}\\b`, "i").test(text)) errors.push(why);
  }
  let shapes = 0;
  for (const m of text.matchAll(/<(path|rect|circle|ellipse|line|polyline|polygon)\b([^>]*)>/gi)) {
    shapes++;
    const a = m[2];
    const style = attr(a, "style") ?? "";
    const fromStyle = (p) => new RegExp(`${p}\\s*:\\s*([^;]+)`, "i").exec(style)?.[1]?.trim() ?? null;
    const stroke = fromStyle("stroke") ?? attr(a, "stroke");
    const fill = fromStyle("fill") ?? attr(a, "fill");
    const hasStroke = !!stroke && stroke !== "none";
    const hasFill = fill === null ? !hasStroke : fill !== "none";
    let op;
    if (hasStroke) op = isRed(stroke) ? `Cortar (contorno ${stroke})` : `Gravar linha (contorno ${stroke})`;
    else if (hasFill) op = `Gravar preenchido (preenchimento ${fill ?? "preto"})`;
    else op = "nenhuma (sem contorno nem preenchimento: fica invisível)";
    ops.set(op, (ops.get(op) ?? 0) + 1);
  }
  if (!shapes) errors.push("nenhum caminho (path, rect, circle…) no arquivo.");
  return { errors, warnings, ops, size: wmm && hmm ? { w: wmm, h: hmm } : null, onBed: attr(root[1], "data-laserlink") === "mesa" };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file) {
    console.error("Uso: node scripts/conferir-svg.mjs arquivo.svg [--area 400x400]");
    process.exit(2);
  }
  const i = process.argv.indexOf("--area");
  const am = i > 0 ? /^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/i.exec(process.argv[i + 1] ?? "") : null;
  const r = checkSvg(readFileSync(file, "utf8"), { area: am ? { x: Number(am[1]), y: Number(am[2]) } : undefined });
  if (r.size) console.log(`Tamanho: ${r.size.w.toFixed(1)} × ${r.size.h.toFixed(1)} mm${r.onBed ? " (posições valem como na mesa)" : " (o app põe o desenho a 20 mm da origem)"}`);
  for (const [op, n] of r.ops) console.log(`  ${n} × ${op}`);
  for (const w of r.warnings) console.log(`Aviso: ${w}`);
  for (const e of r.errors) console.log(`Erro: ${e}`);
  console.log(r.errors.length ? "Não está pronto." : "Pronto para o LaserLink.");
  process.exit(r.errors.length ? 1 : 0);
}
