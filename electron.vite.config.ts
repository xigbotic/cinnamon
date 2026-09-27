import { resolve } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

// Read .env at build time so the Last.fm keys can be inlined into the main
// bundle (packaged apps have no .env at runtime).
function readEnv(): Record<string, string> {
  const path = resolve(__dirname, ".env");
  const out: Record<string, string> = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf-8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i > 0) out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}
const env = readEnv();

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    define: {
      "process.env.LASTFM_API_KEY": JSON.stringify(env.LASTFM_API_KEY || ""),
      "process.env.LASTFM_API_SECRET": JSON.stringify(env.LASTFM_API_SECRET || ""),
    },
    build: {
      lib: { entry: resolve(__dirname, "src/main/index.ts") },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      lib: { entry: resolve(__dirname, "src/preload/index.ts") },
    },
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/renderer/index.html"),
          mini: resolve(__dirname, "src/renderer/mini.html"),
          lyrics: resolve(__dirname, "src/renderer/lyrics.html"),
        },
      },
    },
  },
});
