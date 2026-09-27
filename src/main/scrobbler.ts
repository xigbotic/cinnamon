import { createHash } from "node:crypto";
import { config } from "./config";
import { store } from "./store";
import type { NowPlaying, ScrobbleStatus, TrackInfo } from "../../shared/types";

const API_ROOT = "https://ws.audioscrobbler.com/2.0/";
const AUTH_URL = "https://www.last.fm/api/auth/";

function md5(s: string): string {
  return createHash("md5").update(s, "utf-8").digest("hex");
}

/** Last.fm API client: signed calls, token/session auth, scrobble submission. */
class Lastfm {
  private key = config.lastfmApiKey;
  private secret = config.lastfmApiSecret;

  private sign(params: Record<string, string>): string {
    const sorted = Object.keys(params).sort();
    let s = "";
    for (const k of sorted) {
      if (k === "format" || k === "callback") continue;
      s += k + params[k];
    }
    return md5(s + this.secret);
  }

  private async call(
    params: Record<string, string>,
    method: "GET" | "POST"
  ): Promise<any> {
    const all = { ...params, api_key: this.key };
    const signed = { ...all, api_sig: this.sign(all), format: "json" };
    const body = new URLSearchParams(signed).toString();
    const url = method === "GET" ? `${API_ROOT}?${body}` : API_ROOT;
    const res = await fetch(url, {
      method,
      headers:
        method === "POST"
          ? { "Content-Type": "application/x-www-form-urlencoded" }
          : undefined,
      body: method === "POST" ? body : undefined,
    });
    return res.json();
  }

  /** Unauthenticated read call (user.getInfo, user.getTopArtists, ...). */
  async get(params: Record<string, string>): Promise<any> {
    const r = await this.call(params, "GET");
    if (r?.error) throw new Error(r.message || `Last.fm error ${r.error}`);
    return r;
  }

  get configured(): boolean {
    return Boolean(this.key && this.secret);
  }

  async getToken(): Promise<string> {
    const r = await this.call({ method: "auth.getToken" }, "GET");
    return r.token;
  }

  authUrl(token: string): string {
    return `${AUTH_URL}?api_key=${this.key}&token=${token}`;
  }

  async getSession(token: string): Promise<{ key: string; name: string }> {
    const r = await this.call({ method: "auth.getSession", token }, "GET");
    if (!r.session) throw new Error(r.message || "no session");
    return { key: r.session.key, name: r.session.name };
  }

  async updateNowPlaying(sk: string, np: NowPlaying) {
    await this.call(
      {
        method: "track.updateNowPlaying",
        artist: np.artist || "",
        track: np.track || "",
        album: np.album || "",
        sk,
      },
      "POST"
    );
  }

  /** The user's play count and loved flag for a track. */
  async trackInfo(username: string, artist: string, track: string) {
    const r = await this.call(
      { method: "track.getInfo", artist, track, username, autocorrect: "1" },
      "GET"
    );
    if (!r.track) return null;
    return {
      playcount: Number(r.track.userplaycount) || 0,
      loved: r.track.userloved === "1",
    };
  }

  async setLoved(sk: string, artist: string, track: string, loved: boolean) {
    const r = await this.call(
      { method: loved ? "track.love" : "track.unlove", artist, track, sk },
      "POST"
    );
    if (r.error) throw new Error(r.message || `Last.fm error ${r.error}`);
  }

  async scrobble(
    sk: string,
    d: { artist: string; track: string; album: string; timestamp: number }
  ) {
    await this.call(
      {
        method: "track.scrobble",
        artist: d.artist,
        track: d.track,
        album: d.album,
        timestamp: String(d.timestamp),
        sk,
      },
      "POST"
    );
  }
}

interface Pending {
  artist: string;
  track: string;
  album: string;
  timestamp: number;
  duration: number;
  elapsedMs: number;
}

/**
 * Consumes now-playing state and drives Last.fm. Qualification mirrors the
 * proven scrobbler: half the track (capped at 4 min), min 30s; radio (duration
 * 0) uses wall-clock elapsed since we can't trust its frozen position.
 */
export class Scrobbler {
  private lastfm = new Lastfm();
  private pending: Pending | null = null;
  private qualified = false;
  private lastTickMs = 0;
  private lastNowPlayingMs = 0;
  private pendingAuthToken: string | null = null;

  constructor(private emitStatus: (s: ScrobbleStatus) => void) {}

  status(): ScrobbleStatus {
    return {
      connected: Boolean(store.get("sessionKey")),
      username: store.get("username") || undefined,
      totalScrobbles: store.get("totalScrobbles"),
      qualified: this.qualified,
    };
  }

  private push() {
    this.emitStatus(this.status());
  }

  async connect(): Promise<{ authUrl: string }> {
    if (!this.lastfm.configured) throw new Error("Last.fm API keys not configured");
    this.pendingAuthToken = await this.lastfm.getToken();
    return { authUrl: this.lastfm.authUrl(this.pendingAuthToken) };
  }

  async complete(): Promise<boolean> {
    if (!this.pendingAuthToken) return false;
    try {
      const session = await this.lastfm.getSession(this.pendingAuthToken);
      store.set("sessionKey", session.key);
      store.set("username", session.name);
      this.pendingAuthToken = null;
      this.push();
      return true;
    } catch {
      return false;
    }
  }

  disconnect() {
    store.set("sessionKey", null);
    store.set("username", null);
    this.push();
  }

  /** Read-only Last.fm API access, for the stats page. */
  apiGet(params: Record<string, string>): Promise<any> {
    return this.lastfm.get(params);
  }

  /** Play count + loved state for the playing track, when connected. */
  async trackInfo(np: NowPlaying): Promise<TrackInfo | null> {
    const user = store.get("username");
    if (!user || !store.get("sessionKey") || !np.track || !np.artist) return null;
    try {
      const r = await this.lastfm.trackInfo(user, np.artist, np.track);
      return r ? { track: np.track, artist: np.artist, ...r } : null;
    } catch (e) {
      console.warn("[lastfm] track.getInfo failed", e);
      return null;
    }
  }

  async setLoved(np: NowPlaying, loved: boolean): Promise<void> {
    const sk = store.get("sessionKey");
    if (!sk || !np.track || !np.artist) throw new Error("Not connected to Last.fm");
    await this.lastfm.setLoved(sk, np.artist, np.track, loved);
    console.log(`[lastfm] ${loved ? "loved" : "unloved"}: ${np.track}`);
  }

  /** Fed once per sidecar state tick. */
  onState(state: NowPlaying) {
    const sk = store.get("sessionKey");
    const now = Date.now();

    if (!state.track) {
      if (this.pending && this.qualified && sk) this.submit(this.pending, sk);
      this.pending = null;
      this.qualified = false;
      this.lastTickMs = now;
      return;
    }

    const tickDelta = this.lastTickMs ? Math.min(5000, now - this.lastTickMs) : 0;
    this.lastTickMs = now;

    // New track?
    if (!this.pending || this.pending.track !== state.track) {
      if (this.pending && this.qualified && sk) this.submit(this.pending, sk);
      this.pending = {
        artist: state.artist || "",
        track: state.track,
        album: state.album || "",
        timestamp: Math.floor(now / 1000),
        duration: state.duration || 0,
        elapsedMs: 0,
      };
      this.qualified = false;
      this.lastNowPlayingMs = now;
      if (sk) this.lastfm.updateNowPlaying(sk, state).catch(() => {});
      this.push();
    }

    if (state.playing) this.pending.elapsedMs += tickDelta;

    const target =
      this.pending.duration > 0
        ? Math.min(this.pending.duration / 2, 240)
        : 30;
    const elapsedForQual =
      this.pending.duration > 0 && state.position
        ? state.position
        : this.pending.elapsedMs / 1000;

    if (!this.qualified && elapsedForQual >= target) {
      this.qualified = true;
      this.push();
    }

    // Re-ping now-playing every 2 minutes for long tracks.
    if (state.playing && sk && now - this.lastNowPlayingMs > 120_000) {
      this.lastNowPlayingMs = now;
      this.lastfm.updateNowPlaying(sk, state).catch(() => {});
    }
  }

  private async submit(p: Pending, sk: string) {
    try {
      await this.lastfm.scrobble(sk, {
        artist: p.artist,
        track: p.track,
        album: p.album,
        timestamp: p.timestamp,
      });
      store.set("totalScrobbles", store.get("totalScrobbles") + 1);
      console.log(`[scrobbler] scrobbled: ${p.track}`);
      this.push();
    } catch (e) {
      console.error("[scrobbler] submit error", e);
    }
  }
}
