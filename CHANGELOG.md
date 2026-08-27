# Changelog

All notable changes to the Consensus extension are logged here. Bump the
version in `manifest.json` alongside every entry — the Chrome Web Store
rejects a re-upload with an unchanged version number.

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
