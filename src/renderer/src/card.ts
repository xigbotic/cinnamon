import { extractAccent } from "./themes";

export type CardFormat = "square" | "story";

export interface CardInput {
  lines: string[];
  track: string;
  artist: string;
  /** Cover as a data: URL (remote covers are fetched to data first, so the
   * canvas stays exportable). Empty when there's no artwork. */
  cover: string;
  format: CardFormat;
}

const FONT = '"Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif';
const W = 1080;
const PAD = 90;

function loadImage(src: string): Promise<HTMLImageElement | null> {
  if (!src) return Promise.resolve(null);
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

/** Draws `img` to fill the rect, cropping the overflow (CSS cover). */
function drawCover(ctx: CanvasRenderingContext2D, img: HTMLImageElement, x: number, y: number, w: number, h: number) {
  const s = Math.max(w / img.width, h / img.height);
  const sw = w / s;
  const sh = h / s;
  ctx.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, x, y, w, h);
}

/** Greedy word wrap. */
function wrap(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width <= maxW || !line) line = next;
    else {
      out.push(line);
      line = word;
    }
  }
  if (line) out.push(line);
  return out;
}

function ellipsize(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxW) t = t.slice(0, -1);
  return `${t.trimEnd()}…`;
}

/** Renders a share card and returns it as a PNG data URL. */
export async function renderCard(input: CardInput): Promise<string> {
  const H = input.format === "story" ? 1920 : 1080;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  const img = await loadImage(input.cover);
  const { accent } = input.cover ? await extractAccent(input.cover) : { accent: "#e0592f" };

  // Background: the cover, heavily blurred and darkened, so any artwork works
  // as a backdrop and the white lyrics stay readable.
  ctx.fillStyle = "#0b0b0e";
  ctx.fillRect(0, 0, W, H);
  if (img) {
    ctx.save();
    ctx.filter = "blur(70px) saturate(1.4)";
    drawCover(ctx, img, -140, -140, W + 280, H + 280);
    ctx.restore();
  } else {
    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, accent);
    g.addColorStop(1, "#0b0b0e");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }
  const shade = ctx.createLinearGradient(0, 0, 0, H);
  shade.addColorStop(0, "rgba(0,0,0,0.35)");
  shade.addColorStop(0.5, "rgba(0,0,0,0.5)");
  shade.addColorStop(1, "rgba(0,0,0,0.72)");
  ctx.fillStyle = shade;
  ctx.fillRect(0, 0, W, H);

  // Header: cover thumbnail, title and artist.
  const thumb = input.format === "story" ? 180 : 150;
  const headY = input.format === "story" ? 200 : PAD;
  if (img) {
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.5)";
    ctx.shadowBlur = 40;
    ctx.shadowOffsetY = 12;
    ctx.beginPath();
    ctx.roundRect(PAD, headY, thumb, thumb, 22);
    ctx.fillStyle = "#000";
    ctx.fill();
    ctx.restore();
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(PAD, headY, thumb, thumb, 22);
    ctx.clip();
    drawCover(ctx, img, PAD, headY, thumb, thumb);
    ctx.restore();
  }
  const textX = img ? PAD + thumb + 36 : PAD;
  const textW = W - textX - PAD;
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#fff";
  ctx.font = `800 46px ${FONT}`;
  ctx.fillText(ellipsize(ctx, input.track, textW), textX, headY + thumb / 2 - 4);
  ctx.fillStyle = "rgba(255,255,255,0.7)";
  ctx.font = `500 34px ${FONT}`;
  ctx.fillText(ellipsize(ctx, input.artist, textW), textX, headY + thumb / 2 + 46);

  // Lyrics: the largest size (up to 84px) whose wrapped lines fit the space.
  const top = headY + thumb + (input.format === "story" ? 140 : 80);
  const bottom = H - (input.format === "story" ? 260 : 150);
  const maxW = W - PAD * 2;
  let size = 84;
  let wrapped: string[][] = [];
  let lineH = 0;
  let gap = 0;
  for (; size >= 34; size -= 2) {
    ctx.font = `800 ${size}px ${FONT}`;
    wrapped = input.lines.map((l) => wrap(ctx, l, maxW));
    lineH = size * 1.18;
    gap = size * 0.45;
    const total = wrapped.reduce((h, w) => h + w.length * lineH, 0) + gap * (wrapped.length - 1);
    if (total <= bottom - top) break;
  }
  const total = wrapped.reduce((h, w) => h + w.length * lineH, 0) + gap * (wrapped.length - 1);
  let y = top + Math.max(0, (bottom - top - total) / 2) + size * 0.9;
  ctx.font = `800 ${size}px ${FONT}`;
  ctx.fillStyle = "#fff";
  ctx.shadowColor = "rgba(0,0,0,0.35)";
  ctx.shadowBlur = 24;
  for (const block of wrapped) {
    for (const l of block) {
      ctx.fillText(l, PAD, y);
      y += lineH;
    }
    y += gap;
  }
  ctx.shadowBlur = 0;

  // Footer: accent rule and wordmark.
  const footY = H - (input.format === "story" ? 170 : 80);
  ctx.fillStyle = accent;
  ctx.fillRect(PAD, footY - 30, 64, 6);
  ctx.fillStyle = "rgba(255,255,255,0.6)";
  ctx.font = `700 24px ${FONT}`;
  ctx.letterSpacing = "8px";
  ctx.fillText("CINNAMON", PAD, footY + 10);
  ctx.letterSpacing = "0px";

  return canvas.toDataURL("image/png");
}
