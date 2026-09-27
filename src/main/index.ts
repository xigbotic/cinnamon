import {
  app,
  BrowserWindow,
  ipcMain,
  shell,
  Menu,
  Tray,
  screen,
  session,
  desktopCapturer,
  clipboard,
  Notification,
  nativeImage,
  dialog,
  globalShortcut,
} from "electron";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { Sidecar, resolveSidecar } from "./sidecar";
import { config } from "./config";
import { store } from "./store";
import { Scrobbler } from "./scrobbler";
import { searchCatalog, coverForTrack, lookupTrack } from "./search";
import { playDeepLink } from "./player";
import { fetchLyrics } from "./lyrics";
import { DiscordPresence, DEFAULT_DISCORD_APP_ID } from "./discord";
import { isJuiceWrld, juiceWrldCoverUrl } from "./juicewrld";
import { Updater } from "./updater";
import { SleepTimer } from "./sleep";
import { setHotkeys } from "./hotkeys";
import { FloatingLyrics } from "./floating";
import { buildDiagnostics } from "./diagnostics";
import { Thumbar } from "./thumbar";
import { Stats } from "./stats";
import { trackToastXml } from "./toast";
import type {
  SidecarEvent,
  TransportCommand,
  NowPlaying,
  Lyrics,
  Settings,
  Prefs,
  TrackInfo,
  RendererDiagnostics,
  StatsPeriod,
  CustomTheme,
} from "../../shared/types";

let win: BrowserWindow | null = null;
let miniWin: BrowserWindow | null = null;
let tray: Tray | null = null;
let sidecar: Sidecar | null = null;
let scrobbler: Scrobbler | null = null;
let discord: DiscordPresence | null = null;
let updater: Updater | null = null;
let sleep: SleepTimer | null = null;
let floating: FloatingLyrics | null = null;
const thumbar = new Thumbar(
  () => win,
  (cmd) => sidecar?.send({ cmd })
);
let isQuitting = false;

// Discord presence uses public URLs per track (SMTC gives bytes only).
let discordArtUrl: string | undefined;
let discordTrackUrl: string | undefined;
let discordTrackKey = ""; // guards against out-of-order lookup results
let lastPlaying = false;

function discordConfig(): import("../../shared/types").DiscordConfig {
  return {
    name: store.get("discordName"),
    detail: store.get("discordDetail"),
    state: store.get("discordState"),
    showArt: store.get("discordShowArt"),
    showProgress: store.get("discordShowProgress"),
    showPaused: store.get("discordShowPaused"),
    showButton: store.get("discordShowButton"),
  };
}

/** The built-in application, unless the user opted to use their own. */
function discordAppId(): string {
  const own = store.get("discordClientId").trim();
  return store.get("discordUseCustomId") && own ? own : DEFAULT_DISCORD_APP_ID;
}

/** (Re)connects with the current application ID, or disconnects. */
async function applyDiscord() {
  if (store.get("discordEnabled")) {
    await discord?.enable(discordAppId());
    if (lastState) updateDiscordForTrack(lastState);
  } else {
    await discord?.disable();
  }
}

function discordExtras() {
  return {
    artUrl: discordArtUrl,
    trackUrl: discordTrackUrl,
    config: discordConfig(),
  };
}

// Rolling in-app log buffer for the developer settings panel.
const LOG_MAX = 500;
const logBuffer: string[] = [];
function captureLog(line: string) {
  const entry = `[${new Date().toLocaleTimeString()}] ${line}`;
  logBuffer.push(entry);
  if (logBuffer.length > LOG_MAX) logBuffer.shift();
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send("cinnamon:log", entry);
  }
}
// Tee console output into the buffer so sidecar/scrobbler/errors are captured.
for (const level of ["log", "warn", "error"] as const) {
  const orig = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    orig(...args);
    captureLog(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
  };
}

// Last-known now-playing, replayed to the mini player when it opens.
let lastState: NowPlaying | null = null;
let lastArtwork: { track: string; dataUrl: string } | null = null;
// Replayed to windows that open mid-track (floating lyrics, reloaded main).
let lastLyrics: Lyrics | null = null;
let lastTrackInfo: TrackInfo | null = null;
let trackInfoKey = "";

/** Icon path that works in dev and packaged builds (bundled via extraResources). */
function iconPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "icon.ico")
    : join(app.getAppPath(), "build", "icon.ico");
}

// Lyrics are fetched per-track; guard against races and refetching the same one.
let lyricsTrackKey = "";
let lyricsSeq = 0;
/** Whether the last lyrics lookup had the track length to match against. */
let lyricsHadDuration = false;

// Cover-art fallback: some albums (e.g. animated/motion artwork) give SMTC no
// thumbnail, so if none arrives shortly after a track starts, pull the static
// cover from the iTunes catalog instead.
let artTrack = ""; // composite artist|track key for change detection
let artTitle = ""; // bare title, since artwork events carry only the title
let artReceived = false;
let artFallbackTimer: NodeJS.Timeout | null = null;

function send(channel: string, payload: unknown) {
  win?.webContents.send(channel, payload);
}

// Send to every window (main + mini) for shared now-playing channels.
function broadcast(channel: string, payload: unknown) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload);
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 460,
    height: 820,
    minWidth: 400,
    minHeight: 700,
    resizable: true,
    frame: false, // custom title bar in the renderer
    backgroundColor: "#0a0a0a",
    title: "Cinnamon",
    icon: iconPath(),
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // Windows drops thumbnail-toolbar buttons whenever the window hides.
  win.on("show", () => thumbar.update());
  win.webContents.on("did-finish-load", () => thumbar.update());

  // Tell the renderer when fullscreen toggles so it can show the immersive view.
  win.on("enter-full-screen", () => win?.webContents.send("cinnamon:fullscreen", true));
  win.on("leave-full-screen", () => win?.webContents.send("cinnamon:fullscreen", false));

  // Close button hides to tray (if enabled) instead of quitting.
  win.on("close", (e) => {
    if (isQuitting) return;
    if (store.get("closeToTray")) {
      e.preventDefault();
      win?.hide();
    } else {
      isQuitting = true;
      app.quit();
    }
  });

  if (process.env["ELECTRON_RENDERER_URL"]) {
    win.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    win.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

async function onTrackForLyrics(state: NowPlaying) {
  const key = `${state.artist}|${state.track}`;
  const hasDuration = !!state.duration && state.duration > 0;
  // SMTC often reports the title before the timeline, and the length is what
  // separates same-named songs, so a lookup made without it is redone once.
  if (!state.track) return;
  if (key === lyricsTrackKey && (lyricsHadDuration || !hasDuration)) return;
  lyricsTrackKey = key;
  lyricsHadDuration = hasDuration;
  const seq = ++lyricsSeq;
  let lyrics: Lyrics | null = null;
  try {
    lyrics = await fetchLyrics(state);
  } catch {
    lyrics = null;
  }
  if (seq !== lyricsSeq) return; // ignore stale
  lastLyrics = lyrics;
  broadcast("cinnamon:lyrics", lyrics);
}

/**
 * Optional "now playing" toast. Skipped while Cinnamon is the focused window
 * (you can already see the track), and delayed a moment so the cover art has
 * arrived to use as the icon.
 */
let notifyTimer: NodeJS.Timeout | null = null;
let lastToast: Notification | null = null;

/**
 * Writes the cover to a temp PNG for the toast. Unpackaged Win32 toasts can
 * only show local files. One file is reused, with the track in the name so
 * Windows doesn't show a cached cover from the previous song.
 */
async function toastCover(track: string): Promise<string> {
  if (lastArtwork?.track !== track || !lastArtwork.dataUrl.startsWith("data:")) return iconPath();
  const img = nativeImage.createFromDataURL(lastArtwork.dataUrl).resize({ width: 256, height: 256 });
  const tag = Buffer.from(track).toString("base64url").slice(0, 16);
  const file = join(app.getPath("temp"), `cinnamon-cover-${tag}.png`);
  await writeFile(file, img.toPNG());
  return file;
}

function scheduleTrackNotification(state: NowPlaying) {
  if (notifyTimer) clearTimeout(notifyTimer);
  if (!store.get("notifyTrack") || !state.track || !state.playing) return;
  const track = state.track;
  notifyTimer = setTimeout(async () => {
    if (lastState?.track !== track || !lastState.playing) return;
    if (win && !win.isDestroyed() && win.isVisible() && win.isFocused()) return;
    if (!Notification.isSupported()) return;
    const artist = lastState.artist ?? "";
    const album = lastState.album ?? "";
    const cover = await toastCover(track);
    lastToast?.close(); // skipping through tracks replaces, never stacks
    lastToast = new Notification(
      process.platform === "win32"
        ? { toastXml: trackToastXml(track, artist, album, cover) }
        : { title: track, body: [artist, album].filter(Boolean).join(" · "), icon: cover, silent: true }
    );
    lastToast.show();
  }, 1500);
}

/** Last.fm play count + loved flag for the playing track. */
async function refreshTrackInfo(state: NowPlaying) {
  const key = `${state.artist}|${state.track}`;
  trackInfoKey = key;
  lastTrackInfo = null;
  broadcast("cinnamon:track-info", null);
  const info = await scrobbler?.trackInfo(state);
  if (trackInfoKey !== key) return;
  lastTrackInfo = info ?? null;
  broadcast("cinnamon:track-info", lastTrackInfo);
}

async function setLoved(loved: boolean) {
  if (!lastState?.track || !scrobbler) return;
  await scrobbler.setLoved(lastState, loved);
  if (lastTrackInfo && lastTrackInfo.track === lastState.track) {
    lastTrackInfo = { ...lastTrackInfo, loved };
    broadcast("cinnamon:track-info", lastTrackInfo);
  }
}

/** Hotkey love toggle: no window may be visible, so confirm with a notification. */
async function toggleLoveFromHotkey() {
  if (!lastState?.track) return;
  const loved = !(lastTrackInfo?.loved ?? false);
  try {
    await setLoved(loved);
    notify(
      loved ? "Loved on Last.fm" : "Removed from loved tracks",
      `${lastState.track} · ${lastState.artist ?? ""}`
    );
  } catch (e) {
    notify("Couldn't update Last.fm", e instanceof Error ? e.message : String(e));
  }
}

function notify(title: string, body: string) {
  if (Notification.isSupported()) {
    new Notification({ title, body, silent: true, icon: iconPath() }).show();
  }
}

function prefs(): Prefs {
  return {
    vizQuality: store.get("vizQuality") as Prefs["vizQuality"],
    vizPalette: store.get("vizPalette"),
    // Carry over the old on/off auto-boost switch until a boost is picked.
    vizBoost: (store.get("vizBoost") ||
      (store.get("vizAutoGain") ? "auto" : "off")) as Prefs["vizBoost"],
    immLayout: store.get("immLayout") as Prefs["immLayout"],
    captionPos: store.get("captionPos") as Prefs["captionPos"],
    vizCycle: store.get("vizCycle") as Prefs["vizCycle"],
    onboarded: store.get("onboarded"),
    hotkeys: store.get("hotkeys"),
    floatingLyrics: store.get("floatingLyrics"),
    floatingLocked: store.get("floatingLocked"),
    floatingSize: store.get("floatingSize") as Prefs["floatingSize"],
    karaoke: store.get("karaoke"),
    notifyTrack: store.get("notifyTrack"),
  };
}

/** Side effects for preferences the main process acts on. */
function applyPref(key: keyof Prefs) {
  switch (key) {
    case "hotkeys":
      registerHotkeys();
      break;
    case "floatingLyrics":
      if (store.get("floatingLyrics")) floating?.show();
      else floating?.hide();
      rebuildTray();
      break;
    case "floatingLocked":
      floating?.applyLock();
      rebuildTray();
      break;
  }
  broadcast("cinnamon:prefs", prefs());
}

function setPref<K extends keyof Prefs>(key: K, value: Prefs[K]) {
  store.set(key, value as never);
  applyPref(key);
}

function registerHotkeys() {
  setHotkeys(store.get("hotkeys"), {
    playPause: () => sidecar?.send({ cmd: "playpause" }),
    next: () => sidecar?.send({ cmd: "next" }),
    prev: () => sidecar?.send({ cmd: "prev" }),
    love: () => void toggleLoveFromHotkey(),
    toggleFloating: () => setPref("floatingLyrics", !store.get("floatingLyrics")),
    toggleMini: () => toggleMini(),
    showMain: () => showMain(),
  });
}

function maybeScheduleCoverFallback(state: NowPlaying) {
  const key = `${state.artist}|${state.track}`;
  if (!state.track || key === artTrack) return;
  artTrack = key;
  artTitle = state.track;
  artReceived = false;
  if (artFallbackTimer) clearTimeout(artFallbackTimer);

  const track = state.track;
  const artist = state.artist || "";
  const album = state.album || "";
  artFallbackTimer = setTimeout(async () => {
    if (artReceived || artTrack !== key) return; // SMTC provided one after all
    const url = await coverForTrack(artist, track, album);
    if (url && artTrack === key && !artReceived) {
      const art = { track, dataUrl: url };
      lastArtwork = art;
      broadcast("cinnamon:artwork", art);
    }
  }, 2500);
}

async function updateDiscordForTrack(state: NowPlaying) {
  if (!discord) return;
  const key = `${state.artist}|${state.track}`;
  discordTrackKey = key;
  discordArtUrl = undefined;
  discordTrackUrl = undefined;

  // Update text immediately so the presence never lags behind the track.
  discord.update(state, discordExtras());

  // Then fill in cover URL + deep link, but only if this is still the current
  // track (guards against slower lookups for older tracks landing last).
  if (state.track && state.artist) {
    // Local/unreleased Juice WRLD tracks aren't in the iTunes catalog, but the
    // Juice WRLD API serves their cover art at a public URL Discord can fetch.
    if (isJuiceWrld(state.artist)) {
      const cover = await juiceWrldCoverUrl(state);
      if (discordTrackKey !== key) return;
      if (cover) {
        discordArtUrl = cover;
        discord.update(state, discordExtras());
      }
    }

    const hit = await lookupTrack(state.artist, state.track, state.album || "");
    if (discordTrackKey !== key) return;
    discordArtUrl = hit.artworkUrl || discordArtUrl; // keep API cover if iTunes misses
    discordTrackUrl = hit.trackViewUrl || undefined;
    discord.update(state, discordExtras());
  }
}

function startSidecar() {
  const { command, args } = resolveSidecar(config.pythonPath);
  sidecar = new Sidecar(command, args);

  sidecar.on((event: SidecarEvent) => {
    switch (event.type) {
      case "state": {
        const trackChanged = lastState?.track !== event.track;
        const playingChanged = lastPlaying !== event.playing;
        lastPlaying = event.playing;
        if (playingChanged) thumbar.update(event.playing);
        lastState = event;
        broadcast("cinnamon:state", event);
        scrobbler?.onState(event);
        sleep?.onState(event);
        onTrackForLyrics(event);
        maybeScheduleCoverFallback(event);
        if (trackChanged) {
          rebuildTray(); // refresh the "now playing" label in the tray menu
          tray?.setToolTip(
            event.track ? `${event.track} · ${event.artist ?? ""}` : "Cinnamon"
          );
          updateDiscordForTrack(event);
          refreshTrackInfo(event);
          scheduleTrackNotification(event);
        } else if (playingChanged) {
          discord?.update(event, discordExtras()); // refresh on pause/play
        }
        break;
      }
      case "artwork": {
        if (event.track === artTitle) artReceived = true;
        const art = {
          track: event.track,
          dataUrl: `data:${event.contentType.split(",")[0]};base64,${event.dataB64}`,
        };
        lastArtwork = art;
        broadcast("cinnamon:artwork", art);
        break;
      }
      case "log":
        console.log("[sidecar]", event.message);
        break;
      case "ready":
        console.log("[sidecar] ready");
        break;
    }
  });

  sidecar.start();
}

// ---- mini player ----
function loadRenderer(w: BrowserWindow, page: string) {
  const devUrl = process.env["ELECTRON_RENDERER_URL"];
  if (devUrl) w.loadURL(`${devUrl}/${page}`);
  else w.loadFile(join(__dirname, `../renderer/${page}`));
}

function replayToMini() {
  if (!miniWin || miniWin.isDestroyed()) return;
  if (lastState) miniWin.webContents.send("cinnamon:state", lastState);
  if (lastArtwork) miniWin.webContents.send("cinnamon:artwork", lastArtwork);
}

function positionMini() {
  if (!miniWin) return;
  const wa = screen.getPrimaryDisplay().workArea;
  const [w, h] = miniWin.getSize();
  miniWin.setPosition(wa.x + wa.width - w - 16, wa.y + wa.height - h - 16);
}

function createMiniWindow() {
  miniWin = new BrowserWindow({
    width: 360,
    height: 96,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    transparent: true,
    backgroundColor: "#00000000",
    icon: iconPath(),
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  miniWin.setAlwaysOnTop(true, "screen-saver"); // above fullscreen apps
  loadRenderer(miniWin, "mini.html");
  miniWin.webContents.on("did-finish-load", replayToMini);
  miniWin.on("close", (e) => {
    if (!isQuitting) {
      e.preventDefault();
      miniWin?.hide();
      rebuildTray();
    }
  });
}

function showMini() {
  if (!miniWin || miniWin.isDestroyed()) createMiniWindow();
  positionMini();
  miniWin!.show();
  replayToMini();
  rebuildTray();
}

function hideMini() {
  miniWin?.hide();
  rebuildTray();
}

function toggleMini() {
  if (miniWin && miniWin.isVisible()) hideMini();
  else showMini();
}

function showMain() {
  if (!win || win.isDestroyed()) createWindow();
  else {
    win.show();
    win.focus();
  }
}

// ---- tray ----
function buildTrayMenu() {
  const nowLabel =
    lastState?.track
      ? `${lastState.track}${lastState.artist ? " · " + lastState.artist : ""}`
      : "Nothing playing";
  return Menu.buildFromTemplate([
    { label: nowLabel, enabled: false },
    { type: "separator" },
    { label: "Play / Pause", click: () => sidecar?.send({ cmd: "playpause" }) },
    { label: "Next", click: () => sidecar?.send({ cmd: "next" }) },
    { label: "Previous", click: () => sidecar?.send({ cmd: "prev" }) },
    { type: "separator" },
    {
      label: "Mini Player",
      type: "checkbox",
      checked: !!(miniWin && !miniWin.isDestroyed() && miniWin.isVisible()),
      click: () => toggleMini(),
    },
    {
      label: "Floating Lyrics",
      type: "checkbox",
      checked: store.get("floatingLyrics"),
      click: () => setPref("floatingLyrics", !store.get("floatingLyrics")),
    },
    {
      label: "Lock Floating Lyrics",
      type: "checkbox",
      checked: store.get("floatingLocked"),
      enabled: store.get("floatingLyrics"),
      click: () => setPref("floatingLocked", !store.get("floatingLocked")),
    },
    { label: sleepLabel(), submenu: sleepMenu() },
    { label: "Show Cinnamon", click: () => showMain() },
    ...(updater?.current.state === "ready"
      ? [{ label: `Restart to update (${updater.current.version})`, click: () => updater?.install() }]
      : []),
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
}

function sleepLabel(): string {
  const s = sleep?.status ?? {};
  if (s.endOfTrack) return "Sleep Timer (end of track)";
  if (s.endsAt) {
    return `Sleep Timer (${Math.max(1, Math.round((s.endsAt - Date.now()) / 60000))} min left)`;
  }
  return "Sleep Timer";
}

function sleepMenu(): Electron.MenuItemConstructorOptions[] {
  const opt = (label: string, v: number | "track" | null) => ({
    label,
    click: () => sleep?.set(v),
  });
  return [
    opt("15 minutes", 15),
    opt("30 minutes", 30),
    opt("45 minutes", 45),
    opt("1 hour", 60),
    opt("End of track", "track"),
    { type: "separator" },
    { ...opt("Off", null), enabled: !!(sleep?.status.endsAt || sleep?.status.endOfTrack) },
  ];
}

function rebuildTray() {
  tray?.setContextMenu(buildTrayMenu());
}

function createTray() {
  try {
    tray = new Tray(iconPath());
    tray.setToolTip("Cinnamon");
    tray.setContextMenu(buildTrayMenu());
    tray.on("click", () => showMain());
  } catch (e) {
    console.error("[tray] failed to create", e);
  }
}

const APP_ID = "com.xignotic.cinnamon";
if (process.platform === "win32") app.setAppUserModelId(APP_ID);

/**
 * Names the app in the Windows notification header. Windows reads the name
 * from the Start-menu shortcut (only installed builds have one) or from this
 * per-user registry key, so write the key and every build shows "Cinnamon".
 */
function registerToastIdentity() {
  if (process.platform !== "win32") return;
  const key = `HKCU\\Software\\Classes\\AppUserModelId\\${APP_ID}`;
  const set = (name: string, value: string) =>
    execFile("reg", ["add", key, "/v", name, "/t", "REG_EXPAND_SZ", "/d", value, "/f"], (err) => {
      if (err) console.warn("[notify] couldn't register app name", err.message);
    });
  set("DisplayName", "Cinnamon");
  // A .png icon, since Windows won't read the one packed inside an .ico here.
  set("IconUri", iconPath().replace(/\.ico$/, ".png"));
}

app.whenReady().then(() => {
  store.load();
  // Before the built-in app ID existed, everyone pasted their own. Keep using
  // it for them; new installs start on the built-in one.
  if (store.get("discordUseCustomId") === null) {
    const own = store.get("discordClientId").trim();
    store.set("discordUseCustomId", !!own && own !== DEFAULT_DISCORD_APP_ID);
  }
  registerToastIdentity();
  Menu.setApplicationMenu(null); // no native menu bar (File/Edit/View/...)

  // Allow media capture for the visualizer (and so device labels resolve when
  // enumerating recording devices).
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) =>
    cb(permission === "media")
  );

  // Lets the visualizer capture Windows system audio (loopback) when the user
  // opts in. The renderer drops the video track immediately: we only want sound.
  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      desktopCapturer
        .getSources({ types: ["screen"] })
        .then((sources) => callback({ video: sources[0], audio: "loopback" }))
        .catch(() => callback({}));
    },
    { useSystemPicker: false }
  );

  createWindow();

  scrobbler = new Scrobbler((s) => broadcast("cinnamon:scrobble", s));
  sleep = new SleepTimer(
    () => sidecar?.send({ cmd: "pause" }),
    (s) => {
      broadcast("cinnamon:sleep", s);
      rebuildTray();
    },
    () => lastState
  );
  updater = new Updater(
    (s) => {
      broadcast("cinnamon:update", s);
      if (s.state === "ready") rebuildTray();
    },
    () => {
      isQuitting = true; // let the windows actually close
    }
  );
  updater.start();
  floating = new FloatingLyrics(
    (w) => loadRenderer(w, "lyrics.html"),
    (w) => {
      if (lastState) w.webContents.send("cinnamon:state", lastState);
      w.webContents.send("cinnamon:lyrics", lastLyrics);
      w.webContents.send("cinnamon:prefs", prefs());
      w.webContents.send("cinnamon:lyric-offset", store.get("lyricOffset"));
    },
    iconPath()
  );
  if (store.get("floatingLyrics")) floating.show();
  registerHotkeys();
  discord = new DiscordPresence();
  if (store.get("discordEnabled")) discord.enable(discordAppId());
  startSidecar();

  // Push initial scrobble status once the renderer is up.
  win?.webContents.on("did-finish-load", () => {
    send("cinnamon:scrobble", scrobbler!.status());
    send("cinnamon:update", updater!.current);
    send("cinnamon:sleep", sleep!.status);
    if (lastLyrics) send("cinnamon:lyrics", lastLyrics);
    if (lastTrackInfo) send("cinnamon:track-info", lastTrackInfo);
  });

  // ---- IPC ----
  ipcMain.on("cinnamon:transport", (_e, cmd: TransportCommand) =>
    sidecar?.send(cmd)
  );

  // Window controls (frameless custom title bar).
  ipcMain.on("cinnamon:window-minimize", () => win?.minimize());
  ipcMain.on("cinnamon:window-close", () => win?.close());
  ipcMain.on("cinnamon:window-toggle-fullscreen", () => {
    if (!win) return;
    win.setFullScreen(!win.isFullScreen());
  });
  ipcMain.on("cinnamon:mini-hide", () => hideMini());

  ipcMain.handle("cinnamon:lastfm-connect", async () => {
    const r = await scrobbler!.connect();
    await shell.openExternal(r.authUrl); // send user to Last.fm to authorize
    return r;
  });
  ipcMain.handle("cinnamon:lastfm-complete", async () => {
    const ok = await scrobbler!.complete();
    if (ok && lastState?.track) refreshTrackInfo(lastState); // play count for the current track
    return ok;
  });
  ipcMain.handle("cinnamon:lastfm-disconnect", () => {
    scrobbler!.disconnect();
    lastTrackInfo = null;
    broadcast("cinnamon:track-info", null);
  });
  ipcMain.handle("cinnamon:set-loved", (_e, loved: boolean) => setLoved(loved));

  // Listening stats. Null when not connected; errors are logged and surfaced
  // to the page as null so it can show a retry.
  const stats = new Stats((p) => scrobbler!.apiGet(p));
  const statsUser = () => (store.get("sessionKey") ? store.get("username") : null);
  ipcMain.handle("cinnamon:stats-overview", async (_e, force?: boolean) => {
    const user = statsUser();
    if (!user) return null;
    try {
      return await stats.overview(user, !!force);
    } catch (e) {
      console.error("[stats] overview failed", e);
      throw e;
    }
  });
  ipcMain.handle("cinnamon:stats-top", async (_e, period: StatsPeriod, force?: boolean) => {
    const user = statsUser();
    if (!user) return null;
    if (!["7day", "1month", "12month", "overall"].includes(period)) return null;
    try {
      return await stats.top(user, period, !!force);
    } catch (e) {
      console.error("[stats] top lists failed", e);
      throw e;
    }
  });

  ipcMain.handle("cinnamon:set-sleep", (_e, v: number | "track" | null) => sleep?.set(v));

  ipcMain.handle("cinnamon:check-updates", () => updater?.check());
  ipcMain.on("cinnamon:install-update", () => updater?.install());

  // Share cards: remote covers are fetched here and handed back as data URLs,
  // so the renderer's canvas isn't tainted and can export the PNG. Limited to
  // the image hosts the app already uses.
  const IMAGE_HOSTS = [/\.mzstatic\.com$/, /^juicewrldapi\.com$/, /^lastfm(-img)?\.freetls\.fastly\.net$/];
  ipcMain.handle("cinnamon:fetch-image", async (_e, url: string) => {
    try {
      const u = new URL(url);
      if (u.protocol !== "https:" || !IMAGE_HOSTS.some((h) => h.test(u.hostname))) return null;
      const res = await fetch(u);
      if (!res.ok) return null;
      const type = res.headers.get("content-type") || "image/jpeg";
      return `data:${type};base64,${Buffer.from(await res.arrayBuffer()).toString("base64")}`;
    } catch {
      return null;
    }
  });
  ipcMain.handle("cinnamon:copy-image", (_e, dataUrl: string) => {
    clipboard.writeImage(nativeImage.createFromDataURL(dataUrl));
  });
  ipcMain.handle("cinnamon:save-image", async (_e, dataUrl: string, name: string) => {
    const safe = name.replace(/[\\/:*?"<>|]+/g, " ").trim() || "Cinnamon";
    const r = await dialog.showSaveDialog(win!, {
      defaultPath: join(app.getPath("pictures"), `${safe}.png`),
      filters: [{ name: "PNG image", extensions: ["png"] }],
    });
    if (r.canceled || !r.filePath) return null;
    await writeFile(r.filePath, Buffer.from(dataUrl.split(",")[1], "base64"));
    return r.filePath;
  });

  ipcMain.handle("cinnamon:copy-diagnostics", async (_e, r: RendererDiagnostics) => {
    const text = await buildDiagnostics(
      {
        state: lastState,
        lyrics: lastLyrics,
        sidecarRunning: !!sidecar?.running,
        update: updater!.current,
        logs: logBuffer,
      },
      r
    );
    clipboard.writeText(text);
  });

  ipcMain.handle("cinnamon:search", (_e, term: string) => searchCatalog(term));
  ipcMain.handle("cinnamon:play", (_e, deepLink: string) =>
    playDeepLink(deepLink)
  );

  ipcMain.handle("cinnamon:get-settings", (): Settings => ({
    ...prefs(),
    theme: store.get("theme"),
    customThemes: store.get("customThemes"),
    startWithWindows: store.get("startWithWindows"),
    lyricOffset: store.get("lyricOffset"),
    closeToTray: store.get("closeToTray"),
    visualizer: store.get("visualizer"),
    visualizerAudio: store.get("visualizerAudio"),
    visualizerAudioDevice: store.get("visualizerAudioDevice"),
    discordEnabled: store.get("discordEnabled"),
    discordClientId: store.get("discordClientId"),
    discordUseCustomId: !!store.get("discordUseCustomId"),
    discord: discordConfig(),
    version: app.getVersion(),
  }));
  ipcMain.handle("cinnamon:set-lyric-offset", (_e, seconds: number) => {
    store.set("lyricOffset", seconds);
    broadcast("cinnamon:lyric-offset", seconds); // floating lyrics follow the nudge
  });
  ipcMain.handle("cinnamon:set-theme", (_e, theme: string) =>
    store.set("theme", theme)
  );
  // Theme editor: validate everything, since it's written straight to disk.
  ipcMain.handle("cinnamon:set-custom-themes", (_e, themes: unknown) => {
    const hex = (v: unknown) => typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v);
    const KEYS = ["bg", "card", "border", "text", "textDim", "textFaint", "accent"] as const;
    if (!Array.isArray(themes) || themes.length > 24) return;
    const clean: CustomTheme[] = [];
    for (const t of themes as any[]) {
      if (typeof t?.id !== "string" || !/^custom-\d+$/.test(t.id)) return;
      if (typeof t.name !== "string" || !t.name.trim() || t.name.length > 30) return;
      if (!KEYS.every((k) => hex(t.colors?.[k]))) return;
      clean.push({
        id: t.id,
        name: t.name.trim(),
        colors: Object.fromEntries(KEYS.map((k) => [k, t.colors[k].toLowerCase()])) as CustomTheme["colors"],
      });
    }
    store.set("customThemes", clean);
  });
  ipcMain.handle("cinnamon:set-startup", (_e, enabled: boolean) => {
    store.set("startWithWindows", enabled);
    app.setLoginItemSettings({ openAtLogin: enabled });
  });
  ipcMain.handle("cinnamon:set-close-to-tray", (_e, enabled: boolean) =>
    store.set("closeToTray", enabled)
  );
  ipcMain.handle("cinnamon:set-visualizer", (_e, id: string) =>
    store.set("visualizer", id)
  );
  ipcMain.handle("cinnamon:set-visualizer-audio", (_e, enabled: boolean) =>
    store.set("visualizerAudio", enabled)
  );
  ipcMain.handle("cinnamon:set-visualizer-audio-device", (_e, id: string) =>
    store.set("visualizerAudioDevice", id)
  );

  // Generic preference writes, restricted to known keys and allowed values so
  // the renderer can't write arbitrary store entries.
  const PREF_VALUES: Record<string, readonly unknown[]> = {
    vizQuality: ["low", "medium", "high", "ultra"],
    vizPalette: [true, false],
    vizBoost: ["off", "auto", "2", "4", "8"],
    immLayout: ["full", "player", "minimal"],
    captionPos: ["tl", "tr", "bl", "br"],
    vizCycle: ["off", "track", "album"],
    onboarded: [true, false],
    hotkeys: [true, false],
    floatingLyrics: [true, false],
    floatingLocked: [true, false],
    floatingSize: ["s", "m", "l"],
    karaoke: [true, false],
    notifyTrack: [true, false],
  };
  ipcMain.handle("cinnamon:set-pref", (_e, key: keyof Prefs, value: unknown) => {
    const allowed = PREF_VALUES[key];
    if (!allowed || !allowed.includes(value)) return;
    setPref(key, value as never);
  });
  ipcMain.handle("cinnamon:set-discord-enabled", async (_e, enabled: boolean) => {
    store.set("discordEnabled", enabled);
    await applyDiscord();
  });
  ipcMain.handle("cinnamon:set-discord-custom", async (_e, useCustom: boolean) => {
    store.set("discordUseCustomId", useCustom);
    await applyDiscord();
  });
  ipcMain.handle("cinnamon:set-discord-client-id", async (_e, id: string) => {
    // Application IDs are Discord snowflakes: digits only.
    const clean = id.trim();
    if (clean && !/^\d{15,22}$/.test(clean)) return false;
    store.set("discordClientId", clean);
    if (store.get("discordUseCustomId")) await applyDiscord();
    return true;
  });
  ipcMain.handle(
    "cinnamon:set-discord-config",
    (_e, cfg: import("../../shared/types").DiscordConfig) => {
      store.set("discordName", cfg.name);
      store.set("discordDetail", cfg.detail);
      store.set("discordState", cfg.state);
      store.set("discordShowArt", cfg.showArt);
      store.set("discordShowProgress", cfg.showProgress);
      store.set("discordShowPaused", cfg.showPaused);
      store.set("discordShowButton", cfg.showButton);
      if (lastState) discord?.update(lastState, discordExtras());
    }
  );

  // Developer
  ipcMain.handle("cinnamon:get-logs", () => logBuffer.join("\n"));
  ipcMain.on("cinnamon:open-data-folder", () =>
    shell.openPath(app.getPath("userData"))
  );

  // Create the tray last so a tray failure can never block IPC registration.
  createTray();

  app.on("activate", () => {
    showMain();
  });
});

// The app lives in the tray; closing windows doesn't quit it.
app.on("window-all-closed", () => {
  /* stay running in the tray */
});

// A GPU driver reset takes Chromium's GPU process down with it. The renderer
// rebuilds its WebGL state; here we record it (so it shows in the dev logs) and
// force a repaint so no stale/white frame lingers once the GPU process is back.
app.on("child-process-gone", (_e, details) => {
  if (details.type !== "GPU") return;
  console.error(`[gpu] GPU process ${details.reason} (exit ${details.exitCode}), recovering`);
  setTimeout(() => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.invalidate();
    }
  }, 1500);
});

app.on("will-quit", () => globalShortcut.unregisterAll());

app.on("before-quit", () => {
  isQuitting = true;
  sidecar?.stop();
  discord?.disable();
});
