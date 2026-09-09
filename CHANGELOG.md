# Changelog

All notable changes to the Consensus extension are logged here. Bump the
version in `manifest.json` alongside every entry — the Chrome Web Store
rejects a re-upload with an unchanged version number.

## [3.8.1] - 2026-09-09
- **Fixed a "No JSON object found in model response" error** that could
  fire even on a healthy 200 response, with no clue why. Root cause: the
  Anthropic call used a hardcoded `max_tokens: 1024`, which some
  models/responses exceed — the response gets cut off mid-JSON-object
  before the closing `}`, and the old `extractJson()` just reported "no
  JSON object found" (or a bare `SyntaxError` if a stray `}` from a nested
  field happened to be present) with no indication it was a token-budget
  problem, and no visibility into what the model actually sent.
  - Raised Anthropic's `max_tokens` from 1024 to 4096.
  - All three providers (OpenAI `finish_reason`, Anthropic `stop_reason`,
    Gemini `finishReason`) are now checked for a `MAX_TOKENS`/`length`
    cutoff *before* attempting to parse, and raise a specific "response
    was cut off" error instead of falling through to a generic JSON error.
  - OpenAI/Gemini content-filter and safety-block cases are now also
    named explicitly instead of falling through to the same generic path.
  - `extractJson()` now always includes a snippet of the actual raw model
    output in its error message (previously logged nothing), and
    distinguishes "no `{`/`}` found at all" from "found braces but
    `JSON.parse` still failed" (most likely truncation mid-object).
- No new permissions, host_permissions, or CSP changes — logic-only.

## [3.8.0] - 2026-09-09
- **Removed hardcoded default models.** Previously, leaving the Model field
  blank in Options silently fell back to a per-provider default
  (`gpt-4o-mini` / `claude-3-5-haiku-20241022` / `gemini-1.5-flash`). The
  Anthropic default had been retired by Anthropic and returned a 404 on
  every call, which — combined with the old `callAnthropic` swallowing a
  non-text response into a bare "Empty model response" — made the real
  cause invisible. Providers can retire/rename model ids at any time, so
  guessing one is inherently fragile. Now:
  - There is no default for any provider. `background.js` calls
    `requireModel()` before ever attempting an LLM request; if no model is
    saved, the error is immediately actionable ("No model selected. Open
    the extension options, fetch available models for your provider, and
    choose one.") instead of a silent bad guess or a generic failure two
    layers downstream.
  - The Model field in Options is now marked required (`required` HTML
    attribute + Save-time validation), and the help text explains why
    there's no default and points at "Fetch available models".
  - `callAnthropic` also now inspects `stop_reason` and content block
    types when a 200 response contains no usable text (e.g. a safety
    refusal or `max_tokens` cutoff before any text block) and reports the
    specific reason instead of a bare "Empty model response".
- No new permissions, host_permissions, or CSP changes — logic-only.

## [3.7.1] - 2026-09-01
- Security hardening (proactive audit, no known incident):
  - Badge click handler now requires `event.isTrusted` — a synthetic
    click dispatched by another script sharing the YouTube page DOM (e.g.
    another extension's content script, a userscript) can no longer
    trigger analysis.
  - `videoId` is now validated against YouTube's real 11-char ID shape
    both where it's read (content.js `getVideoId`) and where it's
    received (background.js message listener) — closes a spoofed-videoId
    bypass of the per-video cooldown and removes any use of an
    attacker-controlled string as a raw cache/map key.
  - Added a GLOBAL sliding-window rate limit (12 calls/minute across all
    videos, independent of the existing per-video 5s cooldown) in
    background.js, so a loop of fake videoIds can no longer sail past the
    per-video cooldown to spam paid LLM calls and drain the user's API
    budget.
  - Both LLM system prompts now explicitly warn that the VIEWER COMMENTS
    block is untrusted, attacker-postable text and must never be treated
    as instructions; the comment block is now wrapped in an explicit
    `<viewer_comments untrusted="true">` delimiter in the user message —
    defense against prompt injection via a planted YouTube comment trying
    to manipulate the rating/verdict.
  - Fixed `escapeHtml()` in dashboard.js to also encode `"`/`'` (the
    previous textContent→innerHTML trick only encoded `&`/`<`/`>`), since
    its output is reused inside quoted HTML attribute values (e.g.
    `title="..."`) fed by LLM-generated text.
- No new permissions, host_permissions, or CSP changes — logic-only.

## [3.7.0] - 2026-08-29
- Comment-selection logic reworked based on Reddit/Steam consensus-ranking
  research (Wilson score confidence intervals, Steam review-count gating):
  - **Near-duplicate clustering**: comments whose wording is highly
    similar (word-overlap ≥ 0.55, reusing the existing guidance-dedup
    similarity function) are merged into one cluster before ranking, so
    copy-paste/echo replies count as one point of evidence — not N
    independent commenters — while still surfacing "~N near-identical
    comments echoing this" to the LLM so it isn't blind to genuine volume.
  - **Deterministic minimum-sample floor for the claim path**: below
    `MIN_COMMENTS_FOR_CLAIM_VERDICT` (6) analyzed comments, verdict is
    forced to "Insufficient Evidence" regardless of what the model
    returned — same floor already existed for the vibes path, now applied
    consistently to claim ratings too.
  - **"Disputed" flag**: when supporting and contradicting points are both
    substantial and roughly balanced, `result.contested` is set (shown as
    a badge in the popup and a dashboard/CSV column) — separates "actively
    disputed" from "thin/mixed evidence," mirroring Reddit's
    Controversial-sort principle of treating polarization as its own
    signal rather than averaging it away.
- No new permissions, host_permissions, or CSP changes — logic-only.

## [3.6.2] - 2026-08-27
- Current published/publish-ready baseline.
- Security hardening: restricted `postMessage` target origin + origin
  validation on receipt, `sender.id` validation in the background worker,
  HTML-escaping of `videoUrl`/`provider`/`model` fields, explicit
  `content_security_policy`, per-minute rate limit on `ANALYZE_CLAIM`.

<!--
## [X.Y.Z] - YYYY-MM-DD
### Added / Changed / Fixed
- ...
-->
