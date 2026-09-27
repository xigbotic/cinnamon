import { globalShortcut } from "electron";
import { HOTKEYS, type HotkeyAction } from "../../shared/hotkeys";

/** One handler per shortcut in HOTKEYS. */
export type HotkeyActions = Record<HotkeyAction, () => void>;

export function setHotkeys(enabled: boolean, actions: HotkeyActions) {
  globalShortcut.unregisterAll();
  if (!enabled) return;
  for (const h of HOTKEYS) {
    // Fails if another app already owns the combination; the rest still work.
    if (!globalShortcut.register(h.accel, () => actions[h.action]())) {
      console.warn(`[hotkeys] ${h.accel} is taken by another app`);
    }
  }
}
