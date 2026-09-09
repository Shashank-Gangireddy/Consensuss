<img src="icons/icon128.png" width="64" height="64" alt="Consensus icon" />

# Consensus

A Chrome/Brave/Edge extension (Manifest V3) that rates whether a YouTube
video's title claim holds up against what commenters actually reported.
It scrapes up to 200 top-level comments straight from the page, sends
them with the title to your own LLM API key, and returns a 1-10 rating,
a verdict, and the supporting/contradicting points behind it, without
letting one loud comment or a wall of copy-paste replies skew the score.

**Live on the Chrome Web Store** · [consensuss.lol](https://consensuss.lol)

## Screenshots

<!-- TODO: add screenshots -->

## How it works

1. On a YouTube `/watch` page, a badge appears next to the video title.
2. Click it (or use the toolbar popup) to scroll through and scrape the
   first ~40-200 top-level comments directly from the page DOM — no
   YouTube Data API, no Google Cloud key or quota needed.
3. The title + comments are sent to your chosen LLM provider (OpenAI,
   Anthropic, or Gemini) using an API key you supply and that never
   leaves your browser except to call that provider directly.
4. The model returns:
   - a **1-10 rating** and a **verdict** (Confirmed / Mixed / Debunked / etc.)
   - a plain-language summary with supporting/contradicting points
   - a **Disputed** flag when support and contradiction are both
     substantial, so a genuinely split audience isn't averaged into a
     falsely confident middle score
   - a separate **authenticity flag** for corroborated concerns (staged
     content, bought engagement) without letting that override the
     claim rating on its own

Comment ranking merges near-duplicate/echo replies into a single point of
evidence, and enforces a minimum-sample floor (fewer than 6 usable
comments forces "Insufficient Evidence") — both borrowed from how Reddit
(Wilson score confidence, Controversial-sort polarization) and Steam
(review-count gating) handle consensus at scale.

## Setup

1. Go to `chrome://extensions` (or `brave://extensions`).
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select this repo's folder.
4. Click the extension icon → gear icon → enter your API key for
   OpenAI, Anthropic, or Gemini (only one provider is needed). Save.
5. Open any YouTube video and click **Rate this claim**.

If you'd rather skip the manual steps, install the packaged version from
the [Chrome Web Store](https://consensuss.lol) instead.

## Privacy & security

- **No backend.** Nothing is sent to a server the developer runs; your
  API key and requests go straight from your browser to
  OpenAI/Anthropic/Gemini.
- API keys are stored in `chrome.storage.local` (this browser only, not
  synced).
- Reddit cross-check requests are sent with `credentials: 'include'`,
  which means they carry whatever `reddit.com` session cookie already
  exists in your browser — if you're logged into Reddit, those requests
  are attributable to your account like any other `reddit.com` tab, even
  though no login is required to use the extension. No credential is
  read or stored by Consensus itself.
- Audited against OWASP's Browser Extension Vulnerabilities Cheat Sheet
  and Chrome MV3 guidance: `postMessage` origin validation, message
  sender verification, output escaping before any HTML insertion, a
  global rate limit against runaway paid LLM calls, and explicit
  `content_security_policy`. Full detail on the
  [public Security page](https://consensuss.lol/security/).

## Repo layout

| File | Purpose |
|---|---|
| `manifest.json` | Extension manifest (permissions, CSP, entry points) |
| `content.js` / `page-bridge.js` | Runs on YouTube pages: finds the title, scrapes comments, injects the badge |
| `background.js` | Service worker: calls the LLM provider and Reddit, rate limiting |
| `popup.html/js/css` | Toolbar popup UI |
| `dashboard.html/js/css` | Full analysis history, CSV export, Learned Guidance management |
| `options.html/js/css` | API key / provider settings |
| `guidance-seed.json` | Optional baseline "Learned Guidance" rules bundled into fresh installs |
| `build.sh` | Builds a versioned, store-ready `.zip` from `manifest.json`'s version |
| `CHANGELOG.md` | Version history |

## Building a release zip

```bash
./build.sh
```

Reads the version from `manifest.json`, refuses to overwrite an existing
zip, and produces `consensus-extension-<version>.zip` ready for upload to
the Chrome Web Store Developer Dashboard.

## Carrying Learned Guidance to another device

The dashboard's **Learned Guidance** panel holds rules distilled from
your corrections (via "Redo w/ note"), applied to every future analysis.
It lives in `chrome.storage.local`, so it's local to one browser by
default:

- **Export / Import (any time):** on the dashboard, "Export Guidance"
  downloads the current rule set as JSON; "Import Guidance" on another
  device merges it in, skipping near-duplicate rules automatically.
- **Bundled seed (new installs):** overwrite `guidance-seed.json` with an
  exported guidance JSON before loading the extension to give every
  fresh install that baseline — applied once, only if that device's
  guidance store is empty.

## Limitations

- Comment scraping reads whatever YouTube has rendered in the DOM after
  auto-scrolling; sparsely-commented or comments-disabled videos yield
  little signal.
- Ratings are only as good as the comment sample and the LLM's judgment,
  so treat this as a leading indicator, not a fact-check.
- YouTube's DOM structure changes periodically; if the badge or comment
  scraping stops working, check the selectors in `content.js`
  (`getTitle`, `findTitleAnchor`, `scrapeVisibleComments`) first.

## Links

- Website: [consensuss.lol](https://consensuss.lol)
- FAQ: [consensuss.lol/faq](https://consensuss.lol/faq/)
- Security: [consensuss.lol/security](https://consensuss.lol/security/)
- Privacy Policy: [consensuss.lol/privacy](https://consensuss.lol/privacy/)
