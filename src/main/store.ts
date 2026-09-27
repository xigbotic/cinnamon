import { app } from "electron";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { CustomTheme } from "../../shared/types";

interface Persisted {
  sessionKey: string | null;
  username: string | null;
  totalScrobbles: number;
  theme: string;
  customThemes: CustomTheme[];
  startWithWindows: boolean;
  lyricOffset: number; // seconds; positive = lyrics highlight earlier
  closeToTray: boolean;
  visualizer: string; // none | aurora | pulse | bars | wave
  visualizerAudio: boolean; // opt-in system-audio capture for reactive modes
  visualizerAudioDevice: string; // "loopback" or a specific recording device id
  vizQuality: string; // low | medium | high | ultra
  vizPalette: boolean; // colour visualizers from the artwork palette
  vizAutoGain: boolean; // legacy on/off switch, read once to seed vizBoost
  vizBoost: string; // off | auto | 2 | 4 | 8 ("" = not chosen yet)
  immLayout: string; // full | player | minimal
  captionPos: string; // tl | tr | bl | br (minimal layout caption corner)
  vizCycle: string; // off | track | album: switch visualizer automatically
  onboarded: boolean; // first-run setup finished or skipped
  hotkeys: boolean; // global Ctrl+Alt shortcuts
  floatingLyrics: boolean;
  floatingLocked: boolean; // click-through; unlocked = draggable/resizable
  floatingSize: string; // s | m | l
  karaoke: boolean; // word-by-word lyric highlight
  notifyTrack: boolean; // Windows notification on track change
  floatingBounds: { x: number; y: number; width: number; height: number } | null;
  discordEnabled: boolean;
  discordClientId: string; // the user's own application, when discordUseCustomId
  /** null until migrated: older installs always entered their own ID. */
  discordUseCustomId: boolean | null;
  discordName: string; // "Listening to X" text, tokens {track}{artist}{album}{player}
  discordDetail: string; // template for line 1, tokens {track}{artist}{album}
  discordState: string; // template for line 2
  discordShowArt: boolean;
  discordShowProgress: boolean;
  discordShowPaused: boolean; // keep presence while paused
  discordShowButton: boolean; // "Play on Apple Music" button
}

const DEFAULTS: Persisted = {
  sessionKey: null,
  username: null,
  totalScrobbles: 0,
  theme: "cinnamon",
  customThemes: [],
  startWithWindows: false,
  lyricOffset: 0,
  closeToTray: true,
  visualizer: "aurora",
  visualizerAudio: false,
  visualizerAudioDevice: "loopback",
  vizQuality: "medium",
  vizPalette: true,
  vizAutoGain: true,
  vizBoost: "",
  immLayout: "full",
  captionPos: "bl",
  vizCycle: "off",
  onboarded: false,
  hotkeys: true,
  floatingLyrics: false,
  floatingLocked: true,
  floatingSize: "m",
  karaoke: false,
  notifyTrack: false,
  floatingBounds: null,
  discordEnabled: false,
  discordClientId: "",
  discordUseCustomId: null,
  discordName: "{artist}",
  discordDetail: "{track}",
  discordState: "by {artist}",
  discordShowArt: true,
  discordShowProgress: true,
  discordShowPaused: true,
  discordShowButton: false,
};

/** JSON-file persistence in Electron's userData dir. */
class Store {
  private path = join(app.getPath("userData"), "cinnamon.json");
  private data: Persisted = { ...DEFAULTS };

  load() {
    if (existsSync(this.path)) {
      try {
        this.data = { ...DEFAULTS, ...JSON.parse(readFileSync(this.path, "utf-8")) };
      } catch {
        this.data = { ...DEFAULTS };
      }
    }
  }

  private save() {
    writeFileSync(this.path, JSON.stringify(this.data, null, 2));
  }

  get<K extends keyof Persisted>(key: K): Persisted[K] {
    return this.data[key];
  }

  set<K extends keyof Persisted>(key: K, value: Persisted[K]) {
    this.data[key] = value;
    this.save();
  }
}

export const store = new Store();
