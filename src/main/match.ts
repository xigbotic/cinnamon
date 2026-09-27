// Shared fuzzy-matching used to reject wrong catalog/lyrics hits for a track.

/** Normalize a title/artist for loose comparison (drop punctuation, brackets). */
export function norm(s: string): string {
  return (s || "")
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, "") // drop "(feat. X)", "[Remix]" etc.
    .replace(/feat\.?.*$/, "")
    .replace(/&/g, "and") // so "Armed & Dangerous" matches "Armed And Dangerous"
    .replace(/[^a-z0-9]/g, "");
}

/** Parentheticals that describe a version rather than name the song. */
const QUALIFIER =
  /^(feat|ft|with|prod|remaster|remix|version|edit|explicit|clean|live|bonus|deluxe|demo|acoustic|original|radio|extended|sped|slowed|mono|stereo|v\d|\d{4})/;

/**
 * Alternate-title parentheticals, normalized: "Tick-Tock (In The Air)" →
 * ["intheair"]. `norm` drops these, but for unreleased songs they're often the
 * only thing telling two same-named songs apart. "(feat. X)", "(Remastered)"
 * etc. are skipped since they don't identify a different song.
 */
export function aliases(s: string): string[] {
  const out: string[] = [];
  for (const m of (s || "").matchAll(/\((.*?)\)|\[(.*?)\]/g)) {
    const inner = (m[1] ?? m[2] ?? "").trim().toLowerCase();
    if (!inner || QUALIFIER.test(inner)) continue;
    const n = norm(inner);
    if (n) out.push(n);
  }
  return out;
}

/** Both titles carry alias parentheticals and none of them agree. */
export function aliasConflict(a: string, b: string): boolean {
  const aa = aliases(a);
  const ab = aliases(b);
  return aa.length > 0 && ab.length > 0 && !aa.some((x) => ab.includes(x));
}

export function looseMatch(a: string, b: string): boolean {
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  // Substring matching only when both are long enough; otherwise short names
  // like "db" wrongly match "dbking".
  const minLen = Math.min(na.length, nb.length);
  return minLen >= 5 && (na.includes(nb) || nb.includes(na));
}

/** Both title and artist must loosely match. */
export function titleArtistMatch(
  track: string,
  artist: string,
  candTrack: string,
  candArtist: string
): boolean {
  return (
    looseMatch(track, candTrack) &&
    !aliasConflict(track, candTrack) &&
    looseMatch(artist, candArtist)
  );
}
