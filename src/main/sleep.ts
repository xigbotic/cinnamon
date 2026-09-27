import type { NowPlaying, SleepStatus } from "../../shared/types";

/**
 * Pauses playback after a delay or at the end of the current track. Lives in
 * the main process so it keeps working while the window is hidden in the tray.
 */
export class SleepTimer {
  private timer: NodeJS.Timeout | null = null;
  private endsAt = 0;
  private trackEnd: string | null = null; // track to finish, for "end of track"

  constructor(
    private pause: () => void,
    private emit: (s: SleepStatus) => void,
    private current: () => NowPlaying | null
  ) {}

  get status(): SleepStatus {
    if (this.trackEnd !== null) return { endOfTrack: true };
    if (this.timer) return { endsAt: this.endsAt };
    return {};
  }

  set(minutes: number | "track" | null) {
    this.clear();
    if (minutes === "track") {
      this.trackEnd = this.current()?.track ?? null;
      if (this.trackEnd === null) return this.emit(this.status); // nothing playing
    } else if (typeof minutes === "number" && minutes > 0) {
      this.endsAt = Date.now() + minutes * 60_000;
      this.timer = setTimeout(() => this.fire(), minutes * 60_000);
    }
    console.log(`[sleep] ${minutes === null ? "off" : minutes === "track" ? "end of track" : `${minutes} min`}`);
    this.emit(this.status);
  }

  /** Fed every now-playing tick; handles the "end of track" mode. */
  onState(s: NowPlaying) {
    if (this.trackEnd === null) return;
    const changed = s.track !== this.trackEnd;
    // Ticks arrive about once a second, so stop just short of the end rather
    // than letting the next track start.
    const nearEnd = !!s.duration && s.duration > 0 && (s.position ?? 0) >= s.duration - 1.2;
    if (changed || nearEnd) this.fire();
  }

  private fire() {
    console.log("[sleep] pausing playback");
    this.pause();
    this.clear();
    this.emit(this.status);
  }

  private clear() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.endsAt = 0;
    this.trackEnd = null;
  }
}
