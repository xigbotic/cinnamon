import { app } from "electron";
import { autoUpdater } from "electron-updater";
import type { UpdateStatus } from "../../shared/types";

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const FEED_OWNER = "xigbotic";
const FEED_REPO = "cinnamon";

/**
 * Auto-updates from GitHub Releases (see "publish" in package.json). Updates
 * download in the background and install on the next quit, or right away when
 * the user clicks "Restart to update". Dev builds skip all of this.
 */
export class Updater {
  private status: UpdateStatus = { state: app.isPackaged ? "idle" : "dev" };

  constructor(
    private emit: (s: UpdateStatus) => void,
    /** Lets the app drop its close-to-tray guard before quitAndInstall. */
    private beforeInstall: () => void
  ) {}

  get current(): UpdateStatus {
    return this.status;
  }

  private set(s: UpdateStatus) {
    this.status = s;
    this.emit(s);
  }

  start() {
    if (!app.isPackaged) return;
    // Set the feed here rather than relying on app-update.yml: our two-step
    // build (--dir, then --prepackaged for the icon workaround) never writes
    // that file. Keep in sync with "publish" in package.json.
    autoUpdater.setFeedURL({ provider: "github", owner: FEED_OWNER, repo: FEED_REPO });
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.logger = {
      info: (m: unknown) => console.log("[updater]", String(m)),
      warn: (m: unknown) => console.warn("[updater]", String(m)),
      error: (m: unknown) => console.error("[updater]", String(m)),
      debug: () => {},
    };

    autoUpdater.on("checking-for-update", () => this.set({ state: "checking" }));
    autoUpdater.on("update-not-available", () => this.set({ state: "none" }));
    autoUpdater.on("update-available", (info) =>
      this.set({ state: "downloading", version: info.version, percent: 0 })
    );
    autoUpdater.on("download-progress", (p) =>
      this.set({ ...this.status, state: "downloading", percent: Math.round(p.percent) })
    );
    autoUpdater.on("update-downloaded", (info) =>
      this.set({ state: "ready", version: info.version })
    );
    autoUpdater.on("error", (e) =>
      this.set({ state: "error", message: e?.message ?? String(e) })
    );

    this.check();
    setInterval(() => this.check(), CHECK_EVERY_MS);
  }

  async check() {
    if (!app.isPackaged) return;
    // Don't interrupt a download that's already under way.
    if (this.status.state === "downloading" || this.status.state === "ready") return;
    try {
      await autoUpdater.checkForUpdates();
    } catch {
      /* reported through the "error" event */
    }
  }

  install() {
    if (this.status.state !== "ready") return;
    this.beforeInstall();
    autoUpdater.quitAndInstall();
  }
}
