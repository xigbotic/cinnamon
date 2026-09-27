import "./lyrics.css";
import type { CinnamonApi, Lyrics, NowPlaying } from "../../../shared/types";
import { lineWords, buildWordSpans, paintWords, type WordTiming } from "./karaoke";

declare global {
  interface Window {
    cinnamon: CinnamonApi;
  }
}

// Same universal lead as the main lyrics view (LRCLIB runs ~1s behind Apple's
// masters); the user's offset stacks on top.
const BASE_LYRIC_LEAD = 1.0;

const currentEl = document.getElementById("current")!;
const nextEl = document.getElementById("next")!;
const body = document.body;

let lyrics: Lyrics | null = null;
let offset = 0;
let track: string | null = null;
let artist = "";
let duration = 0;
let playing = false;
let basePos = 0;
let basePosAt = 0;
let shownIdx = -2; // -2 = nothing rendered yet
let karaoke = true;
let words: WordTiming[] = [];
let spans: HTMLElement[] = [];

function estimate(): number {
  let est = basePos + (playing ? (Date.now() - basePosAt) / 1000 : 0);
  if (duration > 0) est = Math.min(est, duration);
  return est;
}

function setLine(el: HTMLElement, text: string, animate: boolean) {
  if (el.textContent === text) return;
  el.textContent = text;
  if (animate) {
    el.classList.remove("enter");
    void el.offsetWidth; // restart the animation
    el.classList.add("enter");
  }
}

/** Title fallback when there's nothing synced to show. */
function showTitle() {
  shownIdx = -2;
  words = [];
  spans = [];
  currentEl.classList.remove("karaoke");
  setLine(currentEl, track ? `♪ ${track}` : "", false);
  setLine(nextEl, track ? artist : "", false);
}

function tick() {
  body.classList.toggle("idle", !track);
  body.classList.toggle("paused", !!track && !playing);
  if (!track || !lyrics || !lyrics.synced || lyrics.lines.length === 0) {
    showTitle();
    return;
  }
  const p = estimate() + offset + BASE_LYRIC_LEAD;
  let idx = -1;
  for (let i = 0; i < lyrics.lines.length; i++) {
    if (lyrics.lines[i].time <= p) idx = i;
    else break;
  }
  if (idx === shownIdx) return;
  shownIdx = idx;
  const line = (i: number) => (i >= 0 && i < lyrics!.lines.length ? lyrics!.lines[i].text || "♪" : "");
  // Before the first line, preview it rather than showing an empty strip.
  currentEl.classList.remove("karaoke");
  currentEl.textContent = "";
  setLine(currentEl, idx >= 0 ? line(idx) : "♪", true);
  setLine(nextEl, line(idx + 1), true);
  words = karaoke && idx >= 0 ? lineWords(lyrics, idx) : [];
  spans = words.length ? buildWordSpans(currentEl, words) : [];
}

function karaokeFrame() {
  requestAnimationFrame(karaokeFrame);
  if (spans.length) paintWords(spans, words, estimate() + offset + BASE_LYRIC_LEAD);
}
requestAnimationFrame(karaokeFrame);

window.cinnamon.onState((s: NowPlaying) => {
  const incoming = s.position ?? 0;
  const prev = estimate();
  const changed = s.track !== track;
  const wasPlaying = playing;
  track = s.track;
  artist = s.artist ?? "";
  duration = s.duration ?? 0;
  playing = s.playing;
  // Whole-second SMTC ticks can land behind the interpolated clock; only let it
  // go backwards for a real seek, resume or track change.
  basePos =
    changed || !wasPlaying || Math.abs(incoming - prev) > 2.5 ? incoming : Math.max(incoming, prev);
  basePosAt = Date.now();
  if (changed) shownIdx = -2;
});

window.cinnamon.onLyrics((l) => {
  // Lyrics can arrive for the previous track while a new one starts.
  lyrics = l && (!track || l.track === track) ? l : null;
  shownIdx = -2;
});

window.cinnamon.onLyricOffset((v) => {
  offset = v;
  shownIdx = -2;
});

window.cinnamon.onPrefs((p) => {
  body.classList.remove("size-s", "size-m", "size-l");
  body.classList.add(`size-${p.floatingSize}`);
  body.classList.toggle("locked", p.floatingLocked);
  body.classList.toggle("unlocked", !p.floatingLocked);
  if (p.karaoke !== karaoke) {
    karaoke = p.karaoke;
    shownIdx = -2; // redraw the current line with or without word spans
  }
});

setInterval(tick, 100);
