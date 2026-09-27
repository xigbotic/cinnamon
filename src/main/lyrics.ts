import type { Lyrics, NowPlaying } from "../../shared/types";
import { titleArtistMatch } from "./match";
import { parseLrc } from "./lrc";
import { isJuiceWrld, fetchJuiceWrldLyrics } from "./juicewrld";

const ENDPOINT = "https://lrclib.net/api/get";
const SEARCH = "https://lrclib.net/api/search";
const UA = "Cinnamon (https://github.com/xigbotic/cinnamon)";

/** Does a LRCLIB candidate actually correspond to the track we're playing? */
function candidateMatches(np: NowPlaying, cand: any): boolean {
  if (
    !titleArtistMatch(
      np.track || "",
      np.artist || "",
      cand.trackName || cand.name || "",
      cand.artistName || ""
    )
  ) {
    return false;
  }
  if (np.duration && np.duration > 0 && cand.duration) {
    if (Math.abs(np.duration - cand.duration) > 8) return false; // wrong version
  }
  return true;
}

function toLyrics(track: string, data: any): Lyrics | null {
  if (!data || data.instrumental) return null;
  if (data.syncedLyrics) {
    return { track, synced: true, lines: parseLrc(data.syncedLyrics), source: "lrclib" };
  }
  if (data.plainLyrics) {
    return {
      track,
      synced: false,
      lines: data.plainLyrics
        .split(/\r?\n/)
        .map((text: string) => ({ time: 0, text })),
      plain: data.plainLyrics,
      source: "lrclib",
    };
  }
  return null;
}

/**
 * Synced lyrics are always preferred over plain ones. Each provider is asked
 * in turn; the first *synced* result wins, and a plain result is only kept as
 * a fallback. Returning the first hit of any kind meant a plain-only entry could
 * shadow synced lyrics that another source had.
 */
export async function fetchLyrics(np: NowPlaying): Promise<Lyrics | null> {
  if (!np.track || !np.artist) return null;
  let plainFallback: Lyrics | null = null;

  // Juice WRLD tracks (incl. local/unreleased files) go to the dedicated API
  // first, since LRCLIB has no coverage for unreleased material. Its plain lyrics
  // are the better fallback for those, so they're kept ahead of LRCLIB's.
  if (isJuiceWrld(np.artist)) {
    try {
      const hit = await fetchJuiceWrldLyrics(np);
      if (hit?.synced) return hit;
      plainFallback = hit;
    } catch {
      /* fall through to LRCLIB */
    }
  }

  const lr = await fetchLrclib(np);
  if (lr?.synced) return lr;
  return plainFallback ?? lr;
}

async function fetchLrclib(np: NowPlaying): Promise<Lyrics | null> {
  const headers = { "User-Agent": UA };
  let plain: Lyrics | null = null;

  // Exact match first.
  try {
    const params = new URLSearchParams({
      artist_name: np.artist!, // guaranteed by fetchLyrics
      track_name: np.track!,
    });
    if (np.album) params.set("album_name", np.album);
    if (np.duration && np.duration > 0)
      params.set("duration", String(Math.round(np.duration)));

    const res = await fetch(`${ENDPOINT}?${params.toString()}`, { headers });
    if (res.ok) {
      const data = await res.json();
      // The exact endpoint is keyed on our params, but verify anyway.
      if (candidateMatches(np, data)) {
        const hit = toLyrics(np.track!, data);
        if (hit?.synced) return hit;
        plain = hit; // plain-only record: keep looking for a synced one
      }
    }
  } catch {
    /* fall through to search */
  }

  // Fuzzy fallback, but only accept a candidate that actually matches the
  // playing track, preferring synced lyrics and the closest duration.
  try {
    const params = new URLSearchParams({ q: `${np.artist} ${np.track}` });
    const res = await fetch(`${SEARCH}?${params.toString()}`, { headers });
    if (res.ok) {
      const arr = await res.json();
      if (Array.isArray(arr)) {
        const candidates = arr
          .filter((c) => candidateMatches(np, c))
          .sort((a, b) => {
            // Prefer synced, then closest duration.
            const synced = Number(!!b.syncedLyrics) - Number(!!a.syncedLyrics);
            if (synced !== 0) return synced;
            if (np.duration && np.duration > 0) {
              return (
                Math.abs((a.duration || 0) - np.duration) -
                Math.abs((b.duration || 0) - np.duration)
              );
            }
            return 0;
          });
        if (candidates.length) {
          const hit = toLyrics(np.track!, candidates[0]);
          if (hit?.synced || !plain) return hit;
        }
      }
    }
  } catch {
    /* no lyrics */
  }

  return plain;
}
