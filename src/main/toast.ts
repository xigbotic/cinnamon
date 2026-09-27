const xmlEscape = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    // Control characters are invalid in XML 1.0 and make Windows reject the toast.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");

/**
 * Windows toast layout for a track: title, artist, and the album as the
 * smaller attribution line, with the cover as a square app logo.
 */
export function trackToastXml(track: string, artist: string, album: string, coverPath: string): string {
  const lines = [
    `<text hint-maxLines="1">${xmlEscape(track)}</text>`,
    artist ? `<text hint-maxLines="1">${xmlEscape(artist)}</text>` : "",
    album ? `<text placement="attribution">${xmlEscape(album)}</text>` : "",
    `<image placement="appLogoOverride" src="${xmlEscape(coverPath)}"/>`,
  ].join("");
  return `<toast><visual><binding template="ToastGeneric">${lines}</binding></visual><audio silent="true"/></toast>`;
}
