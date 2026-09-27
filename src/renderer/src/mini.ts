import "./mini.css";
import { isDynamic, extractAccent } from "./themes";
import type { NowPlaying, Artwork, CinnamonApi } from "../../../shared/types";

declare global {
  interface Window {
    cinnamon: CinnamonApi;
  }
}

const $ = (id: string) => document.getElementById(id)!;
const coverEl = $("miniCover");
const ambientEl = $("miniAmbient");
const trackEl = $("miniTrack");
const artistEl = $("miniArtist");
const progressEl = $("miniProgress");
const progressWrap = $("miniProgressWrap");

const ICONS = {
  prev: '<svg viewBox="0 0 24 24"><path d="M7 6h2.2v12H7zM19 6v12l-9-6z"/></svg>',
  next: '<svg viewBox="0 0 24 24"><path d="M14.8 6H17v12h-2.2zM5 6l9 6-9 6z"/></svg>',
  playpause:
    '<span class="icon-play"><svg viewBox="0 0 24 24"><path d="M7 5l11 7-11 7z"/></svg></span>' +
    '<span class="icon-pause"><svg viewBox="0 0 24 24"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/></svg></span>',
};

const controls = $("miniControls");
controls.innerHTML =
  `<button class="mini-ctrl" data-cmd="prev">${ICONS.prev}</button>` +
  `<button class="mini-ctrl play" data-cmd="playpause">${ICONS.playpause}</button>` +
  `<button class="mini-ctrl" data-cmd="next">${ICONS.next}</button>`;
controls.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-cmd]");
  if (btn) window.cinnamon.transport({ cmd: btn.dataset.cmd as any });
});

$("miniClose").addEventListener("click", () => window.cinnamon.miniHide());

let currentTrack: string | null = null;
let duration = 0;
let basePos = 0;
let basePosAt = 0;
let playing = false;
let selectedTheme = "cinnamon";

function setAccent(accent: string, onAccent: string) {
  const root = document.documentElement.style;
  root.setProperty("--accent", accent);
  root.setProperty("--on-accent", onAccent);
}

window.cinnamon.getSettings().then((s) => {
  selectedTheme = s.theme;
});

window.cinnamon.onState((state: NowPlaying) => {
  duration = state.duration ?? 0;
  basePos = state.position ?? 0;
  basePosAt = Date.now();
  playing = state.playing;

  if (!state.track) {
    trackEl.textContent = "Cinnamon";
    artistEl.textContent = "Nothing playing";
    coverEl.style.backgroundImage = "";
    ambientEl.style.backgroundImage = "";
    progressWrap.classList.add("hidden");
    currentTrack = null;
  } else if (state.track !== currentTrack) {
    currentTrack = state.track;
    trackEl.textContent = state.track;
    artistEl.textContent = state.artist ?? "";
    coverEl.style.backgroundImage = "";
  }
  progressWrap.classList.toggle("hidden", duration <= 0);
  document
    .querySelectorAll<HTMLElement>(".mini-ctrl.play")
    .forEach((el) => el.classList.toggle("is-playing", playing));
});

window.cinnamon.onArtwork(async (art: Artwork) => {
  if (art.track !== currentTrack) return;
  const url = `url("${art.dataUrl}")`;
  coverEl.style.backgroundImage = url;
  ambientEl.style.backgroundImage = url;
  if (isDynamic(selectedTheme)) {
    const { accent, onAccent } = await extractAccent(art.dataUrl);
    setAccent(accent, onAccent);
  }
});

setInterval(() => {
  if (duration <= 0) return;
  let est = basePos + (playing ? (Date.now() - basePosAt) / 1000 : 0);
  est = Math.min(est, duration);
  progressEl.style.width = `${Math.min(100, (est / duration) * 100)}%`;
}, 250);
