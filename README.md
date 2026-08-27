# Consensus

A Chrome/Brave (Manifest V3) extension that rates whether a YouTube video's
title claim holds up, based on what viewers say in the comments.

## How it works

1. On a YouTube `/watch` page, a badge appears next to the video title.
2. Click it (or use the popup) to scroll through and scrape the first ~40
   top-level comments directly from the page DOM.
3. The title + comments are sent to your chosen LLM provider (OpenAI,
   Anthropic, or Gemini — your API key, called directly from the browser).
4. The model returns a 1-10 rating, a verdict (Confirmed / Mixed / Debunked
   / etc.), a summary, and supporting/contradicting points pulled from the
   comments. This shows both as the page badge and in the toolbar popup.

## Setup

1. Go to `chrome://extensions` (or `brave://extensions`).
2. Enable "Developer mode" (top right).
3. Click "Load unpacked" and select this folder.
4. Click the extension icon → gear icon → enter your API key for
   OpenAI / Anthropic / Gemini (only one provider needed). Save.
5. Open any YouTube video and click "Rate this claim".

## Notes / limitations

- Comment scraping reads whatever YouTube has rendered in the DOM after
  auto-scrolling — it does not use the YouTube Data API, so no Google Cloud
  key/quota is needed, but very sparsely-commented or comments-disabled
  videos will yield little signal.
- Ratings are only as good as the comment sample and the LLM's judgment —
  treat this as a leading indicator, not a fact-check.
- YouTube's DOM structure changes periodically; if the badge or comment
  scraping stops working, the CSS selectors in `content.js` (`getTitle`,
  `findTitleAnchor`, `scrapeVisibleComments`) are the first place to check.
- API keys are stored in `chrome.storage.local` (this browser only, not
  synced) and called directly from your browser to the provider's API.

## Carrying Learned Guidance to another device/user

The dashboard's "Learned Guidance" panel is generalized rules distilled
from your corrections (via "Redo w/ note"), applied to every future
analysis. It lives in `chrome.storage.local`, so it's local to one browser
by default — two ways to carry it elsewhere, no server/account needed:

- **Export / Import (any time):** on the dashboard, "Export Guidance"
  downloads the current rule set as JSON; "Import Guidance" on another
  device loads that file in, merging with (not replacing) whatever rules
  already exist there — near-duplicate rules are skipped automatically.
- **Bundled seed (new installs):** `guidance-seed.json` in this folder
  ships as `[]`. Overwrite it with an exported guidance JSON before
  loading the extension unpacked (or before packaging/distributing it) to
  give every fresh install that baseline automatically — it's only
  applied once, on first install, and only if that device's guidance
  store is still empty.

