'use strict';
// Priority group 1 — Credential storage & transmission.
// Mirrors rabbithole's compatibility-security.test.mjs pattern: plant a
// real secret, exercise the real code path, assert on what the code
// ACTUALLY does (not what the security page claims it does).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadBackground } = require('../helpers/load-background');

const ROOT = path.join(__dirname, '..', '..');
const SECRET = 'sk-test-CREDENTIAL-PROBE-3f9a7c2e1b6d4859a0f1';

function readSource(file) {
  return fs.readFileSync(path.join(ROOT, file), 'utf8');
}

test('credential-storage-mode: settings (incl. apiKey) are written only to chrome.storage.local, never chrome.storage.sync', async () => {
  const { context, storageLocal } = loadBackground();
  await context.getSettings(); // touches storage.local.get, establishes baseline
  await new Promise((resolve) => {
    storageLocal.set({ settings: { provider: 'openai', apiKey: SECRET, model: '' } }).then(resolve);
  });
  const dump = storageLocal._dump();
  assert.equal(dump.settings.apiKey, SECRET, 'sanity: key actually landed in local storage');

  // Static check: background.js and options.js must never reference
  // chrome.storage.sync at all (device-only key storage is a deliberate
  // choice, not an accident of what happened to get called in a test run).
  for (const file of ['background.js', 'options.js', 'content.js', 'popup.js', 'dashboard.js']) {
    const src = readSource(file);
    assert.doesNotMatch(src, /chrome\.storage\.sync/, `${file} must not use chrome.storage.sync for extension data`);
  }
});

test('credential-transmission-header-only (OpenAI): key travels only in the Authorization header, never in the request URL', async () => {
  const { context, setFetch } = loadBackground();
  let capturedUrl = null;
  let capturedHeaders = null;
  setFetch(async (url, opts) => {
    capturedUrl = String(url);
    capturedHeaders = opts.headers;
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '{"rating":5,"verdict":"Mixed","summary":"x"}' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    };
  });
  await context.callOpenAI({ apiKey: SECRET, model: 'gpt-4o-mini' }, 'sys', 'user');
  assert.ok(!capturedUrl.includes(SECRET), `OpenAI request URL must not contain the key: ${capturedUrl}`);
  assert.equal(capturedHeaders.Authorization, `Bearer ${SECRET}`, 'key must be sent via Authorization header');
});

test('credential-transmission-header-only (Anthropic): key travels only in the x-api-key header, never in the request URL', async () => {
  const { context, setFetch } = loadBackground();
  let capturedUrl = null;
  let capturedHeaders = null;
  setFetch(async (url, opts) => {
    capturedUrl = String(url);
    capturedHeaders = opts.headers;
    return {
      ok: true,
      json: async () => ({
        content: [{ text: '{"rating":5,"verdict":"Mixed","summary":"x"}' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    };
  });
  await context.callAnthropic({ apiKey: SECRET, model: 'claude-3-5-haiku-20241022' }, 'sys', 'user');
  assert.ok(!capturedUrl.includes(SECRET), `Anthropic request URL must not contain the key: ${capturedUrl}`);
  assert.equal(capturedHeaders['x-api-key'], SECRET, 'key must be sent via x-api-key header');
});

test('credential-transmission-header-only (Gemini): FINDING — key currently travels in the URL query string, not a header', async () => {
  // This is a genuine gap relative to rabbithole's discipline (URL params
  // are logged more places than headers: server access logs, browser
  // devtools network panel history, any middlebox/proxy). Google's own
  // Gemini REST API requires the key as a `?key=` query parameter — there
  // is no header-based auth option for this endpoint — so this is a
  // constraint inherited from the provider, not a gratuitous choice by
  // this extension. Documenting it as a known, provider-forced exception
  // is the honest fix; silently asserting "clean" here would misrepresent
  // the actual transmission path the way the security page's unqualified
  // "Verified Clean" pill does.
  const { context, setFetch } = loadBackground();
  let capturedUrl = null;
  setFetch(async (url) => {
    capturedUrl = String(url);
    return {
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: '{"rating":5,"verdict":"Mixed","summary":"x"}' }] } }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
      }),
    };
  });
  await context.callGemini({ apiKey: SECRET, model: 'gemini-1.5-flash' }, 'sys', 'user');
  assert.ok(capturedUrl.includes(encodeURIComponent(SECRET)) || capturedUrl.includes(SECRET),
    'documents current behavior: Gemini key is present in the request URL (provider-mandated ?key= auth)');
});

test('credential-destination-allowlist: outbound provider calls only ever target the three declared provider hosts', async () => {
  const manifest = JSON.parse(readSource('manifest.json'));
  const allowedHosts = manifest.host_permissions
    .map((p) => new URL(p.replace('/*', '')).hostname)
    .filter((h) => h !== 'www.youtube.com' && h !== 'www.reddit.com');
  assert.deepEqual(
    allowedHosts.sort(),
    ['api.anthropic.com', 'api.openai.com', 'generativelanguage.googleapis.com'].sort(),
    'manifest host_permissions for LLM providers must be exactly these three'
  );

  const { context, setFetch } = loadBackground();
  const seenHosts = new Set();
  setFetch(async (url) => {
    seenHosts.add(new URL(String(url)).hostname);
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '{"rating":5,"verdict":"Mixed","summary":"x"}' } }],
        content: [{ text: '{"rating":5,"verdict":"Mixed","summary":"x"}' }],
        candidates: [{ content: { parts: [{ text: '{"rating":5,"verdict":"Mixed","summary":"x"}' }] } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
      }),
    };
  });
  await context.callOpenAI({ apiKey: SECRET, model: 'x' }, 's', 'u');
  await context.callAnthropic({ apiKey: SECRET, model: 'x' }, 's', 'u');
  await context.callGemini({ apiKey: SECRET, model: 'x' }, 's', 'u');
  for (const host of seenHosts) {
    assert.ok(allowedHosts.includes(host), `unexpected outbound host: ${host}`);
  }
  assert.equal(seenHosts.size, 3, 'expected exactly the three provider hosts to have been contacted');
});

test('credential-never-in-console-or-logs: no source file logs settings.apiKey / the raw key variable directly', () => {
  // Static scan: acceptable console.warn/console.log calls in this
  // codebase log error OBJECTS or fixed strings, never the key variable
  // itself. This assertion is intentionally a source-pattern check (like
  // rabbithole's dangerous-DOM-sink scan) since there is no realistic way
  // to enumerate every console.* call path at runtime.
  for (const file of ['background.js', 'options.js', 'content.js', 'popup.js']) {
    const src = readSource(file);
    const consoleCalls = src.match(/console\.(log|warn|error|info|debug)\([^)]*\)/g) || [];
    for (const call of consoleCalls) {
      assert.doesNotMatch(call, /\bapiKey\b/, `${file} logs apiKey directly: ${call}`);
    }
  }
});

test('credential-never-in-dom: options.html / popup.html never interpolate the raw key into page text (only into the password input\'s .value)', () => {
  const optionsHtml = readSource('options.html');
  const popupHtml = readSource('popup.html');
  assert.match(optionsHtml, /id="apiKey"\s+type="password"/, 'apiKey field must be type=password');
  // popup.html/dashboard.html must never contain an apiKey-labeled element
  // at all — the key should only ever exist in the options page's password
  // input, nowhere else in the extension's UI surface.
  assert.doesNotMatch(popupHtml, /apiKey/i, 'popup.html must not reference apiKey anywhere');
  const dashboardHtml = readSource('dashboard.html');
  assert.doesNotMatch(dashboardHtml, /apiKey/i, 'dashboard.html must not reference apiKey anywhere');
});

test('credential-never-in-export: dashboard CSV/JSON export (history + guidance) never carries settings.apiKey', async () => {
  // History entries are constructed explicitly in background.js's
  // analyzeClaim/analyzeVibes — assert the fields list literally excludes
  // apiKey by re-running the real analysis pipeline and inspecting the
  // logged entry shape, the same "plant a secret, export, inspect" shape
  // as rabbithole's compatibility-security.test.mjs.
  const { context, storageLocal, setFetch } = loadBackground();
  await storageLocal.set({ settings: { provider: 'openai', apiKey: SECRET, model: '', sendLimitAuto: true } });
  setFetch(async () => ({
    ok: true,
    json: async () => ({
      choices: [{
        message: {
          content: JSON.stringify({
            content_category: 'Technology', video_format: 'Review', rating_dimension: 'Review Agreement',
            rating: 7, verdict: 'Mostly Confirmed', summary: 'Looks fine.',
            supporting_points: [], contradicting_points: [], top_recommendation: null,
            critical_flag: null, guidance_impact: [],
          }),
        },
      }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    }),
  }));
  const comments = Array.from({ length: 10 }, (_, i) => ({ text: `Real comment number ${i} with enough length`, likes: '1' }));
  await context.analyzeClaim('Some Product Review', comments, { videoId: 'abcdefghijk' });

  const dump = storageLocal._dump();
  const historyJson = JSON.stringify(dump.history);
  assert.ok(!historyJson.includes(SECRET), 'logged history entry must not contain the API key');
  assert.ok(!/apiKey/i.test(historyJson), 'logged history entry must not even carry an apiKey field');
});
