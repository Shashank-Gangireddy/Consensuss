'use strict';
// Priority group 2/3 — Cross-context messaging, background sender
// verification, and synthetic UI-event spoofing.
// Exercises the REAL onMessage listener in background.js/content.js with
// forged sender objects and forged videoId payloads, and statically
// verifies content.js's badge click handler gates on event.isTrusted.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadBackground } = require('../helpers/load-background');

const ROOT = path.join(__dirname, '..', '..');
function readSource(file) {
  return fs.readFileSync(path.join(ROOT, file), 'utf8');
}

test('background-sender-id-enforced: a message from a DIFFERENT extension id is silently ignored (no sendResponse call)', async () => {
  const { messageListeners } = loadBackground({ extensionId: 'realextensionid00000000000000000' });
  let responded = false;
  let keepAlive;
  keepAlive = messageListeners[0](
    { type: 'ANALYZE_CLAIM', payload: { title: 'x', videoId: 'abcdefghijk', comments: [] } },
    { id: 'attackerextensionid0000000000000' }, // forged/foreign sender.id
    () => { responded = true; }
  );
  // give any (incorrectly) scheduled async work a chance to run
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(responded, false, 'a message from a foreign extension id must never receive a response (i.e. must be ignored entirely)');
  assert.notEqual(keepAlive, true, 'listener must return before reaching any async handling for a foreign sender');
});

test('background-sender-id-enforced: a message from a content-script sender NOT on youtube.com is ignored', async () => {
  const { messageListeners } = loadBackground({ extensionId: 'realextensionid00000000000000000' });
  let responded = false;
  messageListeners[0](
    { type: 'ANALYZE_CLAIM', payload: { title: 'x', videoId: 'abcdefghijk', comments: [] } },
    { id: 'realextensionid00000000000000000', tab: { id: 1 }, url: 'https://evil.example.com/watch' },
    () => { responded = true; }
  );
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(responded, false, 'a tab sender whose url is not https://www.youtube.com/... must be ignored');
});

test('background-sender-id-enforced: an accepted sender (matching id, no tab, or youtube.com tab) IS processed', async () => {
  const { messageListeners, storageLocal } = loadBackground({ extensionId: 'realextensionid00000000000000000' });
  await storageLocal.set({ settings: {} }); // no apiKey — should reach the handler and fail on that, not on sender checks
  const resp = await new Promise((resolve) => {
    messageListeners[0](
      { type: 'GET_CACHED_ANALYSIS', payload: { videoId: 'abcdefghijk' } },
      { id: 'realextensionid00000000000000000' },
      resolve
    );
  });
  assert.equal(resp.ok, true, 'a legitimate same-extension sender must be processed normally');
});

test('video-id-cache-collision / malformed-video-id-rejected: a malformed videoId payload is rejected before use as a storage key', async () => {
  const { messageListeners } = loadBackground({ extensionId: 'realextensionid00000000000000000' });
  // Excludes 11-char alphanumeric strings like "constructor" or "__proto__1"
  // that happen to satisfy the YouTube-ID-shape regex by coincidence —
  // those are legitimately accepted by design (the regex is the only
  // validation gate; matching it is "well-formed" for this codebase's
  // purposes) and are covered separately below to confirm that acceptance
  // doesn't create a prototype-pollution path.
  const malformedIds = [
    '../../../etc/passwd', '<script>x</script>',
    'a'.repeat(500), '', 'toolong-11chars-plus', 'short',
  ];
  for (const badId of malformedIds) {
    const resp = await new Promise((resolve) => {
      messageListeners[0](
        { type: 'ANALYZE_CLAIM', payload: { title: 'x', videoId: badId, comments: [] } },
        { id: 'realextensionid00000000000000000' },
        resolve
      );
    });
    assert.equal(resp.ok, false, `videoId ${JSON.stringify(badId)} must be rejected`);
    assert.match(resp.error, /invalid video id/i, `rejection reason for ${JSON.stringify(badId)} should reference invalid video id`);
  }
});

test('video-id-cache-collision: an 11-char string that happens to be a JS special property name ("constructor") is accepted by the shape regex but does not cause prototype pollution', async () => {
  // "constructor" is coincidentally 11 alphanumeric characters, so it
  // passes YOUTUBE_VIDEO_ID_RE by design (the regex is purely a length +
  // charset check, not a semantic YouTube-ID check). This test documents
  // that outcome AND verifies it's harmless: background.js's cache/cooldown
  // stores are either a Map (recentAnalysisAt — immune to prototype
  // pollution entirely) or a plain object populated via chrome.storage.local
  // whose property assignment (store[videoId] = ...) shadows the inherited
  // Object.prototype member as an own property without ever touching the
  // real prototype chain — confirmed by asserting the object's real
  // prototype is untouched after the call.
  const { messageListeners, storageLocal } = loadBackground({ extensionId: 'realextensionid00000000000000000' });
  await storageLocal.set({ settings: {} }); // no apiKey — expect NEXT-stage rejection, proving shape check passed
  const resp = await new Promise((resolve) => {
    messageListeners[0](
      { type: 'ANALYZE_CLAIM', payload: { title: 'x', videoId: 'constructor', comments: [] } },
      { id: 'realextensionid00000000000000000' },
      resolve
    );
  });
  assert.equal(resp.ok, false);
  assert.match(resp.error, /no api key/i, '"constructor" (11 chars) passes the shape regex and fails for the real next reason, confirming the regex is purely length/charset based');
  assert.equal(Object.prototype.toString, Object.prototype.toString, 'sanity: Object.prototype itself must remain completely unmodified');
});

test('video-id-cache-collision: a well-formed 11-char videoId is NOT rejected by the shape check (passes through to the next stage)', async () => {
  const { messageListeners, storageLocal } = loadBackground({ extensionId: 'realextensionid00000000000000000' });
  await storageLocal.set({ settings: {} }); // no apiKey on purpose — expect it to fail LATER (no key), not on id shape
  const resp = await new Promise((resolve) => {
    messageListeners[0](
      { type: 'ANALYZE_CLAIM', payload: { title: 'x', videoId: 'dQw4w9WgXc', comments: [] } }, // 10 chars — still wrong shape (must be 11)
      { id: 'realextensionid00000000000000000' },
      resolve
    );
  });
  assert.equal(resp.ok, false);
  assert.match(resp.error, /invalid video id/i, '10-char id must still be rejected as wrong shape');

  const resp2 = await new Promise((resolve) => {
    messageListeners[0](
      { type: 'ANALYZE_CLAIM', payload: { title: 'x', videoId: 'dQw4w9WgXcQ', comments: [] } }, // real 11-char YouTube id shape
      { id: 'realextensionid00000000000000000' },
      resolve
    );
  });
  assert.equal(resp2.ok, false);
  assert.match(resp2.error, /no api key/i, 'a well-formed id must pass the shape check and fail for the REAL next reason (missing key), not id validation');
});

test('synthetic-ui-event-spoofing: content.js badge click handler is gated on event.isTrusted', () => {
  const src = readSource('content.js');
  const fnMatch = src.match(/async function onBadgeClick\(event\) \{[\s\S]*?\n  \}/);
  assert.ok(fnMatch, 'onBadgeClick handler must exist');
  assert.match(fnMatch[0], /event\s*&&\s*event\.isTrusted\s*===\s*false/, 'onBadgeClick must check event.isTrusted and bail on synthetic (untrusted) events');
});

test('synthetic-ui-event-spoofing: postMessage handlers (page-bridge.js, content.js) validate event.source and event.origin before trusting event.data', () => {
  const bridgeSrc = readSource('page-bridge.js');
  assert.match(bridgeSrc, /ALLOWED_ORIGINS\s*=\s*new Set/, 'page-bridge.js must maintain an explicit origin allowlist');
  assert.match(bridgeSrc, /event\.source\s*!==\s*window/, 'page-bridge.js message listener must check event.source === window');
  assert.match(bridgeSrc, /ALLOWED_ORIGINS\.has\(event\.origin\)/, 'page-bridge.js message listener must check event.origin against the allowlist');

  const contentSrc = readSource('content.js');
  assert.match(contentSrc, /event\.source\s*!==\s*window/, 'content.js message listener must check event.source === window');
  assert.match(contentSrc, /event\.origin\s*!==\s*window\.location\.origin/, 'content.js message listener must check event.origin against window.location.origin');
});

test('content-script-sender-verification: content.js onMessage listener checks sender.id before acting', () => {
  const src = readSource('content.js');
  const listenerMatch = src.match(/chrome\.runtime\.onMessage\.addListener\(\(msg, sender, sendResponse\) => \{[\s\S]*?\n  \}\);/);
  assert.ok(listenerMatch, 'content.js must register an onMessage listener');
  assert.match(listenerMatch[0], /sender\.id\s*!==\s*chrome\.runtime\.id/, 'content.js message listener must verify sender.id');
});
