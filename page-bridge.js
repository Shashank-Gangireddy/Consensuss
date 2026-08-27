// page-bridge.js — runs in the PAGE's own JS context (MAIN world), not the
// extension's isolated content-script world. This is the only way to read
// window.ytInitialData / window.ytcfg, which YouTube's SPA keeps updated on
// every in-page navigation.
//
// Handshake strategy: PUBLISH the extracted context to a DOM attribute
// (document.documentElement.dataset.ycrContext) rather than relying purely
// on request/response postMessage. The DOM is shared between the MAIN world
// and the extension's isolated world even though `window` isn't, so
// content.js can read this attribute directly and synchronously — no
// listener-registration race, no "message never arrived" timeout. We still
// answer postMessage requests too, as a fallback path.
//
// SECURITY: this bridge only ever handles YouTube's own PUBLIC page data
// (ytcfg/ytInitialData — visible to anyone via view-source, not a secret),
// so there's nothing sensitive to leak here. The residual risk is a
// same-tab message-spoofing attack (e.g. a compromised/malicious script
// somehow running in this exact page context sends a forged
// YCR_YT_CONTEXT reply to influence what content.js reads) — mitigated by
// checking event.origin against an explicit allowlist matching this
// extension's own content_scripts.matches, on top of the existing
// event.source === window check (which already blocks cross-frame/
// cross-window senders, e.g. an embedded ad iframe on the same page).
// Never post secrets (API keys, tokens) through this channel even though
// none currently flow through it — postMessage is inherently observable by
// any script sharing the page.

(function () {
  if (window.__ycrBridgeInstalled) return;
  window.__ycrBridgeInstalled = true;

  const ALLOWED_ORIGINS = new Set(['https://www.youtube.com']);

  function readContext() {
    let payload = null;
    let error = null;
    try {
      const cfg = window.ytcfg;
      const apiKey = cfg && cfg.get ? cfg.get('INNERTUBE_API_KEY') : null;
      const context = cfg && cfg.get ? cfg.get('INNERTUBE_CONTEXT') : null;
      const clientVersion = cfg && cfg.get ? cfg.get('INNERTUBE_CLIENT_VERSION') : null;
      const initialData = window.ytInitialData || null;

      // Category + tags cost nothing to grab here and let us skip an LLM
      // call for basic topic classification (Gaming, Music, Howto & Style,
      // Science & Technology, etc. — YouTube's own official taxonomy).
      //
      // CRITICAL: window.ytInitialPlayerResponse is populated ONLY on a
      // hard page load and goes fully undefined after YouTube's SPA
      // (client-side) navigation to a different video — confirmed live:
      // clicking a search result / related video leaves it `undefined`,
      // even though the page has visibly moved to the new video and
      // window.ytInitialData (used elsewhere in this file) DOES update
      // correctly. Since most real usage reaches a video via in-app
      // navigation, not a pasted URL, relying on ytInitialPlayerResponse
      // alone meant category/keywords silently came back null for most
      // videos, which routed them to the consensus path by default
      // instead of vibes regardless of actual category (decidePath()
      // treats an unreadable category as consensus). The player element's
      // own getPlayerResponse() method DOES stay live across SPA nav and
      // exposes the identical microformat/videoDetails shape — prefer it,
      // falling back to the static global only if the player element
      // isn't mounted yet (e.g. very first publish() call before the
      // page has fully rendered).
      let playerResponse = window.ytInitialPlayerResponse || null;
      try {
        const playerEl = document.getElementById('movie_player');
        if (playerEl && typeof playerEl.getPlayerResponse === 'function') {
          const live = playerEl.getPlayerResponse();
          if (live && live.microformat) playerResponse = live;
        }
      } catch (e) {
        // getPlayerResponse can throw if the player isn't fully initialized
        // yet — fall through to whatever playerResponse already holds.
      }
      const microformat = playerResponse?.microformat?.playerMicroformatRenderer || null;
      const videoDetails = playerResponse?.videoDetails || null;
      const category = microformat?.category || null;
      const keywords = Array.isArray(videoDetails?.keywords) ? videoDetails.keywords : [];
      const description = microformat?.description?.simpleText || '';

      if (!apiKey || !context) {
        error = 'ytcfg not ready (apiKey/context missing)';
      } else {
        payload = { apiKey, context, clientVersion, initialData, category, keywords, description };
      }
    } catch (e) {
      error = String((e && e.message) || e);
    }
    return { payload, error };
  }

  function publish() {
    const { payload, error } = readContext();
    try {
      document.documentElement.dataset.ycrContext = JSON.stringify({ payload, error, ts: Date.now() });
    } catch (e) {
      // JSON.stringify can choke on pathological/circular page data; degrade
      // to an explicit error marker rather than leaving a stale attribute.
      document.documentElement.dataset.ycrContext = JSON.stringify({
        payload: null,
        error: 'stringify failed: ' + ((e && e.message) || e),
        ts: Date.now()
      });
    }
  }

  publish();

  // ytcfg/ytInitialData populate shortly after document_start on a fresh
  // load, and ytInitialData in particular can gain the comments engagement
  // panel a little after the rest — re-publish a few times over the next
  // couple seconds to catch that, then settle into a light heartbeat so SPA
  // navigations (which don't reload this script) keep the attribute fresh.
  [50, 150, 300, 600, 1000, 2000, 3500].forEach(ms => setTimeout(publish, ms));
  document.addEventListener('yt-navigate-finish', publish);
  document.addEventListener('yt-page-data-updated', publish);
  setInterval(publish, 3000);

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (!ALLOWED_ORIGINS.has(event.origin)) return;
    const data = event.data;
    if (!data) return;

    // Explicit "publish right now" request — used by content.js when it
    // needs the freshest possible data (e.g. right after a navigation, or
    // to retry a missing comments token) rather than waiting for the next
    // scheduled publish.
    if (data.type === 'YCR_REQUEST_PUBLISH') {
      publish();
      return;
    }

    // Legacy/fallback RPC path — still answered directly for anything that
    // prefers a request/response shape over reading the DOM attribute.
    if (data.type === 'YCR_GET_YT_CONTEXT') {
      const { payload, error } = readContext();
      window.postMessage({ type: 'YCR_YT_CONTEXT', requestId: data.requestId, payload, error }, window.location.origin);
    }
  });
})();
