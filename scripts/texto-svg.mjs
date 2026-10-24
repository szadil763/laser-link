// Converte texto em caminhos SVG (em mm), com as mesmas fontes da interface.
// O LaserLink ignora <text>: use isto para pôr letras num SVG.
//
// Uso:
//   node scripts/texto-svg.mjs "Escola" --fonte fredoka --altura 30 [--x 10] [--y 60]
//        [--alinhar esquerda|centro|direita] [--modo cortar|linha|preenchido] [--svg]
// --altura é a altura das MAIÚSCULAS em mm. --y é a linha de base (SVG: y cresce para baixo).
// Sem --svg, imprime só o <path>; com --svg, um arquivo SVG completo do tamanho do texto.
// --fonte aceita os ids abaixo ou o caminho de um arquivo .ttf/.otf/.woff.
// Precisa de: npm ci && npm run build -w packages/gcode
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("..", import.meta.url));

export const FONT_FILES = {
  fredoka: "@fontsource/fredoka/files/fredoka-latin-700-normal.woff",
  baloo2: "@fontsource/baloo-2/files/baloo-2-latin-800-normal.woff",
  luckiest: "@fontsource/luckiest-guy/files/luckiest-guy-latin-400-normal.woff",
  chewy: "@fontsource/chewy/files/chewy-latin-400-normal.woff",
  pacifico: "@fontsource/pacifico/files/pacifico-latin-400-normal.woff",
  lobster: "@fontsource/lobster/files/lobster-latin-400-normal.woff",
  patrick: "@fontsource/patrick-hand/files/patrick-hand-latin-400-normal.woff",
  comic: "@fontsource/comic-neue/files/comic-neue-latin-700-normal.woff",
  bebas: "@fontsource/bebas-neue/files/bebas-neue-latin-400-normal.woff",
  roboto: "@fontsource/roboto/files/roboto-latin-700-normal.woff",
  stencil: "@fontsource/allerta-stencil/files/allerta-stencil-latin-400-normal.woff",
};

const MODES = {
  cortar: 'fill="none" stroke="#ff0000" stroke-width="0.2"',
  linha: 'fill="none" stroke="#0000ff" stroke-width="0.2"',
  preenchido: 'fill="#000000" stroke="none"',
};

/** Caminhos do texto, em mm, coordenadas SVG (y para baixo), com letras sobrepostas unidas. */
export async function textToSvgPath(text, { font = "fredoka", height = 20, x = 0, y = 0, align = "esquerda" } = {}) {
  const opentype = (await import("opentype.js")).default;
  const { unionPaths } = await import(pathToFileURL(`${root}packages/gcode/dist/index.js`).href);
  const file = FONT_FILES[font] ? require.resolve(FONT_FILES[font], { paths: [root] }) : font;
  if (!existsSync(file)) throw new Error(`Fonte "${font}" não encontrada. Use: ${Object.keys(FONT_FILES).join(", ")} ou o caminho de um .ttf/.otf/.woff.`);
  const buf = readFileSync(file);
  const f = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const cap = f.tables.os2?.sCapHeight > 0 ? f.tables.os2.sCapHeight : f.unitsPerEm * 0.7;
  const size = (height / cap) * f.unitsPerEm;
  const lineGap = ((f.ascender - f.descender) / cap) * height * 1.05;
  const contours = [];
  text.split("\n").forEach((line, li) => {
    const w = f.getAdvanceWidth(line, size, { kerning: true });
    const ox = align === "centro" ? x - w / 2 : align === "direita" ? x - w : x;
    const cmds = f.getPath(line, ox, y + li * lineGap, size, { kerning: true }).commands;
    let cur = [];
    let px = 0;
    let py = 0;
    const add = (nx, ny) => {
      cur.push([nx, -ny]); // y invertido só para a união (o Clipper não liga para o sentido)
      px = nx;
      py = ny;
    };
    const close = () => {
      if (cur.length >= 3) contours.push({ closed: true, points: [...cur, cur[0]] });
      cur = [];
    };
    for (const c of cmds) {
      if (c.type === "M") {
        close();
        add(c.x, c.y);
      } else if (c.type === "L") add(c.x, c.y);
      else if (c.type === "Q" || c.type === "C") {
        const n = Math.max(3, Math.min(48, Math.ceil(Math.hypot(c.x - px, c.y - py) / 0.25)));
        const [x0, y0] = [px, py];
        for (let i = 1; i <= n; i++) {
          const t = i / n;
          const u = 1 - t;
          if (c.type === "Q") add(u * u * x0 + 2 * u * t * c.x1 + t * t * c.x, u * u * y0 + 2 * u * t * c.y1 + t * t * c.y);
          else add(u ** 3 * x0 + 3 * u * u * t * c.x1 + 3 * u * t * t * c.x2 + t ** 3 * c.x, u ** 3 * y0 + 3 * u * u * t * c.y1 + 3 * u * t * t * c.y2 + t ** 3 * c.y);
        }
      } else if (c.type === "Z") close();
    }
    close();
  });
  const united = unionPaths(contours);
  const d = united
    .map((p) => `M${p.points.slice(0, -1).map(([px2, py2]) => `${+px2.toFixed(2)} ${+(-py2).toFixed(2)}`).join("L")}Z`)
    .join("");
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of united)
    for (const [px2, py2] of p.points) {
      minX = Math.min(minX, px2);
      maxX = Math.max(maxX, px2);
      minY = Math.min(minY, -py2);
      maxY = Math.max(maxY, -py2);
    }
  return { d, bounds: { minX, minY, maxX, maxY } };
}

if (process.argv[1] && process.argv[1].endsWith("texto-svg.mjs")) {
  const arg = (n, def) => {
    const i = process.argv.indexOf(n);
    return i > 0 ? process.argv[i + 1] : def;
  };
  const text = process.argv[2];
  if (!text || text.startsWith("--")) {
    console.error('Uso: node scripts/texto-svg.mjs "texto" --fonte fredoka --altura 30 [--modo cortar|linha|preenchido] [--svg]');
    process.exit(2);
  }
  const mode = MODES[arg("--modo", "preenchido")];
  if (!mode) {
    console.error("--modo precisa ser cortar, linha ou preenchido.");
    process.exit(2);
  }
  const r = await textToSvgPath(text.replace(/\\n/g, "\n"), {
    font: arg("--fonte", "fredoka"),
    height: Number(arg("--altura", "20")),
    x: Number(arg("--x", "0")),
    y: Number(arg("--y", "0")),
    align: arg("--alinhar", "esquerda"),
  });
  if (!r.d) {
    console.error("Nenhuma letra desse texto existe na fonte.");
    process.exit(1);
  }
  const path = `<path ${mode} d="${r.d}"/>`;
  if (process.argv.includes("--svg")) {
    const m = 2;
    const w = +(r.bounds.maxX - r.bounds.minX + 2 * m).toFixed(2);
    const h = +(r.bounds.maxY - r.bounds.minY + 2 * m).toFixed(2);
    console.log(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}mm" height="${h}mm" viewBox="${+(r.bounds.minX - m).toFixed(2)} ${+(r.bounds.minY - m).toFixed(2)} ${w} ${h}">\n  ${path}\n</svg>`);
  } else console.log(path);
}
