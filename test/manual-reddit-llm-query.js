'use strict';
// Manual smoke test (not part of the npm test suite) for the new
// LLM-driven Reddit query-builder flow in validateWithReddit(). Verifies:
//   1. The query-builder LLM call fires first, with title + top_recommendation only.
//   2. Its returned query is what actually gets sent to Reddit's search endpoint.
//   3. A second LLM call (evidence synthesis) fires after Reddit results come back.
//   4. Combined token usage/cost covers BOTH calls.
//   5. A query-builder failure sets the failure cooldown and surfaces a clear error.
const assert = require('node:assert');
const { loadBackground } = require('./helpers/load-background');

async function run() {
  // --- Scenario 1: happy path ---
  {
    const calls = [];
    const { chrome, sendMessage } = loadBackground({
      fetchImpl: async (url, opts) => {
        calls.push(String(url));
        if (String(url).includes('api.openai.com')) {
          const body = JSON.parse(opts.body);
          const isQueryCall = body.messages[0].content.includes('You write ONE short Reddit search query');
          if (isQueryCall) {
            return jsonResponse({
              choices: [{ message: { content: JSON.stringify({ query: 'Sony WH-1000XM5 vs Bose QC45' }) }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 }
            });
          }
          return jsonResponse({
            choices: [{ message: { content: JSON.stringify({
              reddit_verdict: 'Corroborates',
              reddit_summary: 'Reddit largely agrees the Sony is the better pick.',
              reddit_recommendation: 'Sony WH-1000XM5',
              citations: [{ thread_index: 1, note: 'Direct comparison thread favors Sony.' }]
            }) }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 400, completion_tokens: 80, total_tokens: 480 }
          });
        }
        if (String(url).includes('reddit.com/search.json')) {
          assert.ok(String(url).includes(encodeURIComponent('Sony WH-1000XM5 vs Bose QC45')), 'Reddit search must use the LLM-provided query');
          return jsonResponse({ data: { children: [{ data: {
            title: 'Sony WH-1000XM5 vs Bose QC45 - which one?', subreddit: 'headphones',
            permalink: '/r/headphones/comments/abc123/x', score: 120, num_comments: 45, over_18: false
          } }] } });
        }
        if (String(url).includes('reddit.com/r/headphones')) {
          return jsonResponse([{}, { data: { children: [
            { kind: 't1', data: { body: 'Went with the Sony, way better ANC in my experience.', score: 30, author: 'someone' } }
          ] } }]);
        }
        throw new Error('unexpected fetch: ' + url);
      }
    });

    await chrome.storage.local.set({ settings: { provider: 'openai', apiKey: 'sk-test', model: 'gpt-4o-mini' } });

    const resp = await sendMessage({
      type: 'VALIDATE_WITH_REDDIT',
      payload: {
        title: 'Sony WH-1000XM5 vs Bose QC45 - Full Review',
        videoId: 'abcdefghijk',
        url: 'https://youtube.com/watch?v=abcdefghijk',
        ytResult: { top_recommendation: 'Sony WH-1000XM5', video_format: 'Comparison', rating: 8, verdict: 'Good', summary: 'Crowd likes the Sony.' }
      }
    });

    assert.ok(resp.ok, 'expected ok response, got: ' + JSON.stringify(resp));
    assert.strictEqual(resp.result.query, 'Sony WH-1000XM5 vs Bose QC45');
    assert.strictEqual(resp.result.reddit_verdict, 'Corroborates');
    assert.strictEqual(resp.result.tokenUsage.totalTokens, 60 + 480, 'combined usage across both LLM calls');
    const openaiCalls = calls.filter(c => c.includes('api.openai.com'));
    assert.strictEqual(openaiCalls.length, 2, 'expected exactly 2 LLM calls (query-builder + synthesis)');
    console.log('Scenario 1 (happy path) passed. Query used:', resp.result.query, '| combined tokens:', resp.result.tokenUsage.totalTokens);
  }

  // --- Scenario 2: query-builder LLM call fails -> clear error + cooldown ---
  {
    const { chrome, sendMessage } = loadBackground({
      fetchImpl: async (url) => {
        if (String(url).includes('api.openai.com')) {
          return { ok: false, status: 500, text: async () => 'boom' };
        }
        throw new Error('should not reach Reddit if query-builder failed: ' + url);
      }
    });
    await chrome.storage.local.set({ settings: { provider: 'openai', apiKey: 'sk-test', model: 'gpt-4o-mini' } });

    const resp = await sendMessage({
      type: 'VALIDATE_WITH_REDDIT',
      payload: {
        title: 'Some Title',
        videoId: 'zzzzzzzzzzz',
        url: 'https://youtube.com/watch?v=zzzzzzzzzzz',
        ytResult: { top_recommendation: 'Thing A', video_format: 'Bug Fix / Patch / Troubleshooting', rating: 7, verdict: 'ok', summary: 's' }
      }
    });

    assert.strictEqual(resp.ok, false);
    assert.match(resp.error, /Could not determine a Reddit search query/);
    console.log('Scenario 2 (query-builder failure) passed. Error:', resp.error);

    // Immediate retry should now be blocked by the failure cooldown.
    const resp2 = await sendMessage({
      type: 'VALIDATE_WITH_REDDIT',
      payload: {
        title: 'Some Title',
        videoId: 'zzzzzzzzzzz',
        url: 'https://youtube.com/watch?v=zzzzzzzzzzz',
        ytResult: { top_recommendation: 'Thing A', video_format: 'Bug Fix / Patch / Troubleshooting', rating: 7, verdict: 'ok', summary: 's' }
      }
    });
    assert.strictEqual(resp2.ok, false);
    assert.match(resp2.error, /wait \d+s before retrying/);
    console.log('Scenario 2b (retry cooldown) passed. Error:', resp2.error);
  }

  // --- Scenario 3: no top_recommendation on ytResult -> rejected server-side, zero calls made ---
  {
    const { chrome, sendMessage } = loadBackground({
      fetchImpl: async (url) => {
        throw new Error('no fetch should happen when there is no crowd pick: ' + url);
      }
    });
    await chrome.storage.local.set({ settings: { provider: 'openai', apiKey: 'sk-test', model: 'gpt-4o-mini' } });

    // Missing entirely
    const respMissing = await sendMessage({
      type: 'VALIDATE_WITH_REDDIT',
      payload: {
        title: 'Some Title',
        videoId: 'nopickvid01',
        url: 'https://youtube.com/watch?v=nopickvid01',
        ytResult: { rating: 6, verdict: 'ok', summary: 's' } // no top_recommendation field at all
      }
    });
    assert.strictEqual(respMissing.ok, false);
    assert.match(respMissing.error, /No crowd pick to check/);

    // Present but blank/whitespace-only
    const respBlank = await sendMessage({
      type: 'VALIDATE_WITH_REDDIT',
      payload: {
        title: 'Some Title',
        videoId: 'nopickvid02',
        url: 'https://youtube.com/watch?v=nopickvid02',
        ytResult: { rating: 6, verdict: 'ok', summary: 's', top_recommendation: '   ' }
      }
    });
    assert.strictEqual(respBlank.ok, false);
    assert.match(respBlank.error, /No crowd pick to check/);

    console.log('Scenario 3 (no crowd pick -> server-side rejection, no LLM/Reddit calls made) passed.');
  }

  // --- Scenario 4: top_recommendation present but video_format is one the
  // model was never supposed to fill it in for (e.g. it disobeyed the
  // "top_recommendation = null, not applicable" instruction) -> still
  // rejected, same as a genuinely missing recommendation. This is the exact
  // "Reddit CTA pops up without a real trigger" bug report. ---
  {
    const { chrome, sendMessage } = loadBackground({
      fetchImpl: async (url) => {
        throw new Error('no fetch should happen for an ineligible video_format: ' + url);
      }
    });
    await chrome.storage.local.set({ settings: { provider: 'openai', apiKey: 'sk-test', model: 'gpt-4o-mini' } });

    for (const badFormat of ['Explainer/Concept', 'Outcome/Result Claim', 'News/Commentary']) {
      const resp = await sendMessage({
        type: 'VALIDATE_WITH_REDDIT',
        payload: {
          title: 'Some Title',
          videoId: 'badformat01',
          url: 'https://youtube.com/watch?v=badformat01',
          // Model disobeyed instructions and returned a non-null pick anyway.
          ytResult: { top_recommendation: 'Some Pick The Model Should Not Have Returned', video_format: badFormat, rating: 6, verdict: 'ok', summary: 's' }
        }
      });
      assert.strictEqual(resp.ok, false, `expected rejection for video_format=${badFormat}`);
      assert.match(resp.error, /No crowd pick to check/);
    }

    console.log('Scenario 4 (top_recommendation present but video_format ineligible -> still rejected) passed.');
  }

  console.log('\nAll manual smoke tests passed.');
}

function jsonResponse(obj) {
  return { ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) };
}

run().catch(err => {
  console.error('FAILED:', err);
  process.exit(1);
});
