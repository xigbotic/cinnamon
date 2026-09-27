export type HotkeyAction =
  | "playPause"
  | "next"
  | "prev"
  | "love"
  | "toggleFloating"
  | "toggleMini"
  | "showMain";

/**
 * System-wide shortcuts. Ctrl+Alt combinations rather than the media keys:
 * Apple Music already answers the media keys itself, and registering them here
 * would steal them from it.
 */
export const HOTKEYS: { accel: string; label: string; action: HotkeyAction }[] = [
  { accel: "Control+Alt+Space", label: "Play / pause", action: "playPause" },
  { accel: "Control+Alt+Right", label: "Next track", action: "next" },
  { accel: "Control+Alt+Left", label: "Previous track", action: "prev" },
  { accel: "Control+Alt+L", label: "Love / unlove on Last.fm", action: "love" },
  { accel: "Control+Alt+O", label: "Floating lyrics", action: "toggleFloating" },
  { accel: "Control+Alt+M", label: "Mini player", action: "toggleMini" },
  { accel: "Control+Alt+C", label: "Show Cinnamon", action: "showMain" },
];
