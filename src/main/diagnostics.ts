import { app } from "electron";
import { release, arch } from "node:os";
import { store } from "./store";
import type { Lyrics, NowPlaying, RendererDiagnostics, UpdateStatus } from "../../shared/types";

export interface MainDiagnostics {
  state: NowPlaying | null;
  lyrics: Lyrics | null;
  sidecarRunning: boolean;
  update: UpdateStatus;
  logs: string[];
}

const LOG_LINES = 120;

/** GPU name and driver, from Chromium's report. Best effort: never throws. */
async function gpuSummary(): Promise<string> {
  try {
    const info: any = await Promise.race([
      app.getGPUInfo("complete"),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 3000)),
    ]);
    const active = (info.gpuDevice ?? []).find((d: any) => d.active) ?? info.gpuDevice?.[0];
    const renderer = info.auxAttributes?.glRenderer ?? "unknown renderer";
    const driver = active?.driverVersion ? `, driver ${active.driverVersion}` : "";
    return `${renderer}${driver}`;
  } catch {
    return "unavailable";
  }
}

/**
 * Plain-text report for bug reports. Deliberately leaves out secrets: the
 * Last.fm session key and Discord client ID are reported only as set / not set.
 */
export async function buildDiagnostics(m: MainDiagnostics, r: RendererDiagnostics): Promise<string> {
  const gpuStatus = app.getGPUFeatureStatus();
  const s = m.state;
  const lines = [
    "## Cinnamon diagnostics",
    `Generated: ${new Date().toISOString()}`,
    "",
    "### App",
    `Version: ${app.getVersion()}${app.isPackaged ? "" : " (dev build)"}`,
    `Electron ${process.versions.electron} · Chromium ${process.versions.chrome} · Node ${process.versions.node}`,
    `Windows ${release()} (${arch()})`,
    `Update status: ${m.update.state}${m.update.version ? ` ${m.update.version}` : ""}${m.update.message ? `: ${m.update.message}` : ""}`,
    "",
    "### Graphics",
    `GPU: ${await gpuSummary()}`,
    `WebGL: ${gpuStatus.webgl} · Compositing: ${gpuStatus.gpu_compositing}`,
    `Screen: ${r.screen}`,
    "",
    "### Playback",
    `Media helper: ${m.sidecarRunning ? "running" : "not running"}`,
    s?.track
      ? `Track: ${s.track} by ${s.artist ?? "?"} (${s.album ?? "no album"}), ${s.playing ? "playing" : "paused"}, ${Math.round(s.position ?? 0)}s / ${Math.round(s.duration ?? 0)}s`
      : "Track: nothing playing",
    `Lyrics: ${m.lyrics ? `${m.lyrics.synced ? "synced" : "plain"}, ${m.lyrics.lines.length} lines, from ${m.lyrics.source ?? "unknown"}` : "none"} (shown: ${r.lyrics})`,
    `Lyric offset: ${store.get("lyricOffset")}s`,
    "",
    "### Visualizer",
    `Mode: ${r.visualizer} · Quality: ${r.quality} · WebGL available: ${r.webgl} · Fullscreen open: ${r.immersive}`,
    `Audio capture: ${r.audioCapture ? "on" : "off"} · Source: ${r.audioSource} · Boost: ${r.boost} (×${r.gain.toFixed(1)}) · Level: ${Math.round(r.level * 100)}%`,
    "",
    "### Settings",
    `Theme: ${store.get("theme")} · Close to tray: ${store.get("closeToTray")} · Start with Windows: ${store.get("startWithWindows")}`,
    `Last.fm: ${store.get("sessionKey") ? "connected" : "not connected"} · Scrobbles: ${store.get("totalScrobbles")}`,
    `Discord: ${store.get("discordEnabled") ? "on" : "off"} · App: ${store.get("discordUseCustomId") ? `own (ID ${store.get("discordClientId") ? "set" : "missing"})` : "built-in"}`,
    `Hotkeys: ${store.get("hotkeys")} · Floating lyrics: ${store.get("floatingLyrics")} (locked ${store.get("floatingLocked")})`,
    "",
    `### Recent log (last ${LOG_LINES} lines)`,
    "```",
    ...m.logs.slice(-LOG_LINES),
    "```",
  ];
  return lines.join("\n");
}
