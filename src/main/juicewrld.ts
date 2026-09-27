import type { Lyrics, NowPlaying } from "../../shared/types";
import { aliases, norm } from "./match";
import { parseLrc, parseDuration } from "./lrc";

const API = "https://juicewrldapi.com/juicewrld/songs/";
const COVER_ART = "https://juicewrldapi.com/juicewrld/files/cover-art/";
/** Detail requests per track change: enough to reach sparse synced entries. */
const MAX_PROBES = 8;

/**
 * Provider backed by the community Juice WRLD API. Valuable for local /
 * unreleased tracks that public services never carry: LRCLIB has no lyrics for
 * them, and the iTunes catalog has no cover art.
 *
 * Note: the list endpoint omits `synced_lyrics`; only the detail endpoint
 * (/songs/{id}/) populates it, and coverage is partial, so we probe the best
 * few candidates and prefer whichever actually has timed lyrics.
 */

export function isJuiceWrld(artist: string): boolean {
  const a = norm(artist);
  return a.includes("juicewrld") || a.includes("juicethekidd");
}

interface Candidate {
  id: number;
  name: string;
  titles: string[];
  length: string;
  category: string;
  path: string;
}

/** How well a candidate's title matches: 0 = exact name, 1 = exact alternate. */
function matchTier(track: string, c: Candidate): number | null {
  const t = norm(track);
  if (!t) return null;
  if (norm(c.name) === t) return 0;
  if (c.titles.some((x) => norm(x) === t)) return 1;
  // Deliberately no substring matching: "On My Mind" would otherwise match the
  // alternate title "Only You On My Mind", which is a different song.
  return null;
}

/**
 * Versions of a song differ in length, and unrelated songs almost always do.
 * When both lengths are known they must agree, so we never serve another
 * track's lyrics just because its title overlapped.
 */
function durationOk(np: NowPlaying, c: Candidate): boolean {
  const target = np.duration && np.duration > 0 ? np.duration : null;
  const len = parseDuration(c.length);
  if (target == null || len == null) return true; // nothing to compare
  return Math.abs(len - target) <= 10;
}

/** Progressively looser search terms for the API's fussy search endpoint. */
function searchTerms(track: string): string[] {
  const terms: string[] = [track];
  if (/&/.test(track)) terms.push(track.replace(/&/g, "and"));
  const bare = track.replace(/\(.*?\)|\[.*?\]/g, "").trim();
  if (bare && bare !== track) terms.push(bare);
  // Leading words survive when the full title doesn't match the API's index.
  const words = bare.split(/\s+/).filter(Boolean);
  if (words.length > 1) terms.push(words.slice(0, 2).join(" "));
  if (words.length > 0) terms.push(words[0]);
  return [...new Set(terms)].filter((t) => t.length >= 2);
}

async function searchCandidates(term: string): Promise<Candidate[]> {
  try {
    const params = new URLSearchParams({ search: term, page_size: "20" });
    const res = await fetch(`${API}?${params.toString()}`);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.results || []).map((r: any) => ({
      id: r.id,
      name: r.name || "",
      titles: Array.isArray(r.track_titles) ? r.track_titles : [],
      length: r.length || "",
      category: r.category || "",
      path: r.path || "",
    }));
  } catch {
    return [];
  }
}

// Lyrics and cover art both resolve the same track; cache the last lookup so a
// track change only costs one search.
let cacheKey = "";
let cacheValue: Candidate[] = [];

/** Search + title-match + rank the API entries for the playing track. */
async function findMatches(np: NowPlaying): Promise<Candidate[]> {
  if (!np.track) return [];
  // Aliases are part of the key: norm() drops them, and they pick the song.
  const key = `${norm(np.artist || "")}|${norm(np.track)}|${aliases(np.track).join(",")}|${np.duration ?? 0}`;
  if (key === cacheKey) return cacheValue;

  let matches: Candidate[] = [];
  for (const term of searchTerms(np.track)) {
    const candidates = await searchCandidates(term);
    matches = candidates.filter(
      (c) => matchTier(np.track!, c) !== null && durationOk(np, c)
    );
    if (matches.length) break;
  }

  // Same-named songs ("Tick-Tock" is both "In The Air" and "No Time") are told
  // apart by the alias in the playing title. When any entry lists it, only those
  // entries are the song. Duration alone can't decide if it isn't known yet.
  const want = aliases(np.track);
  if (want.length) {
    const named = matches.filter((c) =>
      [c.name, ...c.titles].some(
        (t) => want.includes(norm(t)) || aliases(t).some((a) => want.includes(a))
      )
    );
    if (named.length) matches = named;
  }

  // Rank: exact-name matches first, then closest duration, then released.
  const target = np.duration && np.duration > 0 ? np.duration : null;
  matches.sort((a, b) => {
    const tierA = matchTier(np.track!, a) ?? 9;
    const tierB = matchTier(np.track!, b) ?? 9;
    if (tierA !== tierB) return tierA - tierB;
    if (target) {
      const da = parseDuration(a.length);
      const db = parseDuration(b.length);
      const diffA = da == null ? 9999 : Math.abs(da - target);
      const diffB = db == null ? 9999 : Math.abs(db - target);
      if (diffA !== diffB) return diffA - diffB;
    }
    const rank = (c: Candidate) => (c.category === "released" ? 0 : 1);
    return rank(a) - rank(b);
  });

  cacheKey = key;
  cacheValue = matches;
  return matches;
}

/**
 * Public cover-art URL for the playing track. This is the piece that makes
 * local/unreleased covers work on Discord: Discord fetches presence images
 * server-side, so it needs a reachable URL rather than the local image bytes.
 */
export async function juiceWrldCoverUrl(np: NowPlaying): Promise<string | null> {
  const matches = await findMatches(np);
  const hit = matches.find((c) => c.path);
  if (!hit) return null;
  return `${COVER_ART}?${new URLSearchParams({ path: hit.path }).toString()}`;
}

export async function fetchJuiceWrldLyrics(
  np: NowPlaying
): Promise<Lyrics | null> {
  const matches = await findMatches(np);
  if (matches.length === 0) return null;

  // Synced coverage is sparse and scattered across versions (a song's synced
  // copy may be its 5th entry), so probe every ranked match up to a cap, in
  // parallel, then take the best-ranked one that actually has timed lyrics.
  const details = await Promise.all(
    matches.slice(0, MAX_PROBES).map(async (c) => {
      try {
        const res = await fetch(`${API}${c.id}/`);
        return res.ok ? await res.json() : null;
      } catch {
        return null;
      }
    })
  );

  for (const d of details) {
    const synced: string = d?.synced_lyrics || "";
    if (!synced.trim()) continue;
    const lines = parseLrc(synced);
    if (lines.length) return { track: np.track!, synced: true, lines, source: "juicewrld" };
  }

  for (const d of details) {
    const plain: string = d?.lyrics || "";
    if (plain.trim()) {
      return {
        track: np.track!,
        synced: false,
        lines: plain.split(/\r?\n/).map((text: string) => ({ time: 0, text })),
        plain,
        source: "juicewrld",
      };
    }
  }
  return null;
}
