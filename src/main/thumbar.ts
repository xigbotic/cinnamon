import { nativeImage, type BrowserWindow, type NativeImage } from "electron";

/**
 * Previous / play-pause / next buttons in the Windows taskbar hover preview.
 * The icons are drawn here rather than shipped as files: a few polygons,
 * rasterised with 4x4 supersampling for clean edges at 32px (16px @2x).
 */

type Pt = [number, number];
const SIZE = 32;
const SS = 4;

function inPolygon(x: number, y: number, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** White shapes on transparent, as a BGRA bitmap. Coordinates are 0..24. */
function icon(shapes: Pt[][]): NativeImage {
  const buf = Buffer.alloc(SIZE * SIZE * 4);
  const k = 24 / SIZE;
  for (let py = 0; py < SIZE; py++) {
    for (let px = 0; px < SIZE; px++) {
      let hits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) * k;
          const y = (py + (sy + 0.5) / SS) * k;
          if (shapes.some((s) => inPolygon(x, y, s))) hits++;
        }
      }
      const a = Math.round((hits / (SS * SS)) * 255);
      const o = (py * SIZE + px) * 4;
      buf[o] = buf[o + 1] = buf[o + 2] = 255;
      buf[o + 3] = a;
    }
  }
  return nativeImage.createFromBitmap(buf, { width: SIZE, height: SIZE, scaleFactor: 2 });
}

const rect = (x0: number, y0: number, x1: number, y1: number): Pt[] => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];

// Same geometry as the in-app SVG controls (24-unit viewBox).
const ICONS = {
  prev: icon([rect(6, 6, 8.2, 18), [[19, 6], [19, 18], [10, 12]]]),
  next: icon([rect(15.8, 6, 18, 18), [[5, 6], [14, 12], [5, 18]]]),
  play: icon([[[7, 5], [18, 12], [7, 19]]]),
  pause: icon([rect(7, 5, 10.5, 19), rect(13.5, 5, 17, 19)]),
};

export class Thumbar {
  private playing = false;

  constructor(
    private win: () => BrowserWindow | null,
    private transport: (cmd: "prev" | "playpause" | "next") => void
  ) {}

  /** Call on play/pause changes. Windows also drops the buttons whenever the
   * window is hidden, so call it again when the window is shown. */
  update(playing = this.playing) {
    this.playing = playing;
    const w = this.win();
    if (!w || w.isDestroyed() || process.platform !== "win32") return;
    w.setThumbarButtons([
      { tooltip: "Previous", icon: ICONS.prev, click: () => this.transport("prev") },
      {
        tooltip: playing ? "Pause" : "Play",
        icon: playing ? ICONS.pause : ICONS.play,
        click: () => this.transport("playpause"),
      },
      { tooltip: "Next", icon: ICONS.next, click: () => this.transport("next") },
    ]);
  }
}
