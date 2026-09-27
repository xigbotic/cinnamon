import { shell } from "electron";

/**
 * Triggers playback by handing an Apple Music deep link to the OS, which routes
 * it to the real Apple Music app. No token, no DRM: the official app plays it.
 */
export async function playDeepLink(deepLink: string): Promise<void> {
  if (!/^https:\/\/music\.apple\.com\//.test(deepLink)) {
    throw new Error(`refusing to open non-Apple-Music URL: ${deepLink}`);
  }
  await shell.openExternal(deepLink);
}
