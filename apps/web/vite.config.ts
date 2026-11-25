import { execFileSync } from "node:child_process";
import { defineConfig } from "vite";

/** Versão mostrada na barra de status: commit e data do git (ou "dev" sem git). */
function appVersion(): string {
  try {
    return execFileSync("git", ["-c", "safe.directory=*", "log", "-1", "--format=%h · %cd", "--date=format:%d/%m %H:%M"], { encoding: "utf8" }).trim();
  } catch {
    return "dev";
  }
}

export default defineConfig({
  server: { host: true, port: 5173 },
  define: { __APP_VERSION__: JSON.stringify(appVersion()) },
});
