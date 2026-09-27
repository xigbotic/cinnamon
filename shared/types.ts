// Shared contract across the sidecar <-> main <-> renderer boundary.

export interface NowPlaying {
  playing: boolean;
  track: string | null;
  artist?: string;
  album?: string;
  duration?: number; // seconds; 0 for radio (no known length)
  position?: number; // seconds
}

export interface Artwork {
  track: string;
  dataUrl: string; // ready-to-use data: URL for <img>
}

// Messages the sidecar emits on stdout.
export type SidecarEvent =
  | { type: "ready" }
  | { type: "log"; message: string }
  | ({ type: "state" } & NowPlaying)
  | { type: "artwork"; track: string; dataB64: string; contentType: string };

// Transport commands sent to the sidecar on stdin.
export type TransportCommand =
  | { cmd: "playpause" }
  | { cmd: "play" }
  | { cmd: "pause" }
  | { cmd: "next" }
  | { cmd: "prev" }
  | { cmd: "seek"; position: number };

// ---- Scrobbling (Last.fm) ----

export interface ScrobbleStatus {
  connected: boolean;
  username?: string;
  totalScrobbles: number;
  qualified: boolean; // current track has passed the scrobble threshold
}

// ---- Search (iTunes Search API) ----

export interface SearchResult {
  trackId: number;
  trackName: string;
  artistName: string;
  collectionName: string;
  artworkUrl: string; // upgraded to a larger size than the API's default
  trackViewUrl: string; // the music.apple.com deep link
  explicit: boolean;
}

// ---- Lyrics (LRCLIB) ----

export interface LyricWord {
  time: number; // seconds
  text: string; // includes any trailing space
}

export interface LyricLine {
  time: number; // seconds
  text: string;
  /** Per-word timing, when the source has it (enhanced LRC). */
  words?: LyricWord[];
}

export interface Lyrics {
  track: string;
  synced: boolean;
  lines: LyricLine[]; // for plain lyrics, all times are 0
  plain?: string;
  source?: "juicewrld" | "lrclib";
}

// ---- Last.fm track info ----

export interface TrackInfo {
  track: string;
  artist: string;
  /** The user's scrobbles of this track (not counting the current play). */
  playcount: number;
  loved: boolean;
}

// ---- Listening stats (Last.fm) ----

export type StatsPeriod = "7day" | "1month" | "12month" | "overall";

export interface StatsOverview {
  user: string;
  total: number;
  /** Account creation, epoch seconds. */
  registered: number;
  today: number;
  streak: number;
  /** The streak fills the whole 30-day window, so it may be longer. */
  streakCapped: boolean;
  /** Plays per local day, oldest first ("YYYY-MM-DD"). */
  days: { date: string; plays: number }[];
  /** More scrobbles in the window than were fetched; the chart undercounts. */
  partial: boolean;
  onThisDay: {
    year: number;
    total: number;
    tracks: { name: string; artist: string; plays: number }[];
  };
}

export interface StatsTop {
  artists: { name: string; plays: number }[];
  tracks: { name: string; artist: string; plays: number }[];
  albums: { name: string; artist: string; plays: number; image: string }[];
}

// ---- Custom themes ----

/** The colours a user picks in the theme editor, all "#rrggbb". */
export interface ThemeColors {
  bg: string;
  card: string;
  border: string;
  text: string;
  textDim: string;
  textFaint: string;
  accent: string;
}

export interface CustomTheme {
  id: string; // "custom-<timestamp>"
  name: string;
  colors: ThemeColors;
}

// ---- Sleep timer ----

export interface SleepStatus {
  /** Epoch ms when playback pauses, for a timed sleep. */
  endsAt?: number;
  /** Pause when the current track finishes. */
  endOfTrack?: boolean;
}

// ---- Updates ----

export interface UpdateStatus {
  state: "dev" | "idle" | "checking" | "none" | "downloading" | "ready" | "error";
  version?: string;
  percent?: number;
  message?: string;
}

// ---- Settings / theme ----

export interface DiscordConfig {
  name: string; // "Listening to X", tokens: {track} {artist} {album} {player}
  detail: string; // template, tokens: {track} {artist} {album}
  state: string;
  showArt: boolean;
  showProgress: boolean;
  showPaused: boolean;
  showButton: boolean;
}

/** Simple preferences written through the generic, whitelisted setPref IPC. */
export interface Prefs {
  vizQuality: "low" | "medium" | "high" | "ultra";
  vizPalette: boolean;
  vizBoost: "off" | "auto" | "2" | "4" | "8";
  immLayout: "full" | "player" | "minimal";
  captionPos: "tl" | "tr" | "bl" | "br";
  vizCycle: "off" | "track" | "album";
  onboarded: boolean;
  hotkeys: boolean;
  floatingLyrics: boolean;
  floatingLocked: boolean;
  floatingSize: "s" | "m" | "l";
  karaoke: boolean;
  notifyTrack: boolean;
}

/** Snapshot the renderer adds to the diagnostics report. */
export interface RendererDiagnostics {
  visualizer: string;
  quality: string;
  webgl: boolean;
  audioCapture: boolean;
  audioSource: string;
  boost: string;
  gain: number;
  level: number;
  immersive: boolean;
  lyrics: string;
  screen: string;
}

export interface Settings extends Prefs {
  theme: string;
  customThemes: CustomTheme[];
  startWithWindows: boolean;
  lyricOffset: number;
  closeToTray: boolean;
  visualizer: string;
  visualizerAudio: boolean;
  visualizerAudioDevice: string;
  discordEnabled: boolean;
  discordClientId: string;
  discordUseCustomId: boolean;
  discord: DiscordConfig;
  version: string;
}

// The API surface exposed to the renderer via contextBridge.
export interface CinnamonApi {
  // now-playing
  onState(cb: (state: NowPlaying) => void): void;
  onArtwork(cb: (art: Artwork) => void): void;
  transport(cmd: TransportCommand): void;

  // scrobbling
  onScrobbleStatus(cb: (s: ScrobbleStatus) => void): void;
  lastfmConnect(): Promise<{ authUrl: string }>;
  lastfmComplete(): Promise<boolean>;
  lastfmDisconnect(): Promise<void>;

  // search + play
  search(term: string): Promise<SearchResult[]>;
  play(deepLink: string): Promise<void>;

  // lyrics
  onLyrics(cb: (lyrics: Lyrics | null) => void): void;
  onLyricOffset(cb: (seconds: number) => void): void;
  onPrefs(cb: (prefs: Prefs) => void): void;

  // last.fm track info + love
  onTrackInfo(cb: (info: TrackInfo | null) => void): void;
  setLoved(loved: boolean): Promise<void>;

  // sleep timer
  setSleep(minutes: number | "track" | null): Promise<void>;
  onSleep(cb: (s: SleepStatus) => void): void;

  // updates
  onUpdate(cb: (s: UpdateStatus) => void): void;
  checkForUpdates(): Promise<void>;
  installUpdate(): void;

  // listening stats
  statsOverview(force?: boolean): Promise<StatsOverview | null>;
  statsTop(period: StatsPeriod, force?: boolean): Promise<StatsTop | null>;

  // share cards
  fetchImage(url: string): Promise<string | null>;
  copyImage(dataUrl: string): Promise<void>;
  saveImage(dataUrl: string, name: string): Promise<string | null>;

  // diagnostics
  copyDiagnostics(renderer: RendererDiagnostics): Promise<void>;

  // settings
  getSettings(): Promise<Settings>;
  setTheme(theme: string): Promise<void>;
  setCustomThemes(themes: CustomTheme[]): Promise<void>;
  setStartWithWindows(enabled: boolean): Promise<void>;
  setLyricOffset(seconds: number): Promise<void>;
  setCloseToTray(enabled: boolean): Promise<void>;
  setVisualizer(id: string): Promise<void>;
  setVisualizerAudio(enabled: boolean): Promise<void>;
  setVisualizerAudioDevice(deviceId: string): Promise<void>;
  setPref<K extends keyof Prefs>(key: K, value: Prefs[K]): Promise<void>;
  setDiscordEnabled(enabled: boolean): Promise<void>;
  setDiscordCustom(useCustom: boolean): Promise<void>;
  /** False if the ID isn't a valid Discord application ID. */
  setDiscordClientId(id: string): Promise<boolean>;
  setDiscordConfig(config: DiscordConfig): Promise<void>;

  // window controls
  windowMinimize(): void;
  windowClose(): void;
  toggleFullscreen(): void;
  onFullscreen(cb: (isFullscreen: boolean) => void): void;

  // mini player
  miniHide(): void;

  // developer
  getLogs(): Promise<string>;
  onLog(cb: (line: string) => void): void;
  openDataFolder(): void;
}
