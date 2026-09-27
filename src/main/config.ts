import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/** Minimal .env loader (avoids a dependency for a handful of keys). */
function loadDotenv(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf-8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

// Dev fallback: read a local .env next to the project. In packaged builds the
// keys below are inlined at build time by electron-vite `define`, so this file
// isn't needed at runtime.
const fileEnv = loadDotenv(join(__dirname, "../../.env"));

// These static `process.env.*` references are replaced at build time by the
// bundler's define config (see electron.vite.config.ts).
const BUILD_API_KEY = process.env.LASTFM_API_KEY || "";
const BUILD_API_SECRET = process.env.LASTFM_API_SECRET || "";

export const config = {
  lastfmApiKey: BUILD_API_KEY || fileEnv.LASTFM_API_KEY || "",
  lastfmApiSecret: BUILD_API_SECRET || fileEnv.LASTFM_API_SECRET || "",
  pythonPath:
    process.env.CINNAMON_PYTHON ||
    fileEnv.CINNAMON_PYTHON ||
    "python", // dev only; packaged builds run the bundled helper exe
};
