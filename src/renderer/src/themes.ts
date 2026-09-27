// Theme system: each theme is a set of CSS-variable overrides applied to :root.
// This is the payoff of owning the UI: swap the whole look instantly.

import type { CustomTheme, ThemeColors } from "../../../shared/types";

export interface Theme {
  id: string;
  name: string;
  vars: Record<string, string>;
}

export const THEMES: Theme[] = [
  {
    id: "dynamic",
    name: "Dynamic",
    // Accent is derived live from the album artwork; base palette stays dark.
    vars: {
      "--bg": "#050505",
      "--card": "#0d0d0f",
      "--border": "#1c1c22",
      "--text": "#ffffff",
      "--text-dim": "#a6a6b0",
      "--text-faint": "#5a5a66",
      "--accent": "#e0592f",
      "--accent-soft": "#f0916f",
      "--on-accent": "#ffffff",
      "--playing": "#00ff7f",
    },
  },
  {
    id: "cinnamon",
    name: "Cinnamon",
    vars: {
      "--bg": "#0a0706",
      "--card": "#161010",
      "--border": "#241a19",
      "--text": "#fdf6f4",
      "--text-dim": "#a08a86",
      "--text-faint": "#5c4a47",
      "--accent": "#e0592f",
      "--accent-soft": "#f0916f",
      "--on-accent": "#ffffff",
      "--playing": "#00ff7f",
    },
  },
  {
    id: "noir",
    name: "Noir",
    vars: {
      "--bg": "#000000",
      "--card": "#0e0e0e",
      "--border": "#1c1c1c",
      "--text": "#ffffff",
      "--text-dim": "#9a9a9a",
      "--text-faint": "#565656",
      "--accent": "#ffffff",
      "--accent-soft": "#cccccc",
      "--on-accent": "#000000",
      "--playing": "#ffffff",
    },
  },
  {
    id: "ocean",
    name: "Ocean",
    vars: {
      "--bg": "#060a12",
      "--card": "#0d1420",
      "--border": "#182233",
      "--text": "#eaf2ff",
      "--text-dim": "#8ba3c4",
      "--text-faint": "#47597a",
      "--accent": "#3d9bff",
      "--accent-soft": "#7dbcff",
      "--on-accent": "#ffffff",
      "--playing": "#4dffd0",
    },
  },
  {
    id: "matcha",
    name: "Matcha",
    vars: {
      "--bg": "#080b07",
      "--card": "#111710",
      "--border": "#1e281c",
      "--text": "#f2f7ee",
      "--text-dim": "#93a688",
      "--text-faint": "#4e5c47",
      "--accent": "#7cc356",
      "--accent-soft": "#a6dd8a",
      "--on-accent": "#0b1408",
      "--playing": "#c8ff7c",
    },
  },
];

// ---- custom themes (theme editor) ----

let custom: Theme[] = [];

/** Built-in themes followed by the user's own. */
export function allThemes(): Theme[] {
  return [...THEMES, ...custom];
}

export function setCustomThemes(list: CustomTheme[]) {
  custom = list.map((t) => ({ id: t.id, name: t.name, vars: varsFromColors(t.colors) }));
}

export function isCustom(id: string): boolean {
  return id.startsWith("custom-");
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const toHex = (r: number, g: number, b: number) =>
  "#" + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");

/** "#rrggbb" for any CSS colour the browser can compute (rgb(), named, hex). */
export function cssToHex(color: string): string {
  const m = color.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/);
  if (m) return toHex(+m[1], +m[2], +m[3]);
  if (/^#[0-9a-f]{6}$/i.test(color.trim())) return color.trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(color.trim())) {
    const [r, g, b] = color.trim().slice(1).split("").map((c) => parseInt(c + c, 16));
    return toHex(r, g, b);
  }
  return "#000000";
}

/**
 * The seven colours a user picks become the full token set: the soft accent,
 * the readable foreground on the accent, and the "playing" colour are derived,
 * so a handful of choices can't produce a half-broken theme.
 */
export function varsFromColors(c: ThemeColors): Record<string, string> {
  const [r, g, b] = hexToRgb(c.accent);
  return {
    "--bg": c.bg,
    "--card": c.card,
    "--border": c.border,
    "--text": c.text,
    "--text-dim": c.textDim,
    "--text-faint": c.textFaint,
    "--accent": c.accent,
    "--accent-soft": toHex(r + (255 - r) * 0.35, g + (255 - g) * 0.35, b + (255 - b) * 0.35),
    "--on-accent": contrastOn(r, g, b),
    "--playing": c.accent,
  };
}

/** WCAG contrast ratio between two hex colours (1..21). */
export function contrastRatio(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = hexToRgb(hex).map((v) => {
      const x = v / 255;
      return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

export function applyVars(vars: Record<string, string>) {
  const root = document.documentElement;
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
}

export function applyTheme(id: string) {
  const theme = allThemes().find((t) => t.id === id) ?? THEMES[0];
  applyVars(theme.vars);
}

export function isDynamic(id: string): boolean {
  return id === "dynamic";
}

export interface Accent {
  accent: string;
  /** Readable foreground for content sitting *on* the accent color. */
  onAccent: string;
}

/** Pick black or white text depending on how light the background is. */
export function contrastOn(r: number, g: number, b: number): string {
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.6 ? "#000000" : "#ffffff";
}

const FALLBACK: Accent = { accent: "#e0592f", onAccent: "#ffffff" };

/**
 * Extract a vibrant accent color from artwork by sampling a downscaled copy and
 * favoring saturated, mid-bright pixels (Spicetify-style dynamic accent).
 */
export function extractAccent(dataUrl: string): Promise<Accent> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous"; // needed to sample remote (iTunes) covers
    img.onload = () => {
      const size = 40;
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d");
      if (!ctx) return resolve(FALLBACK);
      ctx.drawImage(img, 0, 0, size, size);
      let data: Uint8ClampedArray;
      try {
        data = ctx.getImageData(0, 0, size, size).data;
      } catch {
        return resolve(FALLBACK); // tainted canvas (no CORS), keep default
      }

      let best = { score: -1, r: 224, g: 89, b: 47 };
      let sum = { r: 0, g: 0, b: 0, n: 0 };
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i], g = data[i + 1], b = data[i + 2];
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        const sat = max === 0 ? 0 : (max - min) / max;
        const val = max / 255;
        sum.r += r; sum.g += g; sum.b += b; sum.n++;
        // Prefer saturated, not-too-dark, not-blown-out pixels.
        const score = sat * (val > 0.25 && val < 0.95 ? 1 : 0.2);
        if (score > best.score) best = { score, r, g, b };
      }
      // If the art is basically greyscale, fall back to a brightened average.
      const chosen =
        best.score < 0.15
          ? {
              r: Math.min(255, (sum.r / sum.n) * 1.4),
              g: Math.min(255, (sum.g / sum.n) * 1.4),
              b: Math.min(255, (sum.b / sum.n) * 1.4),
            }
          : best;
      const r = Math.round(chosen.r);
      const g = Math.round(chosen.g);
      const b = Math.round(chosen.b);
      resolve({
        accent: `rgb(${r}, ${g}, ${b})`,
        onAccent: contrastOn(r, g, b),
      });
    };
    img.onerror = () => resolve(FALLBACK);
    img.src = dataUrl;
  });
}
