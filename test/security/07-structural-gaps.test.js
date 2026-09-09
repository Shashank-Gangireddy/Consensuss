'use strict';
// Priority group 9 — Structural gaps (telemetry/error-reporting absence,
// uninstall data handling). Unlike rabbithole, Consensus has no crash-
// reporting/telemetry feature and no in-extension "reset/clear all data
// including key" flow — these tests verify those ABSENCES are real (no
// stray endpoint, no half-built reset path) rather than assuming a
// feature exists to test.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
function readSource(file) {
  return fs.readFileSync(path.join(ROOT, file), 'utf8');
}
const ALL_FILES = ['background.js', 'content.js', 'popup.js', 'options.js', 'dashboard.js', 'page-bridge.js'];

test('key-never-in-error-reports: no source file contains any telemetry/crash-reporting/analytics endpoint at all', () => {
  // If a telemetry feature is ever added, this test must be updated
  // alongside it with an explicit scrub-before-send assertion — its
  // failure here is the trip wire that forces that review to happen.
  const manifest = JSON.parse(readSource('manifest.json'));
  const declaredHosts = new Set(manifest.host_permissions.map((p) => new URL(p.replace('/*', '')).hostname));
  const knownTelemetryHosts = [
    'sentry.io', 'bugsnag.com', 'google-analytics.com', 'analytics.google.com',
    'mixpanel.com', 'segment.io', 'amplitude.com', 'posthog.com', 'logrocket.com',
  ];
  for (const host of knownTelemetryHosts) {
    assert.ok(!declaredHosts.has(host), `manifest must not declare a known telemetry host permission (${host})`);
  }
  for (const file of ALL_FILES) {
    const src = readSource(file);
    for (const host of knownTelemetryHosts) {
      assert.ok(!src.includes(host), `${file} must not reference a telemetry host (${host})`);
    }
  }
});

test('key-scrubbed-on-uninstall-or-reset: FINDING — there is no in-extension "clear all data" action that removes the stored apiKey', () => {
  // dashboard.js's "Clear All" button (#clearBtn) only clears `history`
  // (chrome.storage.local key "history") — it does not touch `settings`
  // (which holds apiKey). Chrome does fully wipe chrome.storage.local on
  // actual extension UNINSTALL regardless of this code (platform
  // guarantee, not something this extension controls or could break), but
  // within a single install there is no "forget my key" affordance short
  // of the user manually clearing the apiKey field in Options and hitting
  // Save. This test documents that gap so it can be tracked, rather than
  // silently assuming a reset flow exists.
  const dashboardSrc = readSource('dashboard.js');
  const clearBtnHandler = dashboardSrc.match(/\$\('clearBtn'\)\.addEventListener\('click', async \(\) => \{[\s\S]*?\n\}\);/);
  assert.ok(clearBtnHandler, 'clearBtn handler must exist');
  assert.doesNotMatch(
    clearBtnHandler[0],
    /settings/,
    'FINDING: confirms Clear All does not touch `settings` (and therefore does not clear apiKey) — only `history` is cleared. ' +
    'If this assertion ever starts failing because Clear All now touches settings, this test should be rewritten to verify apiKey ' +
    'is actually removed, not treated as a regression.'
  );
});

test('options page discloses where the key is sent, in plain user-facing text (transparency, not just code-level correctness)', () => {
  const optionsHtml = readSource('options.html');
  assert.match(
    optionsHtml,
    /stored locally[\s\S]*?sent directly[\s\S]*?provider[\s\S]*?never sent[\s\S]*?anywhere else/i,
    'options.html must disclose storage/transmission behavior to the user in plain text'
  );
});
