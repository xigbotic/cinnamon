import { BrowserWindow, screen } from "electron";
import { join } from "node:path";
import { store } from "./store";

const DEFAULT_W = 900;
const DEFAULT_H = 150;

/**
 * An always-on-top, transparent strip showing the current lyric line. Locked,
 * it ignores the mouse entirely (clicks go to whatever is underneath); unlocked,
 * it can be dragged and resized, and its position is remembered.
 */
export class FloatingLyrics {
  private win: BrowserWindow | null = null;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(
    private load: (w: BrowserWindow) => void,
    /** Replays the current track, lyrics and settings once the page is up. */
    private replay: (w: BrowserWindow) => void,
    private icon: string
  ) {}

  get visible(): boolean {
    return !!this.win && !this.win.isDestroyed() && this.win.isVisible();
  }

  get window(): BrowserWindow | null {
    return this.win && !this.win.isDestroyed() ? this.win : null;
  }

  private defaultBounds() {
    const wa = screen.getPrimaryDisplay().workArea;
    return {
      x: Math.round(wa.x + (wa.width - DEFAULT_W) / 2),
      y: wa.y + wa.height - DEFAULT_H - 40,
      width: DEFAULT_W,
      height: DEFAULT_H,
    };
  }

  /** Saved bounds, unless the display they were on is gone. */
  private bounds() {
    const b = store.get("floatingBounds");
    if (!b) return this.defaultBounds();
    const onScreen = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return b.x < a.x + a.width && b.x + b.width > a.x && b.y < a.y + a.height && b.y + b.height > a.y;
    });
    return onScreen ? b : this.defaultBounds();
  }

  private create() {
    const w = new BrowserWindow({
      ...this.bounds(),
      minWidth: 320,
      minHeight: 80,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: true,
      show: false,
      hasShadow: false,
      icon: this.icon,
      webPreferences: {
        preload: join(__dirname, "../preload/index.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    w.setAlwaysOnTop(true, "screen-saver"); // above fullscreen games and video
    this.load(w);
    w.webContents.on("did-finish-load", () => this.replay(w));
    const remember = () => {
      if (this.saveTimer) clearTimeout(this.saveTimer);
      this.saveTimer = setTimeout(() => {
        if (!w.isDestroyed()) store.set("floatingBounds", w.getBounds());
      }, 400);
    };
    w.on("moved", remember);
    w.on("resized", remember);
    this.win = w;
    this.applyLock();
  }

  show() {
    if (!this.window) this.create();
    this.win!.showInactive(); // never steal focus from the game/app in front
    this.applyLock();
  }

  hide() {
    this.window?.hide();
  }

  /** Locked: click-through and unfocusable. Unlocked: drag/resize handles. */
  applyLock() {
    const w = this.window;
    if (!w) return;
    const locked = store.get("floatingLocked");
    w.setIgnoreMouseEvents(locked);
    w.setFocusable(!locked);
    w.setResizable(!locked);
  }

  destroy() {
    this.window?.destroy();
    this.win = null;
  }
}
