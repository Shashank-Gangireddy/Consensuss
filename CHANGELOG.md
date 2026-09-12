# Changelog

All notable changes to the Consensus extension are logged here. Bump the
version in `manifest.json` alongside every entry — the Chrome Web Store
rejects a re-upload with an unchanged version number.

## [3.8.3] - 2026-09-12
- **Popup UI cleanup: consistent spacing and clearer top-to-bottom
  information flow**, reviewed and iterated as a design mockup
  (`design-mockup/popup-clean-scroll.html`) before landing in
  `popup.html`/`popup.css`. No behavior/logic changes — HTML ids and
  popup.js are untouched.
  - Rating hero (score/verdict) now always leads the result — previously
    the critical-flag and guidance-enforcement boxes could render above
    it, burying the anchor everything else refers back to.
  - Added a single "category · judged-on" eyebrow line directly under
    the hero (dim gray, quiet metadata) instead of two separate tag
    lines in different spots.
  - The "Disputed" badge no longer fights the giant rating number for
    the same baseline — it now stacks under the verdict, right-aligned,
    and its text is legible (fixed a pre-existing contrast bug where
    `--amber-text` made the badge's own text nearly invisible against
    its background).
  - Critical-flag, guidance-enforcement, recommendation, and Reddit
    boxes now share one box shape (radius/padding/label style), and the
    guidance-enforcement list's text now aligns flush with the
    critical-flag box's paragraph above it (previously bulleted/indented
    differently).
  - One spacing scale (4/8/12/16px) replaces the prior ad-hoc mix of
    4/6/8/10/12/14px margins across the popup.
  - Token-usage footnote is now pinned to the very bottom of the result
    as a footer, instead of appearing mid-scroll between content blocks.
- No new permissions, host_permissions, or CSP changes — CSS/HTML only.

## [3.8.2] - 2026-09-12
- **Fixed ordinary "Learned Guidance" rules incorrectly tanking ratings on
  unrelated videos**, sometimes collapsing them all the way to
  "Insufficient Evidence" despite well above the minimum-comment floor.
  Root cause: every active guidance rule (up to 25 most recent) was
  injected into the prompt as "binding" for EVERY analysis, regardless of
  whether the rule's `scope` (e.g. "Comparison", "Tutorial/Howto")
  actually matched the video being rated — a rule learned from one
  Advice/Opinion video's correction could get force-applied to a
  completely unrelated Tutorial or Product Review, plus a code-side
  penalty for any "unresolved" rule the model didn't apply on top.
  - **Ordinary (non-critical) guidance rules are no longer shown to the
    model before it rates a video.** The model now judges purely from
    the video's title/category/tags and the comment evidence, using the
    existing weighted-evidence rules already in the system prompt
    (breadth-over-intensity, near-duplicate clustering, evidence-volume
    tiering, minimum-sample floor).
  - **Guidance is now matched deterministically AFTER the model
    responds**, against its already-formed result: a rule only applies
    if its `scope` fits the model's own classified `video_format`
    (or is `global`) AND its wording substantively overlaps what the
    model actually wrote in its summary/contradicting points. Only a
    genuine match applies a rating penalty.
  - **CRITICAL (creator-genuineness) guidance is unchanged** — still
    shown to the model up front, since it benefits from the model
    actively watching for a specific red flag (staged content, bought
    engagement) while forming its judgment.
  - Removed the `guidance_impact` self-report schema field (the model no
    longer sees ordinary guidance, so it has nothing to self-report on).
- No new permissions, host_permissions, or CSP changes — logic-only.

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
