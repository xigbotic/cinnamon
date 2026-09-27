import { contextBridge, ipcRenderer } from "electron";
import type {
  NowPlaying,
  Artwork,
  TransportCommand,
  ScrobbleStatus,
  SearchResult,
  Lyrics,
  Settings,
  DiscordConfig,
  Prefs,
  TrackInfo,
  SleepStatus,
  UpdateStatus,
  RendererDiagnostics,
  StatsOverview,
  StatsPeriod,
  StatsTop,
  CustomTheme,
} from "../../shared/types";

const api = {
  // now-playing
  onState(cb: (state: NowPlaying) => void) {
    ipcRenderer.on("cinnamon:state", (_e, state: NowPlaying) => cb(state));
  },
  onArtwork(cb: (art: Artwork) => void) {
    ipcRenderer.on("cinnamon:artwork", (_e, art: Artwork) => cb(art));
  },
  transport(cmd: TransportCommand) {
    ipcRenderer.send("cinnamon:transport", cmd);
  },

  // scrobbling
  onScrobbleStatus(cb: (s: ScrobbleStatus) => void) {
    ipcRenderer.on("cinnamon:scrobble", (_e, s: ScrobbleStatus) => cb(s));
  },
  lastfmConnect: (): Promise<{ authUrl: string }> =>
    ipcRenderer.invoke("cinnamon:lastfm-connect"),
  lastfmComplete: (): Promise<boolean> =>
    ipcRenderer.invoke("cinnamon:lastfm-complete"),
  lastfmDisconnect: (): Promise<void> =>
    ipcRenderer.invoke("cinnamon:lastfm-disconnect"),

  // search + play
  search: (term: string): Promise<SearchResult[]> =>
    ipcRenderer.invoke("cinnamon:search", term),
  play: (deepLink: string): Promise<void> =>
    ipcRenderer.invoke("cinnamon:play", deepLink),

  // lyrics
  onLyrics(cb: (lyrics: Lyrics | null) => void) {
    ipcRenderer.on("cinnamon:lyrics", (_e, l: Lyrics | null) => cb(l));
  },
  onLyricOffset(cb: (seconds: number) => void) {
    ipcRenderer.on("cinnamon:lyric-offset", (_e, v: number) => cb(v));
  },
  onPrefs(cb: (prefs: Prefs) => void) {
    ipcRenderer.on("cinnamon:prefs", (_e, p: Prefs) => cb(p));
  },

  // last.fm track info + love
  onTrackInfo(cb: (info: TrackInfo | null) => void) {
    ipcRenderer.on("cinnamon:track-info", (_e, i: TrackInfo | null) => cb(i));
  },
  setLoved: (loved: boolean): Promise<void> => ipcRenderer.invoke("cinnamon:set-loved", loved),

  // sleep timer
  setSleep: (minutes: number | "track" | null): Promise<void> =>
    ipcRenderer.invoke("cinnamon:set-sleep", minutes),
  onSleep(cb: (s: SleepStatus) => void) {
    ipcRenderer.on("cinnamon:sleep", (_e, s: SleepStatus) => cb(s));
  },

  // updates
  onUpdate(cb: (s: UpdateStatus) => void) {
    ipcRenderer.on("cinnamon:update", (_e, s: UpdateStatus) => cb(s));
  },
  checkForUpdates: (): Promise<void> => ipcRenderer.invoke("cinnamon:check-updates"),
  installUpdate: () => ipcRenderer.send("cinnamon:install-update"),

  // listening stats
  statsOverview: (force?: boolean): Promise<StatsOverview | null> =>
    ipcRenderer.invoke("cinnamon:stats-overview", force),
  statsTop: (period: StatsPeriod, force?: boolean): Promise<StatsTop | null> =>
    ipcRenderer.invoke("cinnamon:stats-top", period, force),

  // share cards
  fetchImage: (url: string): Promise<string | null> => ipcRenderer.invoke("cinnamon:fetch-image", url),
  copyImage: (dataUrl: string): Promise<void> => ipcRenderer.invoke("cinnamon:copy-image", dataUrl),
  saveImage: (dataUrl: string, name: string): Promise<string | null> =>
    ipcRenderer.invoke("cinnamon:save-image", dataUrl, name),

  // diagnostics
  copyDiagnostics: (renderer: RendererDiagnostics): Promise<void> =>
    ipcRenderer.invoke("cinnamon:copy-diagnostics", renderer),

  // settings
  getSettings: (): Promise<Settings> =>
    ipcRenderer.invoke("cinnamon:get-settings"),
  setTheme: (theme: string): Promise<void> =>
    ipcRenderer.invoke("cinnamon:set-theme", theme),
  setCustomThemes: (themes: CustomTheme[]): Promise<void> =>
    ipcRenderer.invoke("cinnamon:set-custom-themes", themes),
  setStartWithWindows: (enabled: boolean): Promise<void> =>
    ipcRenderer.invoke("cinnamon:set-startup", enabled),
  setLyricOffset: (seconds: number): Promise<void> =>
    ipcRenderer.invoke("cinnamon:set-lyric-offset", seconds),
  setCloseToTray: (enabled: boolean): Promise<void> =>
    ipcRenderer.invoke("cinnamon:set-close-to-tray", enabled),
  setVisualizer: (id: string): Promise<void> =>
    ipcRenderer.invoke("cinnamon:set-visualizer", id),
  setVisualizerAudio: (enabled: boolean): Promise<void> =>
    ipcRenderer.invoke("cinnamon:set-visualizer-audio", enabled),
  setVisualizerAudioDevice: (deviceId: string): Promise<void> =>
    ipcRenderer.invoke("cinnamon:set-visualizer-audio-device", deviceId),
  setPref: (key: string, value: unknown): Promise<void> =>
    ipcRenderer.invoke("cinnamon:set-pref", key, value),
  setDiscordEnabled: (enabled: boolean): Promise<void> =>
    ipcRenderer.invoke("cinnamon:set-discord-enabled", enabled),
  setDiscordCustom: (useCustom: boolean): Promise<void> =>
    ipcRenderer.invoke("cinnamon:set-discord-custom", useCustom),
  setDiscordClientId: (id: string): Promise<boolean> =>
    ipcRenderer.invoke("cinnamon:set-discord-client-id", id),
  setDiscordConfig: (config: DiscordConfig): Promise<void> =>
    ipcRenderer.invoke("cinnamon:set-discord-config", config),

  // window controls
  windowMinimize: () => ipcRenderer.send("cinnamon:window-minimize"),
  windowClose: () => ipcRenderer.send("cinnamon:window-close"),
  toggleFullscreen: () =>
    ipcRenderer.send("cinnamon:window-toggle-fullscreen"),
  onFullscreen(cb: (isFullscreen: boolean) => void) {
    ipcRenderer.on("cinnamon:fullscreen", (_e, v: boolean) => cb(v));
  },

  // mini player
  miniHide: () => ipcRenderer.send("cinnamon:mini-hide"),

  // developer
  getLogs: (): Promise<string> => ipcRenderer.invoke("cinnamon:get-logs"),
  onLog(cb: (line: string) => void) {
    ipcRenderer.on("cinnamon:log", (_e, line: string) => cb(line));
  },
  openDataFolder: () => ipcRenderer.send("cinnamon:open-data-folder"),
};

contextBridge.exposeInMainWorld("cinnamon", api);
