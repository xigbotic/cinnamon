import "./style.css";
import {
  allThemes,
  applyTheme,
  applyVars,
  contrastRatio,
  cssToHex,
  extractAccent,
  isCustom,
  isDynamic,
  setCustomThemes,
  varsFromColors,
} from "./themes";
import {
  Visualizer,
  VISUALIZERS,
  listAudioInputs,
  normalizeMode,
  type Boost,
  type Quality,
  type VizLayout,
} from "./viz";
import { HOTKEYS } from "../../../shared/hotkeys";
import { renderCard, type CardFormat } from "./card";
import { lineWords, buildWordSpans, clearWordSpans, paintWords, type WordTiming } from "./karaoke";
import type {
  NowPlaying,
  Artwork,
  Lyrics,
  ScrobbleStatus,
  SearchResult,
  CinnamonApi,
  Prefs,
  TrackInfo,
  SleepStatus,
  UpdateStatus,
  CustomTheme,
  ThemeColors,
  StatsOverview,
  StatsPeriod,
  StatsTop,
} from "../../../shared/types";

declare global {
  interface Window {
    cinnamon: CinnamonApi;
  }
}

const $ = (id: string) => document.getElementById(id)!;

let toastTimer: number | undefined;
function showToast(message: string) {
  const el = $("toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.remove("show"), 3200);
}

// ---- window controls (frameless) ----
$("winMin").addEventListener("click", () => window.cinnamon.windowMinimize());
$("winClose").addEventListener("click", () => window.cinnamon.windowClose());

// ---- immersive fullscreen ----
const immersiveEl = $("immersive");
const visualizer = new Visualizer(
  $("vizCanvas") as HTMLCanvasElement,
  $("vizGl") as HTMLCanvasElement
);
let immersiveOpen = false;
let vizMode = "aurora";
let vizQuality: Quality = "medium";
let immLayout: Prefs["immLayout"] = "full";
let lastWithPlayer: Prefs["immLayout"] = "full"; // restored when leaving visualizer-only
let captionPos: Prefs["captionPos"] = "bl";
let hasLyrics = false;

const vizName = (id: string) => VISUALIZERS.find((v) => v.id === id)?.name ?? id;

$("expandBtn").addEventListener("click", () => window.cinnamon.toggleFullscreen());
$("immExit").addEventListener("click", () => window.cinnamon.toggleFullscreen());

window.cinnamon.onFullscreen((isFs) => {
  immersiveOpen = isFs;
  immersiveEl.classList.toggle("open", isFs);
  if (isFs) wakeToolbar();
  syncVizRunning();
  // Re-anchor the active lyric line in the newly visible view.
  if (isFs && activeLineIdx >= 0) {
    immLyricEls[activeLineIdx]?.scrollIntoView({ block: "center" });
  }
});

/** Only run the visualizer while it's actually on screen. */
function syncVizRunning() {
  if (immersiveOpen && vizMode !== "none") {
    visualizer.syncAccent();
    visualizer.start();
  } else {
    visualizer.stop();
  }
}

async function selectViz(id: string, announce = false, persist = true) {
  vizMode = id;
  visualizer.setMode(id);
  $("immVizName").textContent = vizName(id);
  syncVizRunning();
  buildVizPicker();
  if (announce) osd(vizName(id));
  if (persist) await window.cinnamon.setVisualizer(id);
}

/** Every mode this machine can run, in picker order. */
const usableViz = () =>
  VISUALIZERS.filter((v) => v.id !== "none" && (v.engine !== "gl" || visualizer.glSupported)).map(
    (v) => v.id
  );

function cycleViz(dir: 1 | -1) {
  const ids = usableViz();
  let i = ids.indexOf(vizMode);
  if (i < 0) i = dir > 0 ? -1 : 0; // coming from "Off"
  selectViz(ids[(i + dir + ids.length) % ids.length], true);
}

function applyImmLayout() {
  immersiveEl.classList.remove("layout-full", "layout-player", "layout-minimal");
  immersiveEl.classList.add(`layout-${immLayout}`);
  $("immCaption").className = `imm-caption pos-${captionPos}`;
  $("immLyricsBtn").classList.toggle("active", immLayout === "full");
  $("immMinimalBtn").classList.toggle("active", immLayout === "minimal");
  buildLayoutPickers(); // keep settings in step with toolbar/keyboard changes
}

async function setImmLayout(next: Prefs["immLayout"], announce = false) {
  if (next !== "minimal") lastWithPlayer = next;
  immLayout = next;
  applyImmLayout();
  if (announce) {
    osd(next === "full" ? "Lyrics on" : next === "player" ? "Lyrics off" : "Visualizer only");
  }
  await window.cinnamon.setPref("immLayout", next);
}

const toggleLyrics = () => setImmLayout(immLayout === "full" ? "player" : "full", true);
const toggleMinimal = () =>
  setImmLayout(immLayout === "minimal" ? lastWithPlayer : "minimal", true);

$("immVizPrev").addEventListener("click", () => cycleViz(-1));
$("immVizNext").addEventListener("click", () => cycleViz(1));
$("immLyricsBtn").addEventListener("click", toggleLyrics);
$("immMinimalBtn").addEventListener("click", toggleMinimal);

document.addEventListener("keydown", (e) => {
  if (!immersiveOpen || e.target instanceof HTMLInputElement) return;
  switch (e.key) {
    case "Escape": window.cinnamon.toggleFullscreen(); break;
    case "l": case "L": toggleLyrics(); break;
    case "v": case "V": toggleMinimal(); break;
    case "k": case "K": setKaraoke(!karaokeOn, true); break;
    case "ArrowRight": cycleViz(1); break;
    case "ArrowLeft": cycleViz(-1); break;
    default: return;
  }
  wakeToolbar();
});

// Toolbar and cursor fade out when the mouse rests, so fullscreen stays clean.
let idleTimer: number | undefined;
let overToolbar = false;
function wakeToolbar() {
  immersiveEl.classList.remove("idle");
  clearTimeout(idleTimer);
  idleTimer = window.setTimeout(() => {
    if (immersiveOpen && !overToolbar) immersiveEl.classList.add("idle");
  }, 2600);
}
immersiveEl.addEventListener("mousemove", wakeToolbar);
$("immToolbar").addEventListener("mouseenter", () => (overToolbar = true));
$("immToolbar").addEventListener("mouseleave", () => {
  overToolbar = false;
  wakeToolbar();
});

let osdTimer: number | undefined;
function osd(text: string) {
  const el = $("immOsd");
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(osdTimer);
  osdTimer = window.setTimeout(() => el.classList.remove("show"), 1400);
}

function cssRect(el: Element | null | undefined): DOMRect | null {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? r : null;
}

/**
 * Tells the visualizer where things are: circular modes orbit the cover, and
 * everything backs off around the text (hardest on the line being sung).
 */
visualizer.setLayoutProvider((): VizLayout => {
  if (immLayout === "minimal") {
    const cap = cssRect($("immCaption"));
    return {
      focus: null,
      protect: cap
        ? [{ x: cap.left, y: cap.top, w: cap.width, h: cap.height, strength: 0.55 }]
        : [],
      intensity: 1,
    };
  }

  const cover = cssRect(immCoverEl);
  const focus = cover
    ? {
        x: cover.left + cover.width / 2,
        y: cover.top + cover.height / 2,
        r: Math.hypot(cover.width, cover.height) / 2, // clears the corners
      }
    : null;

  const protect: VizLayout["protect"] = [];
  const meta = [immTrackEl, immArtistEl, immProgressWrap, $("immControls")]
    .map(cssRect)
    .filter((r): r is DOMRect => r !== null);
  if (meta.length) {
    const x0 = Math.min(...meta.map((r) => r.left));
    const y0 = Math.min(...meta.map((r) => r.top));
    const x1 = Math.max(...meta.map((r) => r.right));
    const y1 = Math.max(...meta.map((r) => r.bottom));
    protect.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0, strength: 0.7 });
  }

  const lyricsShown = immLayout === "full" && hasLyrics;
  if (lyricsShown) {
    const col = cssRect(immLyricsEl);
    if (col) protect.push({ x: col.left, y: col.top, w: col.width, h: col.height, strength: 0.4 });
    const line = activeLineIdx >= 0 ? cssRect(immLyricEls[activeLineIdx]) : null;
    if (line) protect.push({ x: line.left, y: line.top, w: line.width, h: line.height, strength: 0.9 });
  }

  return { focus, protect, intensity: lyricsShown ? 0.85 : 0.95 };
});

// ---- nav ----
document.querySelectorAll<HTMLButtonElement>(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    const view = tab.dataset.view!;
    document
      .querySelectorAll(".tab")
      .forEach((t) => t.classList.toggle("active", t === tab));
    document
      .querySelectorAll(".view")
      .forEach((v) => v.classList.toggle("active", v.id === `view-${view}`));
    if (view === "search") $("searchInput").focus();
    if (view === "stats") loadStats();
  });
});

// ---- now playing ----
const coverEl = $("cover");
const trackEl = $("track");
const artistEl = $("artist");
const albumEl = $("album");
const statusEl = $("status");
const progressEl = $("progress");
const progressWrap = $("progressWrap");

const ambientEl = document.getElementById("ambient")!;
const immAmbientEl = $("immAmbient");
const immCoverEl = $("immCover");
const immTrackEl = $("immTrack");
const immArtistEl = $("immArtist");
const immProgressEl = $("immProgress");
const immProgressWrap = $("immProgressWrap");

let currentTrack: string | null = null;
let currentDuration = 0;

// Interpolation state: we get ticks ~once/second but advance position locally
// between them so the progress bar and lyric highlight move smoothly and in time.
let basePosition = 0;
let basePositionAt = 0;
let statePlaying = false;

function estimatedPosition(): number {
  let est = basePosition;
  if (statePlaying) est += (Date.now() - basePositionAt) / 1000;
  if (currentDuration > 0) est = Math.min(est, currentDuration);
  return est;
}

let vizCycle: Prefs["vizCycle"] = "off";
let currentAlbum: string | null = null;

/**
 * Auto-switch picks a different visualizer at random when the track (or
 * album) changes. It isn't saved, so the chosen default survives a restart.
 */
function maybeAutoSwitchViz(prevTrack: string | null, next: NowPlaying) {
  const album = next.album ?? "";
  const albumChanged = album !== currentAlbum;
  currentAlbum = album;
  if (vizCycle === "off" || vizMode === "none" || prevTrack === null) return;
  if (vizCycle === "album" && !albumChanged) return;
  const ids = usableViz().filter((id) => id !== vizMode);
  if (ids.length === 0) return;
  selectViz(ids[Math.floor(Math.random() * ids.length)], immersiveOpen, false);
}

function render(state: NowPlaying) {
  const incoming = state.position ?? 0;
  const trackChanged = state.track !== currentTrack;
  const prevEstimate = estimatedPosition(); // must read before we overwrite base
  const wasPlaying = statePlaying;

  statePlaying = state.playing;
  currentDuration = state.duration ?? 0;

  // SMTC reports position in whole seconds, so a fresh tick can land slightly
  // *behind* our smoothly interpolated clock. Accepting it verbatim rewinds the
  // lyric highlight for a frame before it catches up again. Only allow the
  // clock to move backwards for a genuine seek / track change / resume.
  const isSeek = Math.abs(incoming - prevEstimate) > 2.5;
  basePosition =
    trackChanged || !wasPlaying || isSeek
      ? incoming
      : Math.max(incoming, prevEstimate);
  basePositionAt = Date.now();

  if (!state.track) {
    trackEl.textContent = "No media";
    artistEl.textContent = "System standby";
    albumEl.textContent = "";
    coverEl.style.backgroundImage = "";
    ambientEl.style.backgroundImage = "";
    immTrackEl.textContent = "No media";
    immArtistEl.textContent = "";
    $("capTrack").textContent = "No media";
    $("capArtist").textContent = "";
    progressWrap.classList.add("hidden");
    immProgressWrap.classList.add("hidden");
    currentTrack = null;
    statePlaying = false;
    updatePlayIcons();
    refreshStatus();
    return;
  }

  if (state.track !== currentTrack) {
    maybeAutoSwitchViz(currentTrack, state);
    currentTrack = state.track;
    trackEl.textContent = state.track;
    artistEl.textContent = state.artist ?? "";
    albumEl.textContent = state.album ?? "";
    coverEl.style.backgroundImage = "";
    immTrackEl.textContent = state.track;
    immArtistEl.textContent = state.artist ?? "";
    immCoverEl.style.backgroundImage = "";
    $("capTrack").textContent = state.track;
    $("capArtist").textContent = state.artist ?? "";
  }

  updatePlayIcons();
  refreshStatus();
  visualizer.setPlaying(state.playing);
  progressWrap.classList.toggle("hidden", currentDuration <= 0);
  immProgressWrap.classList.toggle("hidden", currentDuration <= 0);
}

// Smooth 5x/second update driven by the interpolated clock.
setInterval(() => {
  const pos = estimatedPosition();
  if (currentDuration > 0) {
    const pct = Math.min(100, (pos / currentDuration) * 100);
    progressEl.style.width = `${pct}%`;
    immProgressEl.style.width = `${pct}%`;
  }
  syncLyrics(pos);
  refreshStatus(); // lets the transient "qualified" badge revert on its own
}, 200);

let showQualifiedUntil = 0; // qualified badge shows briefly, then reverts

function refreshStatus() {
  if (!currentTrack) {
    statusEl.className = "status";
    statusEl.textContent = "IDLE";
    return;
  }
  if (!statePlaying) {
    statusEl.className = "status paused";
    statusEl.textContent = "● PAUSED";
    return;
  }
  if (Date.now() < showQualifiedUntil) {
    statusEl.className = "status qualified";
    statusEl.textContent = "● SCROBBLE QUALIFIED";
    return;
  }
  statusEl.className = "status playing";
  statusEl.textContent = "● PLAYING";
}

let lastArtUrl = "";

async function applyArtwork(art: Artwork) {
  if (art.track !== currentTrack) return;
  lastArtUrl = art.dataUrl;
  const url = `url("${art.dataUrl}")`;
  coverEl.style.backgroundImage = url;
  ambientEl.style.backgroundImage = url;
  immCoverEl.style.backgroundImage = url;
  immAmbientEl.style.backgroundImage = url;
  visualizer.setArtwork(art.dataUrl); // multi-colour palette for the visualizer
  if (isDynamic(selectedTheme)) applyDynamicAccent();
}

async function applyDynamicAccent() {
  if (!lastArtUrl) return;
  const { accent, onAccent } = await extractAccent(lastArtUrl);
  const root = document.documentElement.style;
  root.setProperty("--accent", accent);
  root.setProperty("--accent-soft", accent);
  // Keep icons/text on top of the accent readable for light artwork.
  root.setProperty("--on-accent", onAccent);
  visualizer.syncAccent(); // visualizer follows the artwork colour too
}

window.cinnamon.onState(render);
window.cinnamon.onArtwork(applyArtwork);

// ---- transport controls (SVG, built into both the card and immersive view) ----
const ICONS = {
  prev: '<svg viewBox="0 0 24 24"><path d="M7 6h2.2v12H7zM19 6v12l-9-6z"/></svg>',
  next: '<svg viewBox="0 0 24 24"><path d="M14.8 6H17v12h-2.2zM5 6l9 6-9 6z"/></svg>',
  // Play spans x 7-18 so its centre lines up with the pause bars (7-17).
  playpause:
    '<span class="icon-play"><svg viewBox="0 0 24 24"><path d="M7 5l11 7-11 7z"/></svg></span>' +
    '<span class="icon-pause"><svg viewBox="0 0 24 24"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/></svg></span>',
};

function buildControls(container: HTMLElement) {
  container.innerHTML =
    `<button class="ctrl" data-cmd="prev">${ICONS.prev}</button>` +
    `<button class="ctrl play" data-cmd="playpause">${ICONS.playpause}</button>` +
    `<button class="ctrl" data-cmd="next">${ICONS.next}</button>`;
  container.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-cmd]");
    if (!btn) return;
    window.cinnamon.transport({ cmd: btn.dataset.cmd as any });
  });
}
buildControls($("controls"));
buildControls($("immControls"));

function updatePlayIcons() {
  document
    .querySelectorAll<HTMLElement>(".ctrl.play")
    .forEach((el) => el.classList.toggle("is-playing", statePlaying));
}

// ---- scrobble status ----
let wasQualified = false;
window.cinnamon.onScrobbleStatus((s: ScrobbleStatus) => {
  lastfmConnected = s.connected;
  if (s.qualified && !wasQualified) showQualifiedUntil = Date.now() + 4000;
  wasQualified = s.qualified;
  $("scrobbleCount").textContent = `SCROBBLES ${s.totalScrobbles}`;
  const statusText = $("lastfmStatus");
  const btn = $("lastfmBtn") as HTMLButtonElement;
  if (s.connected) {
    $("onboardLastfmStatus").textContent = `Connected as ${s.username ?? "?"}`;
    $("onboardLastfmBtn").style.display = "none";
    statusText.textContent = `Connected as ${s.username ?? "?"}`;
    btn.textContent = "DISCONNECT";
    btn.className = "btn secondary";
    btn.dataset.mode = "disconnect";
  } else {
    $("onboardLastfmStatus").textContent = "Not connected";
    $("onboardLastfmBtn").style.display = "";
    $("onboardLastfmBtn").textContent = "CONNECT LAST.FM";
    statusText.textContent = "Not connected";
    btn.textContent = "CONNECT LAST.FM";
    btn.className = "btn";
    btn.dataset.mode = "connect";
  }
});

// ---- last.fm connect flow ----
const lastfmBtn = $("lastfmBtn") as HTMLButtonElement;
lastfmBtn.addEventListener("click", async () => {
  const mode = lastfmBtn.dataset.mode;
  if (mode === "disconnect") {
    await window.cinnamon.lastfmDisconnect();
    return;
  }
  if (mode === "confirm") {
    const ok = await window.cinnamon.lastfmComplete();
    if (!ok) {
      $("lastfmStatus").textContent = "Authorization not found. Try again.";
      $("onboardLastfmStatus").textContent = "Authorization not found. Try again.";
      $("onboardLastfmBtn").textContent = "CONNECT LAST.FM";
      lastfmBtn.textContent = "CONNECT LAST.FM";
      lastfmBtn.dataset.mode = "connect";
    }
    return;
  }
  // connect
  await window.cinnamon.lastfmConnect(); // opens browser
  $("lastfmStatus").textContent = "Authorize in your browser, then confirm";
  $("onboardLastfmStatus").textContent = "Authorize in your browser, then confirm";
  lastfmBtn.textContent = "CONFIRM CONNECTION";
  $("onboardLastfmBtn").textContent = "CONFIRM CONNECTION";
  lastfmBtn.dataset.mode = "confirm";
});

// ---- search ----
const searchInput = $("searchInput") as HTMLInputElement;
const resultsEl = $("results");
let searchTimer: number | undefined;

searchInput.addEventListener("input", () => {
  clearTimeout(searchTimer);
  const term = searchInput.value;
  searchTimer = window.setTimeout(async () => {
    if (!term.trim()) {
      resultsEl.innerHTML = "";
      return;
    }
    try {
      const results = await window.cinnamon.search(term);
      renderResults(results);
    } catch {
      resultsEl.innerHTML = `<div class="lyrics-empty">Search failed</div>`;
    }
  }, 350);
});

function renderResults(results: SearchResult[]) {
  resultsEl.innerHTML = "";
  for (const r of results) {
    const row = document.createElement("div");
    row.className = "result";
    row.innerHTML = `
      <img src="${r.artworkUrl}" alt="" />
      <div class="r-meta">
        <div class="r-track"><span class="r-name"></span></div>
        <div class="r-artist"></div>
      </div>`;
    row.querySelector<HTMLElement>(".r-name")!.textContent = r.trackName;
    if (r.explicit) {
      const badge = document.createElement("span");
      badge.className = "explicit";
      badge.textContent = "E";
      row.querySelector<HTMLElement>(".r-track")!.appendChild(badge);
    }
    row.querySelector<HTMLElement>(".r-artist")!.textContent =
      `${r.artistName} · ${r.collectionName}`;
    row.addEventListener("click", () => {
      window.cinnamon.play(r.trackViewUrl);
      showToast(`Opened “${r.trackName}” in Apple Music. Press Play ▶`);
    });
    resultsEl.appendChild(row);
  }
}

// ---- lyrics (rendered into both the normal view and the immersive view) ----
const lyricsEl = $("lyrics");
const immLyricsEl = $("immLyrics");
let lyrics: Lyrics | null = null;
let lyricEls: HTMLElement[] = [];
let immLyricEls: HTMLElement[] = [];
let activeLineIdx = -1;

function buildLyricLines(container: HTMLElement, l: Lyrics | null): HTMLElement[] {
  container.innerHTML = "";
  if (!l || l.lines.length === 0) {
    container.innerHTML = `<div class="lyrics-empty">No lyrics found</div>`;
    return [];
  }
  const els: HTMLElement[] = [];
  for (const line of l.lines) {
    const el = document.createElement("div");
    el.className = l.synced ? "lyric-line" : "lyric-line plain";
    el.textContent = line.text || "♪";
    container.appendChild(el);
    els.push(el);
  }
  return els;
}

window.cinnamon.onLyrics((l) => {
  endShare(); // selections belong to the previous track's lyrics
  lyrics = l;
  activeLineIdx = -1;
  karaokeWords = [];
  karaokeSpans = [];
  lyricEls = buildLyricLines(lyricsEl, l);
  immLyricEls = buildLyricLines(immLyricsEl, l);
  // Nothing to show beside the player: let the immersive view centre itself.
  hasLyrics = !!(l && l.lines.length > 0);
  immersiveEl.classList.toggle("no-lyrics", !hasLyrics);
});

let lyricOffset = 0;
// LRCLIB timestamps run ~1s behind Apple's masters across the board; bake in a
// universal lead so lyrics are on-sync by default. User offset stacks on top.
const BASE_LYRIC_LEAD = 1.0;

function syncLyrics(position: number) {
  if (!lyrics || !lyrics.synced || currentDuration <= 0) return;
  const p = position + lyricOffset + BASE_LYRIC_LEAD; // positive = activate earlier
  let idx = -1;
  for (let i = 0; i < lyrics.lines.length; i++) {
    if (lyrics.lines[i].time <= p) idx = i;
    else break;
  }
  if (idx !== activeLineIdx) {
    if (activeLineIdx >= 0) {
      lyricEls[activeLineIdx]?.classList.remove("active");
      immLyricEls[activeLineIdx]?.classList.remove("active");
    }
    setKaraokeLine(activeLineIdx, idx);
    activeLineIdx = idx;
    if (idx >= 0) {
      lyricEls[idx]?.classList.add("active");
      immLyricEls[idx]?.classList.add("active");
      // Scroll whichever view the user is looking at.
      const target = immersiveOpen ? immLyricEls[idx] : lyricEls[idx];
      target?.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }
}

// ---- listening stats ----
let lastfmConnected = false;
let statsPeriod: StatsPeriod = "1month";
let statsLoading = false;

const PERIODS: [StatsPeriod, string][] = [
  ["7day", "7 days"],
  ["1month", "Month"],
  ["12month", "Year"],
  ["overall", "All time"],
];

function statsMessage(html: string) {
  $("statsBody").style.display = "none";
  const el = $("statsEmpty");
  el.style.display = "";
  el.innerHTML = html;
}

const fmt = (n: number) => n.toLocaleString();

function renderOverview(o: StatsOverview) {
  $("statTotal").textContent = fmt(o.total);
  $("statToday").textContent = fmt(o.today);
  $("statStreak").textContent = `${o.streak}${o.streakCapped ? "+" : ""}`;
  $("statSince").textContent = o.registered ? String(new Date(o.registered * 1000).getFullYear()) : "–";

  // One series, one colour: bars in the accent, text in text colours. A
  // zero day still gets a 2px stub so the baseline reads as continuous.
  const chart = $("dayChart");
  chart.innerHTML = "";
  const max = Math.max(1, ...o.days.map((d) => d.plays));
  const sum = o.days.reduce((a, d) => a + d.plays, 0);
  const best = o.days.reduce((a, d) => (d.plays > a.plays ? d : a), o.days[0]);
  const label = (date: string) =>
    new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  chart.setAttribute(
    "aria-label",
    `Plays per day for the last 30 days: ${fmt(sum)} in total, most on ${label(best.date)} with ${best.plays}.`
  );
  for (const d of o.days) {
    const col = document.createElement("div");
    col.className = "day-col";
    const bar = document.createElement("div");
    bar.className = d.plays ? "day-bar" : "day-bar zero";
    bar.style.height = d.plays ? `${Math.max(4, (d.plays / max) * 100)}%` : "2px";
    col.appendChild(bar);
    col.dataset.tip = `${label(d.date)} · ${d.plays} ${d.plays === 1 ? "play" : "plays"}`;
    chart.appendChild(col);
  }
  $("dayStart").textContent = label(o.days[0].date);
  $("days30Note").textContent =
    `${fmt(sum)} plays${o.partial ? "+" : ""}` + (best.plays ? ` · best ${best.plays} on ${label(best.date)}` : "");

  const otd = o.onThisDay;
  $("onThisDayCard").style.display = otd.total ? "" : "none";
  $("onThisDayTitle").textContent = `On this day in ${otd.year}`;
  $("onThisDayNote").textContent = `${fmt(otd.total)} ${otd.total === 1 ? "play" : "plays"}`;
  renderRank($("onThisDay"), otd.tracks.map((t) => ({ name: t.name, sub: t.artist, plays: t.plays })));
}

/** Ranked rows with a thin bar scaled to the top entry. */
function renderRank(el: HTMLElement, rows: { name: string; sub?: string; plays: number }[]) {
  el.innerHTML = "";
  if (rows.length === 0) {
    el.innerHTML = `<div class="rank-empty">Nothing here yet</div>`;
    return;
  }
  const top = Math.max(1, rows[0].plays);
  rows.forEach((r, i) => {
    const row = document.createElement("div");
    row.className = "rank-row";
    row.innerHTML = `
      <span class="rank-n">${i + 1}</span>
      <div class="rank-main">
        <div class="rank-text"><span class="rank-name"></span><span class="rank-sub"></span></div>
        <div class="rank-track"><div class="rank-bar"></div></div>
      </div>
      <span class="rank-plays"></span>`;
    row.querySelector<HTMLElement>(".rank-name")!.textContent = r.name;
    row.querySelector<HTMLElement>(".rank-sub")!.textContent = r.sub ? ` · ${r.sub}` : "";
    row.querySelector<HTMLElement>(".rank-bar")!.style.width = `${Math.max(2, (r.plays / top) * 100)}%`;
    row.querySelector<HTMLElement>(".rank-plays")!.textContent = fmt(r.plays);
    el.appendChild(row);
  });
}

function renderTop(t: StatsTop) {
  renderRank($("topArtists"), t.artists.map((a) => ({ name: a.name, plays: a.plays })));
  renderRank($("topTracks"), t.tracks.map((x) => ({ name: x.name, sub: x.artist, plays: x.plays })));
  const grid = $("topAlbums");
  grid.innerHTML = "";
  if (t.albums.length === 0) grid.innerHTML = `<div class="rank-empty">Nothing here yet</div>`;
  for (const a of t.albums) {
    const cell = document.createElement("div");
    cell.className = "album-cell";
    cell.innerHTML = `<div class="album-art"></div><div class="album-name"></div><div class="album-plays"></div>`;
    const art = cell.querySelector<HTMLElement>(".album-art")!;
    if (a.image) art.style.backgroundImage = `url("${a.image}")`;
    else art.textContent = a.name.slice(0, 1).toUpperCase();
    cell.querySelector<HTMLElement>(".album-name")!.textContent = a.name;
    cell.querySelector<HTMLElement>(".album-plays")!.textContent = `${fmt(a.plays)} plays`;
    cell.title = `${a.name} · ${a.artist}`;
    grid.appendChild(cell);
  }
}

function buildPeriodPicker() {
  const seg = $("statsPeriod");
  seg.innerHTML = "";
  for (const [id, label] of PERIODS) {
    const b = document.createElement("button");
    b.textContent = label;
    b.className = id === statsPeriod ? "selected" : "";
    b.addEventListener("click", async () => {
      statsPeriod = id;
      buildPeriodPicker();
      try {
        const t = await window.cinnamon.statsTop(id);
        if (t) renderTop(t);
      } catch {
        showToast("Couldn't load top lists from Last.fm");
      }
    });
    seg.appendChild(b);
  }
}

async function loadStats(force = false) {
  if (statsLoading) return;
  if (!lastfmConnected) {
    statsMessage(
      `<div class="stats-empty-title">Your listening stats</div>` +
        `<p>Connect Last.fm in Settings to see your top artists, tracks and albums, your daily plays and your streak.</p>`
    );
    return;
  }
  statsLoading = true;
  if ($("statsBody").style.display === "none" || !$("statTotal").textContent?.match(/\d/)) {
    statsMessage(`<p>Loading your stats…</p>`);
  }
  try {
    const [o, t] = await Promise.all([
      window.cinnamon.statsOverview(force),
      window.cinnamon.statsTop(statsPeriod, force),
    ]);
    if (!o || !t) throw new Error("not connected");
    $("statsEmpty").style.display = "none";
    $("statsBody").style.display = "";
    buildPeriodPicker();
    renderOverview(o);
    renderTop(t);
  } catch {
    statsMessage(`<p>Couldn't reach Last.fm.</p><button class="btn small" id="statsRetry">TRY AGAIN</button>`);
    $("statsRetry").addEventListener("click", () => loadStats(true));
  } finally {
    statsLoading = false;
  }
}

$("statsRefresh").addEventListener("click", () => loadStats(true));

// Hover tooltip for the day chart: the whole column is the hit target, not
// just the (often tiny) bar.
const dayTip = $("dayTip");
$("dayChart").addEventListener("mousemove", (e) => {
  const col = (e.target as HTMLElement).closest<HTMLElement>(".day-col");
  if (!col) return;
  const card = dayTip.parentElement!.getBoundingClientRect();
  const r = col.getBoundingClientRect();
  dayTip.textContent = col.dataset.tip ?? "";
  dayTip.classList.add("show");
  const x = r.left + r.width / 2 - card.left;
  dayTip.style.left = `${Math.min(card.width - 70, Math.max(70, x))}px`;
  $("dayChart").querySelectorAll(".day-col.hover").forEach((c) => c.classList.remove("hover"));
  col.classList.add("hover");
});
$("dayChart").addEventListener("mouseleave", () => {
  dayTip.classList.remove("show");
  $("dayChart").querySelectorAll(".day-col.hover").forEach((c) => c.classList.remove("hover"));
});

// ---- lyric share cards ----
const MAX_SHARE_LINES = 6;
let sharing = false;
const shareSel = new Set<number>();
let shareFormat: CardFormat = "square";
let shareImage = "";

function renderShareBar() {
  $("shareCount").textContent =
    shareSel.size === 0
      ? "Tap lines to share"
      : `${shareSel.size} line${shareSel.size === 1 ? "" : "s"} selected`;
  ($("shareCreate") as HTMLButtonElement).disabled = shareSel.size === 0;
}

function startShare() {
  if (!lyrics || lyrics.lines.length === 0) {
    showToast("No lyrics to share for this track");
    return;
  }
  sharing = true;
  shareSel.clear();
  lyricsEl.classList.add("sharing");
  $("offsetBar").style.display = "none";
  $("shareBar").classList.add("open");
  renderShareBar();
}

function endShare() {
  sharing = false;
  shareSel.clear();
  lyricsEl.classList.remove("sharing");
  lyricEls.forEach((el) => el.classList.remove("share-selected"));
  $("offsetBar").style.display = "";
  $("shareBar").classList.remove("open");
}

lyricsEl.addEventListener("click", (e) => {
  if (!sharing) return;
  const el = (e.target as HTMLElement).closest<HTMLElement>(".lyric-line");
  const i = el ? lyricEls.indexOf(el) : -1;
  if (i < 0 || !lyrics?.lines[i]?.text.trim()) return;
  if (shareSel.has(i)) shareSel.delete(i);
  else if (shareSel.size >= MAX_SHARE_LINES) {
    showToast(`Up to ${MAX_SHARE_LINES} lines fit on a card`);
    return;
  } else shareSel.add(i);
  el!.classList.toggle("share-selected", shareSel.has(i));
  renderShareBar();
});

async function drawShareCard() {
  if (!lyrics) return;
  const lines = [...shareSel].sort((a, b) => a - b).map((i) => lyrics!.lines[i].text);
  // Remote covers come back through the main process as data URLs so the
  // canvas can export them.
  let cover = lastArtUrl;
  if (cover.startsWith("http")) cover = (await window.cinnamon.fetchImage(cover)) ?? "";
  shareImage = await renderCard({
    lines,
    track: currentTrack ?? "",
    artist: artistEl.textContent ?? "",
    cover,
    format: shareFormat,
  });
  ($("sharePreview") as HTMLImageElement).src = shareImage;
  $("sharePreview").classList.toggle("story", shareFormat === "story");
}

function buildShareFormat() {
  const seg = $("shareFormat");
  seg.innerHTML = "";
  for (const [id, label] of [["square", "Square"], ["story", "Story"]] as const) {
    const b = document.createElement("button");
    b.textContent = label;
    b.className = id === shareFormat ? "selected" : "";
    b.addEventListener("click", () => {
      shareFormat = id;
      buildShareFormat();
      drawShareCard();
    });
    seg.appendChild(b);
  }
}

$("shareStart").addEventListener("click", startShare);
$("shareCancel").addEventListener("click", endShare);
$("shareCreate").addEventListener("click", async () => {
  if (shareSel.size === 0) return;
  buildShareFormat();
  await drawShareCard();
  $("shareModal").classList.add("open");
});
$("shareClose").addEventListener("click", () => $("shareModal").classList.remove("open"));
$("shareCopy").addEventListener("click", async () => {
  await window.cinnamon.copyImage(shareImage);
  showToast("Card copied. Paste it anywhere.");
});
$("shareSave").addEventListener("click", async () => {
  const path = await window.cinnamon.saveImage(shareImage, `${currentTrack ?? "Lyrics"} - lyrics`);
  if (path) {
    showToast("Card saved");
    $("shareModal").classList.remove("open");
    endShare();
  }
});

// ---- word-by-word karaoke ----
let karaokeOn = true;
let karaokeWords: WordTiming[] = [];
let karaokeSpans: HTMLElement[][] = [];

/** Moves the per-word spans from the old active line to the new one. */
function setKaraokeLine(prev: number, next: number) {
  if (lyrics && prev >= 0) {
    const text = lyrics.lines[prev]?.text || "♪";
    for (const el of [lyricEls[prev], immLyricEls[prev]]) if (el) clearWordSpans(el, text);
  }
  karaokeWords = [];
  karaokeSpans = [];
  if (!karaokeOn || !lyrics?.synced || next < 0) return;
  karaokeWords = lineWords(lyrics, next);
  if (karaokeWords.length === 0) return;
  karaokeSpans = [lyricEls[next], immLyricEls[next]]
    .filter((el): el is HTMLElement => !!el)
    .map((el) => buildWordSpans(el, karaokeWords));
}

function karaokeFrame() {
  requestAnimationFrame(karaokeFrame);
  if (!karaokeSpans.length) return;
  const p = estimatedPosition() + lyricOffset + BASE_LYRIC_LEAD;
  for (const spans of karaokeSpans) paintWords(spans, karaokeWords, p);
}
requestAnimationFrame(karaokeFrame);

const karaokeToggle = $("karaokeToggle") as HTMLInputElement;

/** Keeps the settings checkbox and both quick buttons showing the same state. */
function renderKaraokeControls() {
  karaokeToggle.checked = karaokeOn;
  for (const id of ["karaokeQuick", "immKaraokeBtn"]) $(id).classList.toggle("active", karaokeOn);
}

function setKaraoke(on: boolean, announce = false) {
  karaokeOn = on;
  setKaraokeLine(activeLineIdx, activeLineIdx); // rebuild or clear the current line
  renderKaraokeControls();
  window.cinnamon.setPref("karaoke", on);
  if (!announce) return;
  const text = on ? "Word-by-word on" : "Word-by-word off";
  if (immersiveOpen) osd(text);
  else showToast(text);
}

karaokeToggle.addEventListener("change", () => setKaraoke(karaokeToggle.checked));
$("karaokeQuick").addEventListener("click", () => setKaraoke(!karaokeOn, true));
$("immKaraokeBtn").addEventListener("click", () => setKaraoke(!karaokeOn, true));

// ---- settings: theme + startup ----
const themePicker = $("themePicker");
let selectedTheme = "cinnamon";

function buildThemePicker() {
  renderThemes(themePicker);
  renderThemes($("onboardThemes"));
}

function renderThemes(container: HTMLElement) {
  container.innerHTML = "";
  const inSettings = container === themePicker;
  for (const theme of allThemes()) {
    const sw = document.createElement("div");
    sw.className = "theme-swatch" + (theme.id === selectedTheme ? " selected" : "");
    sw.style.background = theme.vars["--card"];
    sw.style.color = theme.vars["--accent"];
    sw.textContent = theme.name;
    sw.addEventListener("click", async () => {
      selectedTheme = theme.id;
      applyTheme(theme.id);
      if (isDynamic(theme.id)) applyDynamicAccent();
      else visualizer.syncAccent();
      await window.cinnamon.setTheme(theme.id);
      buildThemePicker();
      buildVizPicker(); // selected swatch colour follows the accent
    });
    // Your own themes get an edit button (settings only, not the setup page).
    if (inSettings && isCustom(theme.id)) {
      const edit = document.createElement("button");
      edit.className = "theme-edit";
      edit.title = "Edit theme";
      edit.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16zM14 6l4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';
      edit.addEventListener("click", (e) => {
        e.stopPropagation();
        const t = customThemes.find((c) => c.id === theme.id);
        if (t) openThemeEditor(t, false);
      });
      sw.appendChild(edit);
    }
    container.appendChild(sw);
  }
  if (inSettings) {
    const add = document.createElement("div");
    add.className = "theme-swatch theme-new";
    add.textContent = "+ New";
    add.title = "Create a theme";
    add.addEventListener("click", () => openThemeEditor(null, true));
    container.appendChild(add);
  }
}

// ---- theme editor ----
let customThemes: CustomTheme[] = [];
let editing: CustomTheme | null = null;
let editingIsNew = false;

const COLOR_FIELDS: [keyof ThemeColors, string, string][] = [
  ["bg", "Background", "--bg"],
  ["card", "Surface", "--card"],
  ["border", "Border", "--border"],
  ["text", "Text", "--text"],
  ["textDim", "Secondary text", "--text-dim"],
  ["textFaint", "Muted text", "--text-faint"],
  ["accent", "Accent", "--accent"],
];

/** Starts from whatever is on screen, so "new" means "tweak what I have". */
function currentColors(): ThemeColors {
  const cs = getComputedStyle(document.documentElement);
  return Object.fromEntries(
    COLOR_FIELDS.map(([k, , v]) => [k, cssToHex(cs.getPropertyValue(v).trim())])
  ) as unknown as ThemeColors;
}

function previewEditing() {
  if (!editing) return;
  applyVars(varsFromColors(editing.colors));
  const c = editing.colors;
  // WCAG AA wants 4.5:1 for body text; flag anything the eye will struggle with.
  const low = [
    ["Text", contrastRatio(c.text, c.card)],
    ["Secondary text", contrastRatio(c.textDim, c.card)],
  ].filter(([, r]) => (r as number) < 4.5);
  $("teContrast").textContent = low.length
    ? `Low contrast: ${low.map(([n, r]) => `${n} ${(r as number).toFixed(1)}:1`).join(", ")} on the surface (aim for 4.5:1).`
    : "";
}

function openThemeEditor(theme: CustomTheme | null, isNew: boolean) {
  editingIsNew = isNew;
  editing = theme
    ? { ...theme, colors: { ...theme.colors } }
    : { id: `custom-${Date.now()}`, name: `My theme ${customThemes.length + 1}`, colors: currentColors() };
  $("teTitle").textContent = isNew ? "New theme" : "Edit theme";
  ($("teName") as HTMLInputElement).value = editing.name;
  $("teDelete").style.visibility = isNew ? "hidden" : "visible";
  const grid = $("teColors");
  grid.innerHTML = "";
  for (const [key, label] of COLOR_FIELDS) {
    const row = document.createElement("label");
    row.className = "te-row";
    const input = document.createElement("input");
    input.type = "color";
    input.value = editing.colors[key];
    input.addEventListener("input", () => {
      editing!.colors[key] = input.value;
      previewEditing();
    });
    const name = document.createElement("span");
    name.textContent = label;
    row.append(input, name);
    grid.appendChild(row);
  }
  $("themeEditor").classList.add("open");
  previewEditing();
  $("themeEditor").scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function closeThemeEditor() {
  editing = null;
  $("themeEditor").classList.remove("open");
  applyTheme(selectedTheme); // drop the live preview
  if (isDynamic(selectedTheme)) applyDynamicAccent();
  visualizer.syncAccent();
}

async function saveCustomThemes() {
  setCustomThemes(customThemes);
  await window.cinnamon.setCustomThemes(customThemes);
}

$("teSave").addEventListener("click", async () => {
  if (!editing) return;
  editing.name = ($("teName") as HTMLInputElement).value.trim() || "My theme";
  const i = customThemes.findIndex((t) => t.id === editing!.id);
  if (i >= 0) customThemes[i] = editing;
  else customThemes.push(editing);
  await saveCustomThemes();
  selectedTheme = editing.id;
  await window.cinnamon.setTheme(editing.id);
  closeThemeEditor();
  buildThemePicker();
  buildVizPicker();
});
$("teCancel").addEventListener("click", closeThemeEditor);
$("teDelete").addEventListener("click", async () => {
  if (!editing || editingIsNew) return;
  customThemes = customThemes.filter((t) => t.id !== editing!.id);
  await saveCustomThemes();
  if (selectedTheme === editing.id) {
    selectedTheme = "cinnamon";
    await window.cinnamon.setTheme(selectedTheme);
  }
  closeThemeEditor();
  buildThemePicker();
});

const startupToggle = $("startupToggle") as HTMLInputElement;
startupToggle.addEventListener("change", () =>
  window.cinnamon.setStartWithWindows(startupToggle.checked)
);

// ---- behavior / discord / developer settings ----
const closeTrayToggle = $("closeTrayToggle") as HTMLInputElement;
closeTrayToggle.addEventListener("change", () =>
  window.cinnamon.setCloseToTray(closeTrayToggle.checked)
);
const notifyToggle = $("notifyToggle") as HTMLInputElement;
notifyToggle.addEventListener("change", () =>
  window.cinnamon.setPref("notifyTrack", notifyToggle.checked)
);

// ---- visualizer ----
const vizPicker = $("vizPicker");
const vizAudioToggle = $("vizAudioToggle") as HTMLInputElement;

const VIZ_GROUPS = [
  { id: "ambient", label: "Ambient" },
  { id: "spectrum", label: "Spectrum" },
  { id: "shader", label: "Shader · GPU" },
] as const;

function buildVizPicker() {
  vizPicker.innerHTML = "";
  for (const group of VIZ_GROUPS) {
    const wrap = document.createElement("div");
    wrap.className = "viz-group";
    const label = document.createElement("div");
    label.className = "viz-group-label";
    label.textContent = group.label;
    const row = document.createElement("div");
    row.className = "viz-picker";
    for (const opt of VISUALIZERS.filter((v) => v.group === group.id)) {
      const btn = document.createElement("button");
      btn.className = "viz-opt" + (opt.id === vizMode ? " selected" : "");
      btn.textContent = opt.name;
      if (opt.engine === "gl" && !visualizer.glSupported) {
        btn.disabled = true;
        btn.title = "WebGL isn't available on this system";
      }
      btn.addEventListener("click", () => selectViz(opt.id));
      row.appendChild(btn);
    }
    wrap.append(label, row);
    vizPicker.appendChild(wrap);
  }
}

const QUALITY_OPTIONS: { id: Quality; label: string; hint: string }[] = [
  { id: "low", label: "Low", hint: "30 fps, reduced resolution, no glow. Lightest on the GPU." },
  { id: "medium", label: "Medium", hint: "60 fps, half-resolution shaders. Balanced default." },
  { id: "high", label: "High", hint: "60 fps, sharper shaders and more detail." },
  { id: "ultra", label: "Ultra", hint: "Full resolution, uncapped frame rate. Heaviest on the GPU." },
];

function buildQualityPicker() {
  const seg = $("vizQuality");
  seg.innerHTML = "";
  for (const q of QUALITY_OPTIONS) {
    const b = document.createElement("button");
    b.textContent = q.label;
    b.className = q.id === vizQuality ? "selected" : "";
    b.addEventListener("click", () => {
      vizQuality = q.id;
      visualizer.setQuality(q.id);
      window.cinnamon.setPref("vizQuality", q.id);
      buildQualityPicker();
    });
    seg.appendChild(b);
  }
  $("vizQualityHint").textContent =
    QUALITY_OPTIONS.find((q) => q.id === vizQuality)?.hint ?? "";
}

const vizPaletteToggle = $("vizPaletteToggle") as HTMLInputElement;
vizPaletteToggle.addEventListener("change", () => {
  visualizer.setUsePalette(vizPaletteToggle.checked);
  window.cinnamon.setPref("vizPalette", vizPaletteToggle.checked);
});

function buildLayoutPickers() {
  const seg = $("immLayoutPicker");
  seg.innerHTML = "";
  const layouts: [Prefs["immLayout"], string][] = [
    ["full", "Full"],
    ["player", "No lyrics"],
    ["minimal", "Visualizer only"],
  ];
  for (const [id, label] of layouts) {
    const b = document.createElement("button");
    b.textContent = label;
    b.className = id === immLayout ? "selected" : "";
    b.addEventListener("click", () => setImmLayout(id));
    seg.appendChild(b);
  }

  const corners = $("captionPosPicker");
  corners.innerHTML = "";
  const names = { tl: "Top left", tr: "Top right", bl: "Bottom left", br: "Bottom right" };
  for (const pos of ["tl", "tr", "bl", "br"] as const) {
    const b = document.createElement("button");
    b.dataset.pos = pos;
    b.title = names[pos];
    b.className = pos === captionPos ? "selected" : "";
    b.addEventListener("click", () => {
      captionPos = pos;
      applyImmLayout();
      window.cinnamon.setPref("captionPos", pos);
    });
    corners.appendChild(b);
  }
}

const vizDevice = $("vizDevice") as HTMLSelectElement;
const vizLevel = $("vizLevel");

async function populateAudioSources(selected: string) {
  const sources = await listAudioInputs();
  vizDevice.innerHTML = "";
  for (const s of sources) {
    const opt = document.createElement("option");
    opt.value = s.id;
    opt.textContent = s.label;
    if (s.id === selected) opt.selected = true;
    vizDevice.appendChild(opt);
  }
}

async function startCapture(): Promise<boolean> {
  const ok = await visualizer.enableAudio(vizDevice.value || "loopback");
  if (!ok) {
    vizAudioToggle.checked = false;
    showToast("Couldn't capture that audio source. Try another.");
  }
  return ok;
}

vizAudioToggle.addEventListener("change", async () => {
  if (vizAudioToggle.checked) {
    await startCapture();
    // Labels only resolve once permission is granted, so refresh the list.
    await populateAudioSources(vizDevice.value);
  } else {
    visualizer.disableAudio();
  }
  await window.cinnamon.setVisualizerAudio(vizAudioToggle.checked);
});

vizDevice.addEventListener("change", async () => {
  await window.cinnamon.setVisualizerAudioDevice(vizDevice.value);
  if (vizAudioToggle.checked) await startCapture(); // re-open on the new source
});

const BOOST_OPTIONS: { id: Boost; label: string; hint: string }[] = [
  { id: "off", label: "Off", hint: "Uses the input exactly as captured." },
  { id: "auto", label: "Auto", hint: "Lifts quiet input up to 6×, and backs off on loud tracks." },
  { id: "2", label: "2×", hint: "Always doubles the input." },
  { id: "4", label: "4×", hint: "For quiet sources, like a mixer bus turned down low." },
  { id: "8", label: "8×", hint: "For very quiet sources. Loud tracks will look compressed." },
];
let vizBoost: Boost = "auto";

function buildBoostPicker() {
  const seg = $("vizBoost");
  seg.innerHTML = "";
  for (const o of BOOST_OPTIONS) {
    const b = document.createElement("button");
    b.textContent = o.label;
    b.className = o.id === vizBoost ? "selected" : "";
    b.addEventListener("click", () => {
      vizBoost = o.id;
      visualizer.setBoost(o.id);
      window.cinnamon.setPref("vizBoost", o.id);
      buildBoostPicker();
    });
    seg.appendChild(b);
  }
  $("vizBoostHint").textContent = BOOST_OPTIONS.find((o) => o.id === vizBoost)?.hint ?? "";
}

// Live input meter: the quickest way to tell whether the chosen source
// actually carries the music (crucial with virtual mixers). Shows the level
// after boost, plus how much boost is being applied.
const vizGain = $("vizGain");
setInterval(() => {
  visualizer.pumpAudio(0.1); // keeps boost live while fullscreen is closed
  const active = visualizer.audioActive;
  const gain = visualizer.gain;
  const width = `${active ? Math.round(Math.min(1, visualizer.level * gain) * 100) : 0}%`;
  vizLevel.style.width = width;
  $("onboardLevel").style.width = width;
  vizGain.textContent = active && gain > 1.05 ? `×${gain.toFixed(1)}` : "";
}, 100);

// ---- visualizer auto-switch ----
const CYCLE_OPTIONS: { id: Prefs["vizCycle"]; label: string; hint: string }[] = [
  { id: "off", label: "Off", hint: "Stays on the visualizer you pick." },
  { id: "track", label: "Each track", hint: "A different visualizer every song." },
  { id: "album", label: "Each album", hint: "A new visualizer when the album changes." },
];

function buildCyclePicker() {
  const seg = $("vizCycle");
  seg.innerHTML = "";
  for (const o of CYCLE_OPTIONS) {
    const b = document.createElement("button");
    b.textContent = o.label;
    b.className = o.id === vizCycle ? "selected" : "";
    b.addEventListener("click", () => {
      vizCycle = o.id;
      window.cinnamon.setPref("vizCycle", o.id);
      buildCyclePicker();
    });
    seg.appendChild(b);
  }
  $("vizCycleHint").textContent = CYCLE_OPTIONS.find((o) => o.id === vizCycle)?.hint ?? "";
}

// ---- love + play count ----
let trackInfo: TrackInfo | null = null;
const loveBtns = [$("loveBtn"), $("immLoveBtn")];

function playsText(n: number): string {
  // Last.fm's count doesn't include the play in progress.
  if (n === 0) return "First listen";
  return n === 1 ? "1 play" : `${n.toLocaleString()} plays`;
}

function renderTrackInfo() {
  const show = !!trackInfo && trackInfo.track === currentTrack;
  for (const id of ["trackExtra", "immTrackExtra"]) $(id).classList.toggle("hidden", !show);
  if (!show) return;
  for (const b of loveBtns) {
    b.classList.toggle("loved", trackInfo!.loved);
    b.title = trackInfo!.loved ? "Loved on Last.fm (click to unlove)" : "Love on Last.fm";
  }
  $("plays").textContent = playsText(trackInfo!.playcount);
  $("immPlays").textContent = playsText(trackInfo!.playcount);
}

window.cinnamon.onTrackInfo((info) => {
  trackInfo = info;
  renderTrackInfo();
});

for (const b of loveBtns) {
  b.addEventListener("click", async () => {
    if (!trackInfo) return;
    const next = !trackInfo.loved;
    trackInfo = { ...trackInfo, loved: next }; // optimistic
    renderTrackInfo();
    if (next) {
      for (const x of loveBtns) {
        x.classList.remove("pop");
        void x.offsetWidth;
        x.classList.add("pop");
      }
    }
    try {
      await window.cinnamon.setLoved(next);
    } catch {
      trackInfo = { ...trackInfo!, loved: !next };
      renderTrackInfo();
      showToast("Couldn't reach Last.fm, try again");
    }
  });
}

// ---- sleep timer ----
let sleepStatus: SleepStatus = {};
const sleepBtn = $("sleepBtn");
const sleepMenu = $("sleepMenu");
const SLEEP_OPTIONS: [string, number | "track" | null][] = [
  ["15 minutes", 15],
  ["30 minutes", 30],
  ["45 minutes", 45],
  ["1 hour", 60],
  ["End of track", "track"],
  ["Off", null],
];

function buildSleepMenu() {
  sleepMenu.innerHTML = "";
  for (const [label, v] of SLEEP_OPTIONS) {
    if (v === null && !sleepStatus.endsAt && !sleepStatus.endOfTrack) continue;
    const b = document.createElement("button");
    b.textContent = label;
    if (v === "track" && sleepStatus.endOfTrack) b.className = "selected";
    b.addEventListener("click", () => {
      sleepMenu.classList.remove("open");
      window.cinnamon.setSleep(v);
    });
    sleepMenu.appendChild(b);
  }
}

function renderSleepLabel() {
  const label = $("sleepLabel");
  const on = !!(sleepStatus.endsAt || sleepStatus.endOfTrack);
  sleepBtn.classList.toggle("active", on);
  if (sleepStatus.endOfTrack) label.textContent = "End";
  else if (sleepStatus.endsAt) {
    const left = Math.max(0, sleepStatus.endsAt - Date.now());
    const m = Math.floor(left / 60000);
    const sec = Math.floor((left % 60000) / 1000);
    label.textContent = m >= 1 ? `${m}m` : `0:${String(sec).padStart(2, "0")}`;
  } else label.textContent = "";
  sleepBtn.title = on ? "Sleep timer on (click to change)" : "Sleep timer";
}

sleepBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  buildSleepMenu();
  sleepMenu.classList.toggle("open");
});
document.addEventListener("click", (e) => {
  if (!sleepMenu.contains(e.target as Node)) sleepMenu.classList.remove("open");
});
window.cinnamon.onSleep((st) => {
  const wasOn = !!(sleepStatus.endsAt || sleepStatus.endOfTrack);
  sleepStatus = st;
  renderSleepLabel();
  if (st.endsAt) showToast("Sleep timer set");
  else if (st.endOfTrack) showToast("Pausing after this track");
  else if (wasOn) showToast("Sleep timer off");
});
setInterval(renderSleepLabel, 1000);

// ---- updates ----
function renderUpdate(u: UpdateStatus) {
  const text: Record<UpdateStatus["state"], string> = {
    dev: "Updates: off in dev builds",
    idle: "Updates: not checked yet",
    checking: "Updates: checking…",
    none: "Up to date",
    downloading: `Downloading ${u.version ?? "update"}… ${u.percent ?? 0}%`,
    ready: `Version ${u.version} is ready to install`,
    error: "Update check failed. See logs.",
  };
  $("updateStatus").textContent = text[u.state];
  ($("checkUpdatesBtn") as HTMLButtonElement).disabled =
    u.state === "dev" || u.state === "checking" || u.state === "downloading";
  $("updateBanner").classList.toggle("show", u.state === "ready");
  $("updateBannerText").textContent = `Cinnamon ${u.version ?? ""} is ready`;
}
window.cinnamon.onUpdate(renderUpdate);
$("checkUpdatesBtn").addEventListener("click", () => window.cinnamon.checkForUpdates());
$("updateBannerBtn").addEventListener("click", () => window.cinnamon.installUpdate());

// ---- diagnostics ----
$("diagnosticsBtn").addEventListener("click", async () => {
  await window.cinnamon.copyDiagnostics({
    visualizer: vizMode,
    quality: vizQuality,
    webgl: visualizer.glSupported,
    audioCapture: visualizer.audioActive,
    audioSource: vizDevice.selectedOptions[0]?.textContent ?? vizDevice.value,
    boost: vizBoost,
    gain: visualizer.gain,
    level: visualizer.level,
    immersive: immersiveOpen,
    lyrics: lyrics ? (lyrics.synced ? "synced" : "plain") : "none",
    screen: `${screen.width}×${screen.height} @ ${window.devicePixelRatio}x`,
  });
  showToast("Diagnostics copied. Paste them into your bug report.");
});

// ---- floating lyrics ----
const floatToggle = $("floatToggle") as HTMLInputElement;
const floatLockToggle = $("floatLockToggle") as HTMLInputElement;
let floatSize: Prefs["floatingSize"] = "m";

floatToggle.addEventListener("change", () =>
  window.cinnamon.setPref("floatingLyrics", floatToggle.checked)
);
floatLockToggle.addEventListener("change", () =>
  window.cinnamon.setPref("floatingLocked", floatLockToggle.checked)
);

function buildFloatSize() {
  const seg = $("floatSize");
  seg.innerHTML = "";
  for (const [id, label] of [["s", "Small"], ["m", "Medium"], ["l", "Large"]] as const) {
    const b = document.createElement("button");
    b.textContent = label;
    b.className = id === floatSize ? "selected" : "";
    b.addEventListener("click", () => {
      floatSize = id;
      window.cinnamon.setPref("floatingSize", id);
      buildFloatSize();
    });
    seg.appendChild(b);
  }
}

// ---- global shortcuts ----
const hotkeysToggle = $("hotkeysToggle") as HTMLInputElement;
hotkeysToggle.addEventListener("change", () =>
  window.cinnamon.setPref("hotkeys", hotkeysToggle.checked)
);

function buildHotkeyList() {
  const list = $("hotkeyList");
  list.innerHTML = "";
  for (const h of HOTKEYS) {
    const key = document.createElement("kbd");
    key.textContent = h.accel.replace("Control", "Ctrl").replace("Right", "→").replace("Left", "←");
    const label = document.createElement("span");
    label.textContent = h.label;
    list.append(key, label);
  }
  list.classList.toggle("off", !hotkeysToggle.checked);
}

// Tray and hotkeys change these from outside the window, so keep controls in step.
window.cinnamon.onPrefs((p) => {
  floatToggle.checked = p.floatingLyrics;
  floatLockToggle.checked = p.floatingLocked;
  floatSize = p.floatingSize;
  buildFloatSize();
  hotkeysToggle.checked = p.hotkeys;
  buildHotkeyList();
});

// ---- first-run setup ----
const onboardEl = $("onboard");
const ONBOARD_STEPS = 5;
let onboardStep = 0;

function showOnboardStep(i: number) {
  onboardStep = Math.max(0, Math.min(ONBOARD_STEPS - 1, i));
  onboardEl.querySelectorAll<HTMLElement>(".onboard-step").forEach((el) => {
    el.classList.toggle("active", Number(el.dataset.step) === onboardStep);
  });
  $("onboardDots").innerHTML = Array.from(
    { length: ONBOARD_STEPS },
    (_, k) => `<span class="${k === onboardStep ? "active" : ""}"></span>`
  ).join("");
  ($("onboardBack") as HTMLButtonElement).style.visibility = onboardStep === 0 ? "hidden" : "visible";
  $("onboardNext").textContent = onboardStep === ONBOARD_STEPS - 1 ? "START LISTENING" : "NEXT";
  $("onboardSkip").style.visibility = onboardStep === ONBOARD_STEPS - 1 ? "hidden" : "visible";
  if (onboardStep === 2) buildThemePicker();
  if (onboardStep === 3) mirrorAudioSources();
}

function openOnboarding() {
  onboardEl.classList.add("open");
  showOnboardStep(0);
}

function finishOnboarding() {
  onboardEl.classList.remove("open");
  window.cinnamon.setPref("onboarded", true);
}

$("onboardNext").addEventListener("click", () => {
  if (onboardStep === ONBOARD_STEPS - 1) finishOnboarding();
  else showOnboardStep(onboardStep + 1);
});
$("onboardBack").addEventListener("click", () => showOnboardStep(onboardStep - 1));
$("onboardSkip").addEventListener("click", finishOnboarding);
$("rerunSetupBtn").addEventListener("click", openOnboarding);

// The setup page drives the real settings controls, so both stay in sync.
const onboardAudio = $("onboardAudioToggle") as HTMLInputElement;
const onboardDevice = $("onboardDevice") as HTMLSelectElement;

function mirrorAudioSources() {
  onboardDevice.innerHTML = vizDevice.innerHTML;
  onboardDevice.value = vizDevice.value;
  onboardAudio.checked = vizAudioToggle.checked;
}
onboardAudio.addEventListener("change", async () => {
  vizAudioToggle.checked = onboardAudio.checked;
  vizAudioToggle.dispatchEvent(new Event("change"));
  // Device names only resolve once capture is allowed; refresh after it opens.
  setTimeout(mirrorAudioSources, 800);
});
onboardDevice.addEventListener("change", () => {
  vizDevice.value = onboardDevice.value;
  vizDevice.dispatchEvent(new Event("change"));
});

const onboardLastfmBtn = $("onboardLastfmBtn") as HTMLButtonElement;
onboardLastfmBtn.addEventListener("click", () => lastfmBtn.click());

const discordToggle = $("discordToggle") as HTMLInputElement;
const discordClientId = $("discordClientId") as HTMLInputElement;
discordToggle.addEventListener("change", () =>
  window.cinnamon.setDiscordEnabled(discordToggle.checked)
);
discordClientId.addEventListener("change", async () => {
  const ok = await window.cinnamon.setDiscordClientId(discordClientId.value);
  if (!ok) showToast("That doesn't look like a Discord application ID (numbers only)");
});
const discordCustomToggle = $("discordCustomToggle") as HTMLInputElement;
discordCustomToggle.addEventListener("change", () => {
  $("discordCustomBox").style.display = discordCustomToggle.checked ? "" : "none";
  window.cinnamon.setDiscordCustom(discordCustomToggle.checked);
});

// Discord presence customization
const dName = $("discordName") as HTMLInputElement;
const dDetail = $("discordDetail") as HTMLInputElement;
const dState = $("discordState") as HTMLInputElement;
const dArt = $("discordArt") as HTMLInputElement;
const dProgress = $("discordProgress") as HTMLInputElement;
const dPaused = $("discordPaused") as HTMLInputElement;
const dButton = $("discordButton") as HTMLInputElement;

function pushDiscordConfig() {
  window.cinnamon.setDiscordConfig({
    name: dName.value,
    detail: dDetail.value,
    state: dState.value,
    showArt: dArt.checked,
    showProgress: dProgress.checked,
    showPaused: dPaused.checked,
    showButton: dButton.checked,
  });
}
for (const el of [dName, dDetail, dState])
  el.addEventListener("change", pushDiscordConfig);
for (const el of [dArt, dProgress, dPaused, dButton])
  el.addEventListener("change", pushDiscordConfig);

$("openDataBtn").addEventListener("click", () =>
  window.cinnamon.openDataFolder()
);

const logPanel = $("logPanel");
const toggleLogsBtn = $("toggleLogsBtn");
let logsOpen = false;
toggleLogsBtn.addEventListener("click", async () => {
  logsOpen = !logsOpen;
  logPanel.style.display = logsOpen ? "block" : "none";
  if (logsOpen) {
    logPanel.textContent = await window.cinnamon.getLogs();
    logPanel.scrollTop = logPanel.scrollHeight;
  }
});
window.cinnamon.onLog((line) => {
  if (!logsOpen) return;
  logPanel.textContent += (logPanel.textContent ? "\n" : "") + line;
  logPanel.scrollTop = logPanel.scrollHeight;
});

// ---- lyric offset ----
const offsetLabel = $("offsetLabel");
function updateOffsetLabel() {
  const sign = lyricOffset > 0 ? "+" : "";
  offsetLabel.textContent = `sync ${sign}${lyricOffset.toFixed(1)}s`;
}
function nudgeOffset(delta: number) {
  lyricOffset = Math.round((lyricOffset + delta) * 10) / 10;
  updateOffsetLabel();
  window.cinnamon.setLyricOffset(lyricOffset);
}
$("offsetDown").addEventListener("click", () => nudgeOffset(-0.5));
$("offsetUp").addEventListener("click", () => nudgeOffset(0.5));

// ---- boot ----
(async () => {
  const settings = await window.cinnamon.getSettings();
  customThemes = settings.customThemes;
  setCustomThemes(customThemes); // before applyTheme, so a custom pick resolves
  selectedTheme = settings.theme;
  applyTheme(settings.theme);
  if (isDynamic(settings.theme)) applyDynamicAccent();
  startupToggle.checked = settings.startWithWindows;
  closeTrayToggle.checked = settings.closeToTray;
  notifyToggle.checked = settings.notifyTrack;

  vizMode = normalizeMode(settings.visualizer);
  visualizer.setMode(vizMode);
  if (vizMode !== settings.visualizer) window.cinnamon.setVisualizer(vizMode); // retired mode
  visualizer.syncAccent();
  $("immVizName").textContent = vizName(vizMode);
  buildVizPicker();

  vizQuality = settings.vizQuality;
  visualizer.setQuality(vizQuality);
  buildQualityPicker();
  vizPaletteToggle.checked = settings.vizPalette;
  visualizer.setUsePalette(settings.vizPalette);
  vizBoost = settings.vizBoost;
  visualizer.setBoost(vizBoost);
  buildBoostPicker();
  vizCycle = settings.vizCycle;
  buildCyclePicker();
  karaokeOn = settings.karaoke;
  renderKaraokeControls();

  floatToggle.checked = settings.floatingLyrics;
  floatLockToggle.checked = settings.floatingLocked;
  floatSize = settings.floatingSize;
  buildFloatSize();
  hotkeysToggle.checked = settings.hotkeys;
  buildHotkeyList();

  immLayout = settings.immLayout;
  lastWithPlayer = immLayout === "minimal" ? "full" : immLayout;
  captionPos = settings.captionPos;
  applyImmLayout();
  vizAudioToggle.checked = settings.visualizerAudio;
  await populateAudioSources(settings.visualizerAudioDevice);
  if (settings.visualizerAudio) {
    // If capture is refused the toggle reflects reality rather than lying.
    visualizer.enableAudio(settings.visualizerAudioDevice).then((ok) => {
      if (!ok) vizAudioToggle.checked = false;
      else populateAudioSources(settings.visualizerAudioDevice);
    });
  }
  discordToggle.checked = settings.discordEnabled;
  discordClientId.value = settings.discordClientId;
  discordCustomToggle.checked = settings.discordUseCustomId;
  $("discordCustomBox").style.display = settings.discordUseCustomId ? "" : "none";
  dName.value = settings.discord.name;
  dDetail.value = settings.discord.detail;
  dState.value = settings.discord.state;
  dArt.checked = settings.discord.showArt;
  dProgress.checked = settings.discord.showProgress;
  dPaused.checked = settings.discord.showPaused;
  dButton.checked = settings.discord.showButton;
  $("versionLabel").textContent = `v${settings.version}`;
  lyricOffset = settings.lyricOffset;
  updateOffsetLabel();
  buildThemePicker();
  if (!settings.onboarded) openOnboarding();
})();
