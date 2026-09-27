import type { StatsOverview, StatsPeriod, StatsTop } from "../../shared/types";

type Get = (params: Record<string, string>) => Promise<any>;

const DAYS = 30;
/** Pages of 200 scrobbles fetched for the 30-day chart (2,000 plays). */
const MAX_PAGES = 10;
const OVERVIEW_TTL = 5 * 60_000;
const TOP_TTL = 10 * 60_000;
/** Last.fm's grey-star placeholder, served when an album has no art. */
const PLACEHOLDER = "2a96cbd8b46e442fc41c2b86b821562f";

/** Local calendar day, "YYYY-MM-DD". */
function dayKey(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Last.fm answers bursts with a generic "Operation failed" (error 8/16/29),
 * so read calls retry a couple of times with a short backoff.
 */
function withRetry(get: Get): Get {
  return async (params) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await get(params);
      } catch (e) {
        if (attempt >= 2) throw e;
        await sleep(500 * (attempt + 1));
      }
    }
  };
}

const asArray = <T>(x: T | T[] | undefined): T[] => (Array.isArray(x) ? x : x ? [x] : []);
const secs = (d: Date) => String(Math.floor(d.getTime() / 1000));

/** Every scrobble between two times (up to MAX_PAGES pages), newest first. */
async function scrobbles(get: Get, user: string, from: Date, to: Date) {
  const page = (n: number) =>
    get({ method: "user.getRecentTracks", user, from: secs(from), to: secs(to), limit: "200", page: String(n) });
  const first = await page(1);
  const pages = Number(first?.recenttracks?.["@attr"]?.totalPages) || 1;
  // Two at a time: firing every page at once is what trips Last.fm's limits.
  const rest: any[] = [];
  for (let n = 2; n <= Math.min(pages, MAX_PAGES); n += 2) {
    const batch = [page(n)];
    if (n + 1 <= Math.min(pages, MAX_PAGES)) batch.push(page(n + 1));
    rest.push(...(await Promise.all(batch)));
  }
  const tracks = [first, ...rest].flatMap((r) => asArray(r?.recenttracks?.track));
  // The "now playing" entry has no date and isn't a scrobble yet.
  return {
    list: tracks
      .filter((t: any) => t?.date?.uts)
      .map((t: any) => ({
        uts: Number(t.date.uts),
        name: String(t.name ?? ""),
        artist: String(t.artist?.["#text"] ?? t.artist?.name ?? ""),
      })),
    partial: pages > MAX_PAGES,
  };
}

/** Last.fm listening stats, cached briefly so flipping tabs is instant. */
export class Stats {
  private overviewCache: { user: string; at: number; data: StatsOverview } | null = null;
  private topCache = new Map<string, { at: number; data: StatsTop }>();

  private get: Get;

  constructor(get: Get) {
    this.get = withRetry(get);
  }

  clear() {
    this.overviewCache = null;
    this.topCache.clear();
  }

  async overview(user: string, force = false): Promise<StatsOverview> {
    const c = this.overviewCache;
    if (!force && c && c.user === user && Date.now() - c.at < OVERVIEW_TTL) return c.data;

    const now = new Date();
    const today = startOfDay(now);
    const from = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (DAYS - 1));
    const yearAgo = new Date(today.getFullYear() - 1, today.getMonth(), today.getDate());
    const yearAgoEnd = new Date(yearAgo.getFullYear(), yearAgo.getMonth(), yearAgo.getDate() + 1);

    const info = await this.get({ method: "user.getInfo", user });
    const recent = await scrobbles(this.get, user, from, now);
    const past = await scrobbles(this.get, user, yearAgo, yearAgoEnd);

    // Plays per local day, oldest first.
    const counts = new Map<string, number>();
    for (const s of recent.list) {
      const k = dayKey(new Date(s.uts * 1000));
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const days = Array.from({ length: DAYS }, (_, i) => {
      const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + i);
      return { date: dayKey(d), plays: counts.get(dayKey(d)) ?? 0 };
    });

    // Streak: consecutive days with a play, ending today (or yesterday, so the
    // streak doesn't read 0 every morning before the first song).
    let i = days.length - 1;
    if (days[i].plays === 0) i--;
    let streak = 0;
    for (; i >= 0 && days[i].plays > 0; i--) streak++;

    // On this day, one year ago: the most-played tracks.
    const byTrack = new Map<string, { name: string; artist: string; plays: number }>();
    for (const s of past.list) {
      const k = `${s.artist}\u0000${s.name}`;
      const e = byTrack.get(k) ?? { name: s.name, artist: s.artist, plays: 0 };
      e.plays++;
      byTrack.set(k, e);
    }

    const data: StatsOverview = {
      user,
      total: Number(info?.user?.playcount) || 0,
      registered: Number(info?.user?.registered?.unixtime) || 0,
      today: days[days.length - 1].plays,
      streak,
      streakCapped: streak >= DAYS,
      days,
      partial: recent.partial,
      onThisDay: {
        year: yearAgo.getFullYear(),
        total: past.list.length,
        tracks: [...byTrack.values()].sort((a, b) => b.plays - a.plays).slice(0, 5),
      },
    };
    this.overviewCache = { user, at: Date.now(), data };
    return data;
  }

  async top(user: string, period: StatsPeriod, force = false): Promise<StatsTop> {
    const key = `${user}|${period}`;
    const c = this.topCache.get(key);
    if (!force && c && Date.now() - c.at < TOP_TTL) return c.data;

    const [artists, tracks, albums] = await Promise.all([
      this.get({ method: "user.getTopArtists", user, period, limit: "8" }),
      this.get({ method: "user.getTopTracks", user, period, limit: "8" }),
      this.get({ method: "user.getTopAlbums", user, period, limit: "6" }),
    ]);
    const image = (imgs: any): string => {
      const list = asArray<any>(imgs);
      const url = String((list.find((i) => i.size === "extralarge") ?? list[list.length - 1])?.["#text"] ?? "");
      return url.includes(PLACEHOLDER) ? "" : url;
    };
    const data: StatsTop = {
      artists: asArray<any>(artists?.topartists?.artist).map((a) => ({
        name: String(a.name),
        plays: Number(a.playcount) || 0,
      })),
      tracks: asArray<any>(tracks?.toptracks?.track).map((t) => ({
        name: String(t.name),
        artist: String(t.artist?.name ?? ""),
        plays: Number(t.playcount) || 0,
      })),
      albums: asArray<any>(albums?.topalbums?.album).map((a) => ({
        name: String(a.name),
        artist: String(a.artist?.name ?? ""),
        plays: Number(a.playcount) || 0,
        image: image(a.image),
      })),
    };
    this.topCache.set(key, { at: Date.now(), data });
    return data;
  }
}
