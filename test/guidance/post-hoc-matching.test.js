'use strict';
// Post-hoc guidance matching — regression coverage for the real incident
// that motivated this design change: 5 consecutive live analyses (a
// Tutorial, two Comparisons, a Product Review) collapsed to rating 2-4 /
// "Insufficient Evidence" despite 110 analyzed comments each (well above
// the 6-comment MIN_COMMENTS_FOR_CLAIM_VERDICT floor), because guidance
// rules distilled from an unrelated "Advice/Opinion" video's correction
// were injected into every prompt as "binding" regardless of relevance.
//
// New design under test (see background.js buildPrompt/analyzeClaim/
// matchGuidanceAgainstResult):
//   1. Ordinary (non-critical) guidance is NEVER shown to the model
//      before it answers — only CRITICAL (creator-genuineness) guidance
//      is injected up front.
//   2. After the model returns its evidence-based result, ordinary
//      guidance rules are matched against that FINISHED result
//      deterministically: scope must fit (global, or the model's own
//      classified video_format) AND the rule's wording must overlap
//      substantively with what the model actually wrote.
//   3. Only real matches apply a rating penalty. No match, no penalty —
//      regardless of how many rules are sitting in storage.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadBackground } = require('../helpers/load-background');

// 15 distinct, substantive comments — comfortably above
// MIN_COMMENTS_FOR_CLAIM_VERDICT (6) and worded distinctly enough to
// survive clusterNearDuplicates() as separate entries, so a real
// evidence-volume floor never masks what's under test here.
const DISTINCT_COMMENTS = [
  'This tutorial worked perfectly for me on the first try',
  'Step three did not match what actually happened on my machine',
  'Clear explanation, I finally understand how this works',
  'The install command in the video is outdated now',
  'Great pacing, easy to follow along without pausing much',
  'I hit an error at the config step that was not covered',
  'Really appreciate how thorough this walkthrough was',
  'Had to look up an extra flag that was missing here',
  'This saved me hours compared to the official docs',
  'The audio cut out around the halfway point for me',
  'Followed every step and it just worked, no issues',
  'Wish it covered the Windows setup too, only Mac shown',
  'Best explanation of this topic I have found so far',
  'One command was deprecated but an easy fix once I found it',
  'Solid tutorial overall, would recommend to a friend learning this',
].map((text) => ({ text, likes: '3' }));

// The exact five 2026-09-12 seed rules from guidance-seed.json (verbatim
// text/scope), the real source of the incident — reused here rather than
// paraphrased, so this test fails loudly if their wording ever drifts.
const SEED_RULES = [
  {
    id: 'seed-outcome', scope: 'Outcome/Result Claim', severity: 'normal', active: true, createdAt: 1, timesApplied: 0,
    rule: 'When a summary identifies significant limitations (incomplete access, lack of substantive details, or commercial presentation) that undermine verification, those concerns should proportionally reduce the confidence rating rather than being noted but ignored.',
  },
  {
    id: 'seed-comparison', scope: 'Comparison', severity: 'normal', active: true, createdAt: 2, timesApplied: 0,
    rule: "If a comparison video's title claims comprehensiveness (e.g. 'best', 'most hyped', 'ultimate') but notably omits major categories or well-regarded options acknowledged in comments, treat the title-scope mismatch as a credibility issue and reflect this in the rating.",
  },
  {
    id: 'seed-tutorial', scope: 'Tutorial/Howto', severity: 'normal', active: true, createdAt: 3, timesApplied: 0,
    rule: 'When a tutorial\u2019s instructions are technically clear but the premise or claims significantly misrepresent capabilities or omit critical safety/functionality gaps that viewers identify as problems, weight trust and accuracy of the core claim heavily\u2014not just execution clarity\u2014in the overall rating.',
  },
  {
    id: 'seed-explainer', scope: 'Explainer/Concept', severity: 'normal', active: true, createdAt: 4, timesApplied: 0,
    rule: 'When a video omits or glosses over a critical prerequisite, condition, or foundational assumption for the advice/concept presented, downgrade the verdict rating to reflect incompleteness as a material accuracy issue, not merely a stylistic choice.',
  },
  {
    id: 'seed-advice', scope: 'Advice/Opinion', severity: 'normal', active: true, createdAt: 5, timesApplied: 0,
    rule: 'When evaluating advice/opinion content, check whether commenters are questioning the absence of source attribution, citations, or links\u2014this signals potential credibility concerns that should be noted even if the core advice itself is validated.',
  },
];

function fetchReturning(body) {
  return async (url, opts) => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { content: JSON.stringify(body) } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
  });
}

test('regression: a Tutorial/Howto video with clean, on-topic evidence keeps its rating — seed rules for OTHER video_formats never fire', async () => {
  const { context, storageLocal, setFetch } = loadBackground();
  await storageLocal.set({
    settings: { provider: 'openai', apiKey: 'sk-test', model: 'gpt-4o-mini' },
    learnedGuidance: SEED_RULES,
  });
  // Model's honest, evidence-based read: mostly positive, no sourcing/
  // scope-mismatch/prerequisite-omission language anywhere in its own text.
  setFetch(fetchReturning({
    content_category: 'Technology', video_format: 'Tutorial/Howto', rating_dimension: 'Tutorial Success Rate',
    rating: 8, verdict: 'Mostly Confirmed',
    summary: 'Most viewers report the tutorial worked as shown, with one minor outdated command.',
    supporting_points: ['Worked first try for several viewers', 'Praised for clear pacing'],
    contradicting_points: ['One outdated install command', 'Missing Windows setup for some'],
  }));
  const result = await context.analyzeClaim('How to Set Up X: Full Tutorial', DISTINCT_COMMENTS, { videoId: 'abcdefghijk' });
  assert.equal(result.rating, 8, `rating must stay at the model's own evidence-based 8, got ${result.rating} (guidance_enforcement=${JSON.stringify(result.guidance_enforcement)})`);
  assert.notEqual(result.verdict, 'Insufficient Evidence', 'a 15-comment, mostly-positive result must never collapse to Insufficient Evidence via unrelated guidance');
  assert.equal(result.guidance_enforcement, null, 'no rule should match: the Comparison/Advice/Explainer/Outcome rules are all out of scope for a Tutorial/Howto video');
});

test('regression: a Comparison video is NOT penalized by the Tutorial or Advice/Opinion seed rules (scope mismatch)', async () => {
  const { context, storageLocal, setFetch } = loadBackground();
  await storageLocal.set({
    settings: { provider: 'openai', apiKey: 'sk-test', model: 'gpt-4o-mini' },
    learnedGuidance: SEED_RULES,
  });
  setFetch(fetchReturning({
    content_category: 'Technology', video_format: 'Comparison', rating_dimension: 'Comparison Fairness & Accuracy',
    rating: 7, verdict: 'Mostly Confirmed',
    summary: 'Commenters broadly agree the comparison was fair and covered the main contenders.',
    supporting_points: ['Fair test conditions per commenters', 'Covered the expected main options'],
    contradicting_points: ['A couple viewers wanted one more budget pick included'],
  }));
  const result = await context.analyzeClaim('Best Tools Compared', DISTINCT_COMMENTS, { videoId: 'bbwjxzwekRM' });
  assert.equal(result.rating, 7, `rating must stay at the model's own 7 — no title-scope-mismatch language present, got ${result.rating}`);
  assert.equal(result.guidance_enforcement, null, 'the Comparison-scoped rule requires wording overlap (title-scope mismatch) that is not present in this result, and Tutorial/Advice rules are out of scope entirely');
});

test('a genuinely matching Comparison-scoped rule DOES apply when the model\'s own result actually describes that exact condition', async () => {
  const { context, storageLocal, setFetch } = loadBackground();
  await storageLocal.set({
    settings: { provider: 'openai', apiKey: 'sk-test', model: 'gpt-4o-mini' },
    learnedGuidance: SEED_RULES,
  });
  setFetch(fetchReturning({
    content_category: 'Technology', video_format: 'Comparison', rating_dimension: 'Comparison Fairness & Accuracy',
    rating: 7, verdict: 'Mostly Confirmed',
    summary: 'The video claims to be the most comprehensive comparison but commenters note it omits several well-regarded options, a real title-scope mismatch.',
    supporting_points: ['Fair test conditions on the options it did cover'],
    contradicting_points: ['Title claims comprehensiveness but omits well-regarded contenders, a scope mismatch commenters flagged repeatedly'],
  }));
  const result = await context.analyzeClaim('The Most Comprehensive Comparison Ever', DISTINCT_COMMENTS, { videoId: 'tumUlLaC9cY' });
  assert.ok(result.rating < 7, `the Comparison-scoped rule's exact condition (title-scope mismatch) is present in the model's own text — rating must be penalized below 7, got ${result.rating}`);
  assert.ok(result.guidance_enforcement, 'guidance_enforcement must be recorded when a real match fires');
  assert.equal(result.guidance_enforcement.unresolvedRules.length, 1, 'only the one genuinely-matching Comparison rule should fire, not the other four out-of-scope seed rules');
});

test('critical (creator-genuineness) guidance is still injected up front and still enforced via the deterministic ceiling — unaffected by the ordinary-guidance change', async () => {
  const { context, storageLocal, setFetch } = loadBackground();
  await storageLocal.set({
    settings: { provider: 'openai', apiKey: 'sk-test', model: 'gpt-4o-mini' },
    learnedGuidance: [
      ...SEED_RULES,
      { id: 'crit-1', rule: 'Staged reaction footage presented as real', scope: 'global', severity: 'critical', active: true, createdAt: 6, timesApplied: 0 },
    ],
  });
  let capturedPrompt = '';
  setFetch(async (url, opts) => {
    capturedPrompt = JSON.parse(opts.body).messages.map(m => m.content).join('\n');
    return {
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              content_category: 'Technology', video_format: 'Tutorial/Howto',
              rating: 9, verdict: 'Confirmed', summary: 'Looks fine.',
              critical_flag: { rule: 'Staged reaction footage presented as real', corroboration: 'Strong', note: 'several commenters say staged' },
            }),
          },
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    };
  });
  const result = await context.analyzeClaim('Some Video', DISTINCT_COMMENTS, { videoId: 'abcdefghijk' });
  assert.match(capturedPrompt, /Staged reaction footage presented as real/, 'CRITICAL guidance must still be shown to the model up front (only ordinary guidance moved to post-hoc)');
  assert.doesNotMatch(capturedPrompt, /When evaluating advice\/opinion content/, 'ordinary guidance rules must still never appear in the prompt');
  assert.ok(result.rating <= 3, `Strong critical_flag ceiling must still force rating<=3, got ${result.rating}`);
});

test('scope-fit alone (no wording overlap) is not enough to trigger a penalty', async () => {
  const { context, storageLocal, setFetch } = loadBackground();
  await storageLocal.set({
    settings: { provider: 'openai', apiKey: 'sk-test', model: 'gpt-4o-mini' },
    learnedGuidance: [SEED_RULES[2]], // the Tutorial/Howto-scoped rule
  });
  setFetch(fetchReturning({
    content_category: 'Technology', video_format: 'Tutorial/Howto', rating_dimension: 'Tutorial Success Rate',
    rating: 8, verdict: 'Mostly Confirmed',
    summary: 'Commenters found the steps clear and confirmed it worked for them.', // no safety/misrepresentation language at all
    supporting_points: ['Worked as described'],
    contradicting_points: ['One typo in a command'],
  }));
  const result = await context.analyzeClaim('Setup Tutorial', DISTINCT_COMMENTS, { videoId: 'jkjkjkjkjkj' });
  assert.equal(result.rating, 8, `scope fits (Tutorial/Howto) but the rule's specific condition (misrepresented capabilities/safety gaps) is not present in the result text — must not penalize, got ${result.rating}`);
  assert.equal(result.guidance_enforcement, null);
});
