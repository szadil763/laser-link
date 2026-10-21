import { existsSync, readFileSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

/**
 * Serve a interface compilada (apps/web/dist). Só leitura, só GET/HEAD,
 * sem sair da pasta.
 */
export function createStaticHandler(webDir: string): (req: IncomingMessage, res: ServerResponse) => void {
  const root = resolve(webDir);
  return (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405).end();
      return;
    }
    if (!existsSync(join(root, "index.html"))) {
      res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Interface não compilada. Rode `npm run build` na pasta do Sapienza LaserLink e reinicie o agente.");
      return;
    }
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    const file = normalize(join(root, pathname === "/" ? "index.html" : pathname));
    if (file !== root && !file.startsWith(root + sep)) {
      res.writeHead(403).end();
      return;
    }
    if (!existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Não encontrado.");
      return;
    }
    res.writeHead(200, {
      "Content-Type": TYPES[extname(file)] ?? "application/octet-stream",
      "Cache-Control": file.endsWith("index.html") ? "no-cache" : "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(req.method === "HEAD" ? undefined : readFileSync(file));
  };
}
