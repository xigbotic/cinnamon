import type { SearchResult } from "../../shared/types";
import { titleArtistMatch } from "./match";

const ENDPOINT = "https://itunes.apple.com/search";

/**
 * Catalog search via Apple's free iTunes Search API (no auth). Returns tracks
 * with their music.apple.com deep links and artwork.
 */
export async function searchCatalog(term: string): Promise<SearchResult[]> {
  const q = term.trim();
  if (!q) return [];

  const params = new URLSearchParams({
    term: q,
    entity: "song",
    limit: "25",
  });

  params.set("explicit", "Yes"); // ask Apple to include explicit results

  const res = await fetch(`${ENDPOINT}?${params.toString()}`);
  if (!res.ok) throw new Error(`search failed: ${res.status}`);
  const data = await res.json();

  const mapped: SearchResult[] = (data.results || [])
    .filter((r: any) => r.trackViewUrl)
    .map((r: any) => ({
      trackId: r.trackId,
      trackName: r.trackName,
      artistName: r.artistName,
      collectionName: r.collectionName || "",
      // Upgrade the 100px default to something crisp.
      artworkUrl: (r.artworkUrl100 || "").replace("100x100bb", "300x300bb"),
      trackViewUrl: r.trackViewUrl,
      explicit: r.trackExplicitness === "explicit",
    }));

  // Dedupe clean/explicit pairs of the same song, preferring the explicit cut.
  // (Apple's free API rarely returns explicit, but when it does we keep it.)
  const seen = new Map<string, number>(); // key -> index in `out`
  const out: SearchResult[] = [];
  for (const r of mapped) {
    const key = `${r.trackName.toLowerCase().trim()}|${r.artistName
      .toLowerCase()
      .trim()}`;
    const existing = seen.get(key);
    if (existing === undefined) {
      seen.set(key, out.length);
      out.push(r);
    } else if (r.explicit && !out[existing].explicit) {
      out[existing] = r; // replace clean with explicit, keeping position
    }
  }
  return out;
}

/** Best-effort catalog lookup for a now-playing track: cover URL + deep link. */
export async function lookupTrack(
  artist: string,
  track: string,
  album: string
): Promise<{ artworkUrl: string | null; trackViewUrl: string | null }> {
  const term = `${artist} ${track}`.trim();
  const miss = { artworkUrl: null, trackViewUrl: null };
  if (!term) return miss;
  try {
    // A wide result set matters: the right track is often not in the top few
    // (e.g. "Mac Miller Wings" surfaces features/other albums first).
    const params = new URLSearchParams({ term, entity: "song", limit: "25" });
    const res = await fetch(`${ENDPOINT}?${params.toString()}`);
    if (!res.ok) return miss;
    const data = await res.json();
    const results: any[] = data.results || [];
    // Only accept a hit that genuinely matches this track+artist.
    const valid = results.filter((r) =>
      titleArtistMatch(track, artist, r.trackName || "", r.artistName || "")
    );
    if (valid.length === 0) return miss;
    const hit =
      valid.find(
        (r) =>
          album &&
          (r.collectionName || "").toLowerCase() === album.toLowerCase()
      ) || valid[0];
    return {
      artworkUrl: hit.artworkUrl100
        ? hit.artworkUrl100.replace("100x100bb", "600x600bb")
        : null,
      trackViewUrl: hit.trackViewUrl || null,
    };
  } catch {
    return miss;
  }
}

/** Cover URL only (SMTC artwork fallback). */
export async function coverForTrack(
  artist: string,
  track: string,
  album: string
): Promise<string | null> {
  return (await lookupTrack(artist, track, album)).artworkUrl;
}
