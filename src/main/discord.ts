import { Client } from "@xhayper/discord-rpc";
import type { NowPlaying, DiscordConfig } from "../../shared/types";

/** Cinnamon's own Discord application; users can swap in theirs in settings. */
export const DEFAULT_DISCORD_APP_ID = "1551382879139799250";

export interface PresenceExtras {
  artUrl?: string;
  trackUrl?: string;
  config: DiscordConfig;
}

/**
 * Discord Rich Presence with auto-reconnect. Shows the current track with
 * user-customizable templated text and toggles. Requires a Discord application
 * client ID and the Discord desktop app running locally. Survives Discord
 * restarts by reconnecting and re-applying the last presence.
 */
export class DiscordPresence {
  private client: Client | null = null;
  private clientId = "";
  private enabled = false;
  private ready = false;
  private connecting = false;
  private last: { state: NowPlaying; extras: PresenceExtras } | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private healthTimer: NodeJS.Timeout | null = null;

  async enable(clientId: string) {
    if (!clientId) return;
    this.enabled = true;
    this.clientId = clientId;
    await this.connect();
    // Safety net: if Discord starts later or a disconnect is missed, retry.
    if (!this.healthTimer) {
      this.healthTimer = setInterval(() => {
        if (this.enabled && !this.ready && !this.connecting) this.connect();
      }, 15000);
    }
  }

  private async connect() {
    if (!this.enabled || !this.clientId || this.connecting) return;
    this.connecting = true;
    try {
      await this.destroyClient();
      this.client = new Client({ clientId: this.clientId });
      this.client.on("ready", () => {
        this.ready = true;
        if (this.last) this.apply(this.last.state, this.last.extras);
      });
      this.client.on("disconnected", () => {
        this.ready = false;
        this.scheduleReconnect();
      });
      await this.client.login();
    } catch (e) {
      console.log(`[discord] connect failed (is Discord running?): ${e}`);
      this.ready = false;
      this.scheduleReconnect();
    } finally {
      this.connecting = false;
    }
  }

  private scheduleReconnect() {
    if (!this.enabled || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, 8000);
  }

  private async destroyClient() {
    if (this.client) {
      try {
        await this.client.destroy();
      } catch {
        /* ignore */
      }
      this.client = null;
    }
    this.ready = false;
  }

  async disable() {
    this.enabled = false;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
    if (this.client) {
      try {
        await this.client.user?.clearActivity();
      } catch {
        /* ignore */
      }
    }
    await this.destroyClient();
  }

  /** Called from the app on state changes; always remembers the latest. */
  update(state: NowPlaying, extras: PresenceExtras) {
    this.last = { state, extras };
    this.apply(state, extras);
  }

  private apply(state: NowPlaying, extras: PresenceExtras) {
    if (!this.client || !this.ready) return;
    const { config } = extras;
    try {
      if (!state.track || (!state.playing && !config.showPaused)) {
        // Can reject if the connection is closing; the next connect resets it.
        this.client.user?.clearActivity().catch(() => {});
        return;
      }

      const paused = !state.playing;
      const detail = render(config.detail, state);
      let stateLine = render(config.state, state);
      // When paused, show a "Paused" marker instead of a running counter.
      if (paused) stateLine = stateLine ? `${stateLine} • Paused` : "Paused";

      const activity: any = {
        type: 2, // Listening
        name: render(config.name, state) || "Cinnamon", // the "Listening to X" text
        details: fit(detail || state.track),
        state: stateLine ? fit(stateLine) : undefined,
        instance: false,
      };

      if (config.showArt) {
        activity.largeImageKey = extras.artUrl || "cinnamon";
        activity.largeImageText = fit(state.album || "Cinnamon");
      }

      // Only show the live counter while actually playing.
      if (config.showProgress && !paused && state.duration && state.duration > 0) {
        const start = Date.now() - (state.position ?? 0) * 1000;
        activity.startTimestamp = Math.floor(start / 1000);
        activity.endTimestamp = Math.floor((start + state.duration * 1000) / 1000);
      }

      if (config.showButton && extras.trackUrl) {
        activity.buttons = [{ label: "Play on Apple Music", url: extras.trackUrl }];
      }

      // Async: a rejected payload would otherwise be an unhandled rejection.
      // It's a content problem, not a connection one, so just log it.
      this.client.user?.setActivity(activity).catch((e: unknown) => {
        console.log(`[discord] presence rejected: ${e}`);
      });
    } catch (e) {
      console.log(`[discord] setActivity error: ${e}`);
      this.ready = false; // trigger reconnect path
      this.scheduleReconnect();
    }
  }
}

/** Replace {track} {artist} {album} {player} tokens in a template. */
function render(template: string, state: NowPlaying): string {
  return (template || "")
    .replace(/\{track\}/g, state.track || "")
    .replace(/\{artist\}/g, state.artist || "")
    .replace(/\{album\}/g, state.album || "")
    .replace(/\{player\}/g, "Apple Music")
    .trim();
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/**
 * Discord rejects the whole presence if any text is under 2 or over 128
 * characters, so a one-letter title ("X") would blank the status. Pad short
 * text with U+2800, an invisible character Discord doesn't trim.
 */
const BLANK = String.fromCharCode(0x2800); // braille blank: invisible, not trimmed

function fit(s: string): string {
  const t = truncate(s, 128);
  return t.length >= 2 ? t : (t + BLANK + BLANK).slice(0, 2);
}
