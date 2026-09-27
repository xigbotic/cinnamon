import type { LyricLine, LyricWord } from "../../shared/types";

const LINE_STAMP = /\[(\d+):(\d+)(?:[.:](\d+))?\]/g;
const WORD_STAMP = /<(\d+):(\d+)(?:[.:](\d+))?>/g;

function seconds(min: string, sec: string, frac?: string): number {
  return parseInt(min, 10) * 60 + parseInt(sec, 10) + (frac ? parseFloat("0." + frac) : 0);
}

/**
 * Enhanced LRC puts a stamp before each word: "<00:12.34>Hey <00:12.80>there".
 * Returns the timed words, or undefined for an ordinary line.
 */
function parseWords(body: string): LyricWord[] | undefined {
  WORD_STAMP.lastIndex = 0;
  if (!WORD_STAMP.test(body)) return undefined;
  const words: LyricWord[] = [];
  const parts = body.split(WORD_STAMP);
  // split() with 3 capture groups yields: text, min, sec, frac, text, ...
  for (let i = 1; i + 3 < parts.length + 1; i += 4) {
    const text = (parts[i + 3] ?? "").replace(/\s+/g, " ");
    if (!text.trim()) continue;
    words.push({ time: seconds(parts[i], parts[i + 1], parts[i + 2]), text });
  }
  return words.length ? words : undefined;
}

/** Parse an LRC blob ("[mm:ss.xx] text") into timed lines. */
export function parseLrc(lrc: string): LyricLine[] {
  const lines: LyricLine[] = [];
  for (const raw of lrc.split(/\r?\n/)) {
    const stamps: number[] = [];
    let m: RegExpExecArray | null;
    LINE_STAMP.lastIndex = 0;
    while ((m = LINE_STAMP.exec(raw)) !== null) stamps.push(seconds(m[1], m[2], m[3]));
    const body = raw.replace(LINE_STAMP, "");
    const words = parseWords(body);
    const text = (words ? words.map((w) => w.text).join("") : body).trim();
    for (const t of stamps) lines.push(words ? { time: t, text, words } : { time: t, text });
  }
  return lines.sort((a, b) => a.time - b.time);
}

/** Parse a "m:ss" / "h:mm:ss" duration string into seconds. */
export function parseDuration(s: string): number | null {
  const parts = (s || "").trim().split(":").map((p) => parseInt(p, 10));
  if (parts.some(isNaN) || parts.length < 2) return null;
  return parts.length === 3
    ? parts[0] * 3600 + parts[1] * 60 + parts[2]
    : parts[0] * 60 + parts[1];
}
