import type { Lyrics } from "../../../shared/types";

export interface WordTiming {
  text: string;
  start: number;
  end: number;
}

/** Roughly rap-verse pace; slower singing just finishes early in the gap. */
const SECONDS_PER_CHAR = 0.065;
/** When a line is the last one, assume this long before the song moves on. */
const LAST_LINE_GAP = 4;

/**
 * Word timings for a line. Uses the source's own per-word stamps when it has
 * them; otherwise spreads the line across its words by length (longer words
 * take longer), finishing a little before the next line starts.
 */
export function lineWords(lyrics: Lyrics, idx: number): WordTiming[] {
  const line = lyrics.lines[idx];
  if (!line) return [];
  const nextTime = lyrics.lines[idx + 1]?.time ?? line.time + LAST_LINE_GAP;
  const gap = Math.max(0.3, nextTime - line.time);

  if (line.words?.length) {
    return line.words.map((w, i) => {
      const next = line.words![i + 1]?.time;
      const end = next ?? Math.min(nextTime, w.time + Math.max(0.3, w.text.length * SECONDS_PER_CHAR * 1.5));
      return { text: w.text, start: w.time, end: Math.max(end, w.time + 0.05) };
    });
  }

  // Keep each word's trailing space with it so the spans re-join exactly.
  const tokens = line.text.match(/\S+\s*/g) ?? [];
  if (tokens.length === 0) return [];
  const weights = tokens.map((t) => t.trim().replace(/[^\p{L}\p{N}]/gu, "").length + 1);
  const total = weights.reduce((a, b) => a + b, 0);
  const sung = Math.min(gap * 0.9, Math.max(0.6, total * SECONDS_PER_CHAR));
  let t = line.time;
  return tokens.map((text, i) => {
    const d = (weights[i] / total) * sung;
    const w = { text, start: t, end: t + d };
    t += d;
    return w;
  });
}

/** Replaces an element's text with one span per word; returns the spans. */
export function buildWordSpans(el: HTMLElement, words: WordTiming[]): HTMLElement[] {
  el.textContent = "";
  el.classList.add("karaoke");
  return words.map((w) => {
    const span = document.createElement("span");
    span.className = "kw";
    span.textContent = w.text;
    el.appendChild(span);
    return span;
  });
}

/** Undo buildWordSpans, back to plain text. */
export function clearWordSpans(el: HTMLElement, text: string) {
  if (!el.classList.contains("karaoke")) return;
  el.classList.remove("karaoke");
  el.textContent = text;
}

/** Sets each word's fill (the --p custom property, 0..1) for position `pos`. */
export function paintWords(spans: HTMLElement[], words: WordTiming[], pos: number) {
  for (let i = 0; i < spans.length; i++) {
    const w = words[i];
    if (!w) continue;
    const p = Math.max(0, Math.min(1, (pos - w.start) / (w.end - w.start)));
    const v = p.toFixed(3);
    if (spans[i].dataset.p !== v) {
      spans[i].dataset.p = v;
      spans[i].style.setProperty("--p", v);
    }
  }
}
