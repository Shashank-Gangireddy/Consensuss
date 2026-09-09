'use strict';
// Priority group 5 — API abuse / rate limiting.
// Exercises the REAL rate-limit functions (checkGlobalRateLimit,
// checkAnalysisCooldown, checkRedditCooldown) from background.js directly.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadBackground } = require('../helpers/load-background');

test('rate-limit-enforced-per-video: a second analysis call on the SAME video within the cooldown window throws', () => {
  const { context } = loadBackground();
  context.checkAnalysisCooldown('abcdefghijk'); // first call: fine
  assert.throws(
    () => context.checkAnalysisCooldown('abcdefghijk'),
    /wait a few seconds/i,
    'a second call on the same video inside the cooldown window must throw'
  );
});

test('rate-limit-enforced-per-video: two DIFFERENT videoIds are each allowed through independently (per-video keying works)', () => {
  const { context } = loadBackground();
  context.checkAnalysisCooldown('videoAAAAAA');
  assert.doesNotThrow(() => context.checkAnalysisCooldown('videoBBBBBB'), 'a different video must not be blocked by another video\'s cooldown');
});

test('rate-limit-bypass-via-forged-id: rapid distinct videoIds still hit the GLOBAL sliding-window cap (per-video cooldown alone is not the only guard)', () => {
  const { context } = loadBackground();
  // GLOBAL_RATE_MAX_CALLS = 12 per 60s window, independent of per-video
  // keying — simulate an attacker spoofing a fresh videoId every call
  // (e.g. via history.pushState) specifically to dodge the per-video
  // cooldown, and confirm the global cap still catches it.
  for (let i = 0; i < 12; i++) {
    context.checkAnalysisCooldown(`video${String(i).padStart(6, '0')}`);
  }
  assert.throws(
    () => context.checkAnalysisCooldown('video000012'),
    /too many analyses/i,
    'the 13th call within the window (13th distinct videoId) must be blocked by the GLOBAL rate limit even though each id is individually fresh'
  );
});

test('rate-limit-enforced: checkGlobalRateLimit alone (no videoId) also enforces the 12/60s cap', () => {
  const { context } = loadBackground();
  for (let i = 0; i < 12; i++) context.checkGlobalRateLimit();
  assert.throws(() => context.checkGlobalRateLimit(), /too many analyses/i);
});

test('rate-limit-reddit-cooldown: reddit validation has its own independent cooldown namespace, not shared with the main analysis cooldown', () => {
  const { context } = loadBackground();
  // Use up the main analysis cooldown for a video...
  context.checkAnalysisCooldown('sharedvid01');
  // ...and confirm the Reddit cooldown for the SAME video is NOT
  // pre-blocked by that (separate key namespace, per background.js's own
  // comment: 'rapid Reddit-validate click can't be starved by ... the main
  // analysis cooldown, and vice versa').
  assert.doesNotThrow(() => context.checkRedditCooldown('sharedvid01'), 'Reddit cooldown must be independent of the main analysis cooldown for the same video');
  // But a SECOND Reddit call on the same video, inside ITS OWN window, is blocked.
  assert.throws(() => context.checkRedditCooldown('sharedvid01'), /wait a few seconds/i);
});

test('rate-limit-analyze-claim-end-to-end: two rapid ANALYZE_CLAIM messages for the same video — the second is rejected via the real message listener path', async () => {
  const { messageListeners, storageLocal } = loadBackground({ extensionId: 'realextensionid00000000000000000' });
  await storageLocal.set({ settings: { provider: 'openai', apiKey: 'sk-test', model: '' } });
  const msg = { type: 'ANALYZE_CLAIM', payload: { title: 'x', videoId: 'endtoendvi1', comments: [] } };
  const first = await new Promise((resolve) => messageListeners[0](msg, { id: 'realextensionid00000000000000000' }, resolve));
  // First call will fail for its OWN reason (comments array empty -> some
  // downstream error, or succeeds far enough to set the cooldown) — either
  // way checkAnalysisCooldown() runs and marks the timestamp before any
  // later failure, since it's the first line inside analyzeClaim().
  const second = await new Promise((resolve) => messageListeners[0](msg, { id: 'realextensionid00000000000000000' }, resolve));
  assert.equal(second.ok, false);
  assert.match(second.error, /wait a few seconds/i, 'the second rapid call for the same video must be rejected by the per-video cooldown, not silently reprocessed');
});
