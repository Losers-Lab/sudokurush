/* One home for "are we inside Discord?" and for mirroring embed state onto
   <html>. Discord mobile hosts activities as a TOP-LEVEL WebView (native
   bridge, no parent frame), so the frame check alone misses phones;
   Discord's WebView announces itself in the user agent instead. CSS restyles
   off [data-embed] without knowing any of this; dark/light follows
   prefers-color-scheme, which the host WebView mirrors from the user's
   Discord theme. */

export const DISCORD_UA = /discord/i.test(navigator.userAgent);

/** Dev escape hatch (?embed=1): preview activity styling in a plain browser,
    same spirit as the #solo/#play demo hashes. */
const EMBED_PARAM = new URLSearchParams(window.location.search).get("embed");

export function isEmbedded(): boolean {
  return window.frameElement !== null || DISCORD_UA || EMBED_PARAM === "1";
}

/** Stamp embed state on <html> as early as possible so even the boot screen
    renders in host styling. */
export function stampEmbedAttributes(): void {
  if (!isEmbedded()) {
    return;
  }
  document.documentElement.dataset.embed = "discord";
}
