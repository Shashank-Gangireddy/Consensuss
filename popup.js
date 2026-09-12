// popup.js

const $ = id => document.getElementById(id);

let activeTabId = null;
let lastState = null; // most recent content-script state, kept so the Reddit button doesn't need a fresh round-trip

const FETCH_TARGET = 150; // comments pulled from YouTube; the LLM only sees a filtered subset (see options)

function setStatus(text) {
  $('status').textContent = text || '';
}

// Per-video-format labels so the same UI reads naturally whether the video
// is a comparison, a bug-fix claim, a tutorial, etc.
const FORMAT_LABELS = {
  'Comparison': { support: 'Comments praising the comparison', contra: 'Comments calling out issues', recTitle: 'Crowd\u2019s actual pick' },
  'List/Roundup': { support: 'Comments praising the list', contra: 'Comments criticizing an entry', recTitle: 'Crowd\u2019s top addition' },
  'Review': { support: 'Comments agreeing with the review', contra: 'Comments disagreeing', recTitle: 'Alternative commenters suggest' },
  'Bug Fix / Patch / Troubleshooting': { support: 'Comments confirming the fix worked', contra: 'Comments saying it didn\u2019t work', recTitle: 'Better fix from the comments' },
  'Tutorial/Howto': { support: 'Comments confirming success', contra: 'Comments reporting issues', recTitle: 'Tip from the comments' },
  'Explainer/Concept': { support: 'Comments confirming accuracy', contra: 'Comments disputing accuracy', recTitle: 'Crowd note' },
  'Advice/Opinion': { support: 'Comments backing the advice', contra: 'Comments pushing back', recTitle: 'What the crowd suggests instead' },
  'Outcome/Result Claim': { support: 'Supporting comments say', contra: 'Contradicting comments say', recTitle: 'Crowd note' }
};
const DEFAULT_FORMAT_LABEL = { support: 'Supporting comments say', contra: 'Contradicting comments say', recTitle: 'Crowd note' };

// Formats where the model is actually asked to look for a crowd pick/fix/tip
// (per the PART 2 prompt rules in background.js) — for the others,
// top_recommendation is null BY DESIGN ("not applicable"), so we shouldn't
// show a "no consensus found" line that implies something's missing.
const FORMATS_WITH_RECOMMENDATION = new Set([
  'Comparison', 'List/Roundup', 'Review', 'Bug Fix / Patch / Troubleshooting', 'Tutorial/Howto', 'Advice/Opinion'
]);

// Reddit validation state (consensus path) lives here in popup.js, separate
// from the content-script `state` object rendered below — every
// SCRAPE_COMMENTS/ANALYZE round-trip replaces `state` wholesale with a
// fresh object from content.js (which knows nothing about Reddit), so
// anything we need to survive across renders has to live outside it. Keyed
// to a specific videoId so a stale result doesn't render over a different
// video.
let redditState = { videoId: null, status: 'idle', result: null, error: null, fromCache: false, cachedAt: null };

function resetRedditStateIfNewVideo(videoId) {
  if (redditState.videoId !== videoId) {
    redditState = { videoId, status: 'idle', result: null, error: null, fromCache: false, cachedAt: null };
  }
}

// Same pattern as redditState, for the vibes path's community lookup —
// separate state object because it's also opt-in/click-triggered and also
// needs to survive re-renders of the content-script `state`.
let communitiesState = { videoId: null, status: 'idle', result: null, error: null };

function resetCommunitiesStateIfNewVideo(videoId) {
  if (communitiesState.videoId !== videoId) {
    communitiesState = { videoId, status: 'idle', result: null, error: null };
  }
}

function renderState(state) {
  lastState = state;
  $('videoTitle').textContent = state.title || '(title not detected yet)';

  const busy = state.status === 'scraping' || state.status === 'analyzing';
  $('analyzeBtn').disabled = busy;
  // Once a result exists, the on-page badge (click to re-analyze) is the
  // re-trigger path — see the "click the badge on the page to refresh"
  // copy in both result cache lines below. Keeping this button around too
  // is redundant clutter once there's already a rating to look at, so it
  // only persists for idle/in-progress/error states.
  $('analyzeBtn').classList.toggle('hidden', state.status === 'done');

  if (state.status === 'scraping') setStatus(`Fetching comments… (${state.comments.length} found)`);
  else if (state.status === 'analyzing') setStatus('Asking the model to rate the claim…');
  else if (state.status === 'error') setStatus('Error: ' + state.error);
  else setStatus('');

  const isVibes = state.status === 'done' && state.result && state.result.path === 'vibes';
  const isConsensus = state.status === 'done' && state.result && !isVibes;

  if (isConsensus) {
    renderConsensusResult(state);
  } else {
    $('resultBox').classList.add('hidden');
    $('redditBtn').classList.add('hidden');
  }

  if (isVibes) {
    renderVibesResult(state);
  } else {
    $('vibesBox').classList.add('hidden');
    $('communitiesBtn').classList.add('hidden');
  }
}

function renderConsensusResult(state) {
  const r = state.result;
  $('resultBox').classList.remove('hidden');
  const isNewRedditVideo = redditState.videoId !== state.videoId;
  resetRedditStateIfNewVideo(state.videoId);
  if (isNewRedditVideo) preloadCachedReddit(state.videoId);

  if (state.fromCache) {
    const when = state.cachedAt ? new Date(state.cachedAt).toLocaleString() : 'earlier';
    $('cacheLine').textContent = `Cached result from ${when} — click the badge on the page to refresh.`;
    $('cacheLine').classList.remove('hidden');
  } else {
    $('cacheLine').classList.add('hidden');
  }

  $('ratingNum').textContent = `${r.rating}`;
  const ratingState = r.rating >= 7 ? 'state-good' : r.rating >= 4 ? 'state-mid' : 'state-bad';
  $('ratingHero').classList.remove('state-good', 'state-mid', 'state-bad');
  $('ratingHero').classList.add(ratingState);
  $('verdict').textContent = r.verdict;
  $('summary').textContent = r.summary;

  if (r.contested) {
    $('contestedBadge').classList.remove('hidden');
  } else {
    $('contestedBadge').classList.add('hidden');
  }

  if (r.critical_flag && r.critical_flag.corroboration) {
    const strong = r.critical_flag.corroboration === 'Strong';
    $('criticalFlagBox').classList.remove('hidden');
    $('criticalFlagBox').classList.toggle('critical-strong', strong);
    $('criticalFlagBox').classList.toggle('critical-moderate', !strong);
    $('criticalFlagLabel').textContent = strong
      ? '⚠ Authenticity concern — strongly corroborated'
      : 'Authenticity concern — some corroboration';
    $('criticalFlagNote').textContent = r.critical_flag.note || r.critical_flag.rule || '';
  } else {
    $('criticalFlagBox').classList.add('hidden');
  }

  // guidance_enforcement is set by the deterministic post-hoc check in
  // background.js (matchGuidanceAgainstResult) — an ordinary LEARNED
  // GUIDANCE rule whose scope fits this video's format AND whose wording
  // substantively overlaps with the model's own summary/contradicting
  // points, checked only AFTER the model formed its rating (the model
  // never sees ordinary guidance rules before answering) — the rating
  // shown above is already the post-penalty value; this box just
  // explains why.
  if (r.guidance_enforcement && r.guidance_enforcement.unresolvedRules && r.guidance_enforcement.unresolvedRules.length) {
    const ge = r.guidance_enforcement;
    $('guidanceEnforcementBox').classList.remove('hidden');
    $('guidanceEnforcementLabel').textContent =
      `Rating auto-adjusted ${ge.originalRating} → ${ge.adjustedRating}: matched standing guidance rule(s)`;
    $('guidanceEnforcementList').innerHTML = '';
    ge.unresolvedRules.forEach(u => {
      const li = document.createElement('li');
      li.textContent = u.rule;
      $('guidanceEnforcementList').appendChild(li);
    });
  } else {
    $('guidanceEnforcementBox').classList.add('hidden');
  }

  if (r.content_category || r.video_format) {
    $('classificationLine').textContent = [r.content_category, r.video_format].filter(Boolean).join(' · ');
    $('classificationLine').classList.remove('hidden');
  } else {
    $('classificationLine').classList.add('hidden');
  }

  if (r.rating_dimension) {
    $('ratingDimLine').textContent = `Judged on: ${r.rating_dimension}`;
    $('ratingDimLine').classList.remove('hidden');
  } else {
    $('ratingDimLine').classList.add('hidden');
  }

  const labels = FORMAT_LABELS[r.video_format] || DEFAULT_FORMAT_LABEL;
  $('supportLabel').textContent = labels.support;
  $('contraLabel').textContent = labels.contra;

  if (r.top_recommendation) {
    $('recommendationLabel').textContent = labels.recTitle;
    $('recommendationText').textContent = r.top_recommendation;
    $('recommendationText').classList.remove('muted-italic');
    $('recommendationBox').classList.remove('hidden');
  } else if (FORMATS_WITH_RECOMMENDATION.has(r.video_format)) {
    // Explicitly distinguish "the model looked and found no clear
    // consensus" from a bug/empty state — otherwise the box just
    // vanishing with no explanation looks broken.
    $('recommendationLabel').textContent = labels.recTitle;
    $('recommendationText').textContent = 'No clear single pick emerged from the comments.';
    $('recommendationText').classList.add('muted-italic');
    $('recommendationBox').classList.remove('hidden');
  } else {
    $('recommendationBox').classList.add('hidden');
  }

  if (r.tokenUsage) {
    const t = r.tokenUsage;
    const fetched = r.commentsFetched != null ? r.commentsFetched : '?';
    const analyzed = r.commentsAnalyzed != null ? r.commentsAnalyzed : '?';
    const vol = r.evidence_volume ? ` · ${r.evidence_volume} evidence` : '';
    $('usageLine').textContent =
      `${analyzed}/${fetched} comments sent to model${vol} · ${t.totalTokens} tokens (${t.promptTokens} in / ${t.completionTokens} out) · ~$${(r.estCostUSD || 0).toFixed(5)}`;
  } else {
    $('usageLine').textContent = '';
  }

  fillList('supportBlock', 'supportList', r.supporting_points);
  fillList('contraBlock', 'contraList', r.contradicting_points);

  // Reddit CTA is only actionable when there's a standout crowd
  // recommendation/pick — that's the one thing worth going to Reddit to
  // reinforce. With no top_recommendation there's nothing specific to
  // search for or corroborate, so the button would just invite a click
  // that produces a vague/unfocused validation — hide it entirely rather
  // than show a CTA with no real action behind it. Hide it while busy too,
  // so a rapid double click can't fire two concurrent (paid) validations.
  const hasRecommendation = !!r.top_recommendation;
  const redditBusy = redditState.status === 'validating';

  if (hasRecommendation) {
    $('redditBtn').classList.remove('hidden');
    $('redditBtn').disabled = redditBusy;
    $('redditBtn').textContent = redditBusy ? 'Checking Reddit…' : 'Check against Reddit';

    if (redditState.status === 'validating') {
      $('redditStatus').textContent = 'Searching Reddit and reading top threads…';
    } else if (redditState.status === 'error') {
      $('redditStatus').textContent = 'Reddit check failed: ' + (redditState.error || 'unknown error');
    } else {
      $('redditStatus').textContent = '';
    }

    renderRedditResult(redditState.result, redditState.fromCache, redditState.cachedAt);
  } else {
    $('redditBtn').classList.add('hidden');
    $('redditStatus').textContent = '';
    $('redditBox').classList.add('hidden');
  }
}

// Human-readable label for the vibes path's category tag line — reuses
// the raw YouTube category when available.
function vibesPathLabel(r) {
  return r.content_category || 'Vibes';
}

// A cached result written by the OLD two-schema vibes path (before the
// consensus_lean/agreement_strength/notable_quotes unification) carries
// `vibe_summary`/`mood_tags`/`hotspots`/`overall_tone` and no
// `consensus_lean` at all. Per explicit product decision, old cache
// entries are left as-is on disk (no migration) — so the popup keys off
// field PRESENCE, not a version flag, to render either shape correctly
// indefinitely.
function isLegacyVibesResult(r) {
  return r.consensus_lean === undefined;
}

const CONSENSUS_LEAN_CLASS = {
  Positive: 'lean-good',
  Negative: 'lean-bad',
  Split: 'lean-mid',
  'Insufficient Evidence': 'lean-none'
};

const AUTHENTICITY_LEAN_CLASS = {
  Real: 'lean-good',
  Staged: 'lean-bad',
  Disputed: 'lean-mid'
};

function renderVibesResult(state) {
  const r = state.result;
  $('vibesBox').classList.remove('hidden');
  const isNewCommunitiesVideo = communitiesState.videoId !== state.videoId;
  resetCommunitiesStateIfNewVideo(state.videoId);
  if (isNewCommunitiesVideo) communitiesState.result = null; // no cross-video preload for communities — cheap enough to just refetch on click

  if (state.fromCache) {
    const when = state.cachedAt ? new Date(state.cachedAt).toLocaleString() : 'earlier';
    $('vibesCacheLine').textContent = `Cached result from ${when} — click the badge on the page to refresh.`;
    $('vibesCacheLine').classList.remove('hidden');
  } else {
    $('vibesCacheLine').classList.add('hidden');
  }

  $('vibesPathTag').textContent = `${vibesPathLabel(r)} · no single claim to verify here`;

  if (isLegacyVibesResult(r)) {
    renderLegacyVibesResult(r);
  } else {
    renderUnifiedVibesResult(r);
  }

  if (r.tokenUsage) {
    const t = r.tokenUsage;
    const fetched = r.commentsFetched != null ? r.commentsFetched : '?';
    const analyzed = r.commentsAnalyzed != null ? r.commentsAnalyzed : '?';
    const vol = r.evidence_volume ? ` · ${r.evidence_volume} evidence` : '';
    $('vibesUsageLine').textContent =
      `${analyzed}/${fetched} comments sent to model${vol} · ${t.totalTokens} tokens (${t.promptTokens} in / ${t.completionTokens} out) · ~$${(r.estCostUSD || 0).toFixed(5)}`;
  } else {
    $('vibesUsageLine').textContent = '';
  }

  // Communities CTA — opt-in (click-triggered), free (no synthesis LLM
  // call), relabeled from the consensus path's Reddit button per user
  // preference to keep it opt-in everywhere but describe the task
  // correctly for this path.
  const communitiesBusy = communitiesState.status === 'searching';
  $('communitiesBtn').classList.remove('hidden');
  $('communitiesBtn').disabled = communitiesBusy;
  $('communitiesBtn').textContent = communitiesBusy
    ? 'Finding communities…'
    : 'Find relevant Reddit communities';

  if (communitiesState.status === 'searching') {
    $('communitiesStatus').textContent = 'Searching Reddit for relevant communities…';
  } else if (communitiesState.status === 'error') {
    $('communitiesStatus').textContent = 'Search failed: ' + (communitiesState.error || 'unknown error');
  } else {
    $('communitiesStatus').textContent = '';
  }

  renderCommunitiesResult(communitiesState.result);
}

// Current (unified) vibes schema: consensus_lean/agreement_strength/
// consensus_type/caveat/authenticity_flag/notable_quotes/summary.
function renderUnifiedVibesResult(r) {
  $('vibeModeBox').classList.add('hidden');
  $('hotspotsModeBox').classList.add('hidden');
  $('consensusModeBox').classList.remove('hidden');

  if (r.authenticity_flag) {
    const lean = r.authenticity_flag.lean;
    $('authenticityBox').classList.remove('hidden');
    $('authenticityLabel').className = 'consensus-lean-label ' + (AUTHENTICITY_LEAN_CLASS[lean] || 'lean-none');
    $('authenticityLabel').textContent = lean === 'Disputed' ? 'Authenticity: Disputed' : `Likely ${lean}`;
    $('authenticityNote').textContent = r.authenticity_flag.note || '';
  } else {
    $('authenticityBox').classList.add('hidden');
  }

  const leanLabel = $('consensusLeanLabel');
  leanLabel.className = 'consensus-lean-label ' + (CONSENSUS_LEAN_CLASS[r.consensus_lean] || 'lean-none');
  const strengthTag = r.agreement_strength ? ` · ${r.agreement_strength} agreement` : '';
  leanLabel.textContent = `${r.consensus_lean}${strengthTag}`;

  $('consensusTypeTag').textContent = r.consensus_type === 'Split-Opinion' ? 'Split opinion — genuinely divided' : '';
  $('consensusTypeTag').classList.toggle('hidden', r.consensus_type !== 'Split-Opinion');

  $('consensusSummary').textContent = r.summary || '';

  if (r.caveat) {
    $('caveatLine').textContent = `Worth noting: ${r.caveat}`;
    $('caveatLine').classList.remove('hidden');
  } else {
    $('caveatLine').classList.add('hidden');
  }

  const quotes = Array.isArray(r.notable_quotes) ? r.notable_quotes : [];
  const block = $('notableQuotesBlock');
  const list = $('notableQuotesList');
  list.innerHTML = '';
  if (!quotes.length) {
    block.classList.add('hidden');
  } else {
    block.classList.remove('hidden');
    quotes.forEach(q => {
      const li = document.createElement('li');
      if (q.moment) {
        const span = document.createElement('span');
        span.className = 'hotspot-moment';
        span.textContent = q.moment;
        li.appendChild(span);
      }
      li.appendChild(document.createTextNode(q.point));
      list.appendChild(li);
    });
  }
}

// Legacy (pre-unification) vibes schema — a cached result from before this
// change, left on disk as-is per product decision (no migration). Renders
// via the same markup the old popup used, which stays in popup.html
// specifically to support this path indefinitely.
function renderLegacyVibesResult(r) {
  $('consensusModeBox').classList.add('hidden');
  $('authenticityBox').classList.add('hidden');

  const isMusic = r.mode === 'vibe';
  $('vibeModeBox').classList.toggle('hidden', !isMusic);
  $('hotspotsModeBox').classList.toggle('hidden', isMusic);

  if (isMusic) {
    $('vibeSummary').textContent = r.vibe_summary || '';
    const tagsEl = $('moodTags');
    tagsEl.innerHTML = '';
    (r.mood_tags || []).forEach(tag => {
      const span = document.createElement('span');
      span.className = 'mood-tag';
      span.textContent = tag;
      tagsEl.appendChild(span);
    });
    fillList('notableMomentsBlock', 'notableMomentsList', r.notable_moments);
  } else {
    $('overallTone').textContent = r.overall_tone || '';
    const hotspots = Array.isArray(r.hotspots) ? r.hotspots : [];
    const block = $('hotspotsBlock');
    const list = $('hotspotsList');
    list.innerHTML = '';
    if (!hotspots.length) {
      block.classList.add('hidden');
    } else {
      block.classList.remove('hidden');
      hotspots.forEach(h => {
        const li = document.createElement('li');
        if (h.moment) {
          const span = document.createElement('span');
          span.className = 'hotspot-moment';
          span.textContent = h.moment;
          li.appendChild(span);
        }
        li.appendChild(document.createTextNode(h.topic));
        list.appendChild(li);
      });
    }
  }
}

function renderCommunitiesResult(result) {
  if (!result || !result.communities || !result.communities.length) {
    $('communitiesBox').classList.add('hidden');
    return;
  }
  $('communitiesBox').classList.remove('hidden');
  const list = $('communitiesList');
  list.innerHTML = '';
  result.communities.forEach(c => {
    const li = document.createElement('li');
    const safeUrl = isHttpUrl(c.url) ? c.url : null;
    const subCount = c.subscribers ? ` (${c.subscribers.toLocaleString()} members)` : '';
    if (safeUrl) {
      const a = document.createElement('a');
      a.href = safeUrl;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = `r/${c.name}`;
      li.appendChild(a);
      li.appendChild(document.createTextNode(`${subCount}: ${c.description || ''}`));
    } else {
      li.textContent = `r/${c.name}${subCount}: ${c.description || ''}`;
    }
    list.appendChild(li);
  });
}

function isHttpUrl(str) {
  if (!str) return false;
  try {
    const u = new URL(str);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

function redditVerdictClass(v) {
  if (v === 'Corroborates') return 'rv-good';
  if (v === 'Partially Corroborates' || v === 'Mixed') return 'rv-mid';
  if (v === 'Contradicts') return 'rv-bad';
  return 'rv-none';
}

function renderRedditResult(r, fromCache, cachedAt) {
  if (!r) {
    $('redditBox').classList.add('hidden');
    return;
  }
  $('redditBox').classList.remove('hidden');

  const label = $('redditVerdictLabel');
  label.className = 'reddit-verdict-label ' + redditVerdictClass(r.reddit_verdict);
  const cacheTag = fromCache ? ` (cached${cachedAt ? ', ' + new Date(cachedAt).toLocaleString() : ''})` : '';
  label.textContent = `Reddit says: ${r.reddit_verdict}${cacheTag}`;

  $('redditSummary').textContent = r.reddit_summary || '';

  if (r.reddit_recommendation) {
    $('redditRecText').textContent = r.reddit_recommendation;
    $('redditRecBox').classList.remove('hidden');
  } else {
    $('redditRecBox').classList.add('hidden');
  }

  const list = $('redditCitations');
  list.innerHTML = '';
  (r.citations || []).forEach(c => {
    const li = document.createElement('li');
    const safeUrl = isHttpUrl(c.url) ? c.url : null;
    if (safeUrl) {
      const a = document.createElement('a');
      a.href = safeUrl;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = `r/${c.subreddit}`;
      li.appendChild(a);
      li.appendChild(document.createTextNode(': ' + (c.note || c.title || '')));
    } else {
      li.textContent = `r/${c.subreddit || '?'}: ${c.note || c.title || ''}`;
    }
    list.appendChild(li);
  });

  if (r.tokenUsage) {
    const t = r.tokenUsage;
    $('redditUsageLine').textContent =
      `${r.threadsSearched || 0} thread(s) checked · ${t.totalTokens} tokens · ~$${(r.estCostUSD || 0).toFixed(5)}` +
      (r.query ? ` · searched: "${r.query}"` : '');
  } else {
    $('redditUsageLine').textContent =
      (r.threadsSearched != null ? `${r.threadsSearched} thread(s) checked · no LLM call needed` : '') +
      (r.query ? ` · searched: "${r.query}"` : '');
  }
}

function fillList(blockId, listId, items) {
  const block = $(blockId);
  const list = $(listId);
  list.innerHTML = '';
  if (!items || !items.length) {
    block.classList.add('hidden');
    return;
  }
  block.classList.remove('hidden');
  items.forEach(text => {
    const li = document.createElement('li');
    li.textContent = text;
    list.appendChild(li);
  });
}

function send(msg) {
  return chrome.tabs.sendMessage(activeTabId, msg);
}

async function sendWithRecovery(msg) {
  try {
    return await send(msg);
  } catch (e) {
    if (!/Receiving end does not exist/.test(e.message || '')) throw e;
    // Content script wasn't injected (tab predates the extension load/reload).
    // Inject it now, give it a beat to register listeners, then retry once.
    await chrome.scripting.executeScript({
      target: { tabId: activeTabId },
      files: ['content.js']
    });
    await chrome.scripting.insertCSS({
      target: { tabId: activeTabId },
      files: ['content.css']
    });
    await new Promise(r => setTimeout(r, 300));
    return send(msg);
  }
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url || !/^https:\/\/www\.youtube\.com\/watch/.test(tab.url)) {
    $('notYoutube').classList.remove('hidden');
    $('app').classList.add('hidden');
    return;
  }
  activeTabId = tab.id;
  $('app').classList.remove('hidden');

  try {
    const resp = await sendWithRecovery({ type: 'GET_STATE' });
    if (resp?.ok) renderState(resp.state);
  } catch (e) {
    setStatus('Reload the YouTube tab, then reopen this popup.');
  }
}

$('settingsBtn').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('dashboardBtn').addEventListener('click', () =>
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') })
);

$('analyzeBtn').addEventListener('click', async () => {
  $('analyzeBtn').disabled = true;
  setStatus('Working…');
  try {
    const resp = await sendWithRecovery({ type: 'ANALYZE' });
    if (resp?.ok) renderState(resp.state);
    else setStatus('Error: ' + resp?.error);
  } catch (e) {
    setStatus('Failed: ' + e.message);
  }
});

// Reddit cross-validation — talks directly to background.js (like Options'
// model-fetch and the dashboard's guidance calls do), not through
// content.js: it needs no page access, just the title/videoId/verdict we
// already have in hand, and background.js is where the CORS-exempt fetch
// to reddit.com has to happen anyway (see manifest host_permissions).
async function preloadCachedReddit(videoId) {
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'GET_CACHED_REDDIT', payload: { videoId } });
    if (resp?.ok && resp.cached && redditState.videoId === videoId && redditState.status === 'idle') {
      redditState.result = resp.cached.result;
      redditState.fromCache = true;
      redditState.cachedAt = resp.cached.ts || null;
      if (lastState && lastState.videoId === videoId) renderState(lastState);
    }
  } catch (e) {
    console.warn('Reddit cache preload failed:', e);
  }
}

$('redditBtn').addEventListener('click', async () => {
  if (!lastState || !lastState.result || redditState.status === 'validating') return;
  redditState.status = 'validating';
  redditState.error = null;
  renderState(lastState);
  try {
    const resp = await chrome.runtime.sendMessage({
      type: 'VALIDATE_WITH_REDDIT',
      payload: {
        title: lastState.title,
        videoId: lastState.videoId,
        url: lastState.url || null,
        ytResult: lastState.result
      }
    });
    if (!resp?.ok) throw new Error(resp?.error || 'Unknown error');
    redditState.result = resp.result;
    redditState.status = 'done';
    redditState.fromCache = false;
    redditState.cachedAt = null;
  } catch (e) {
    redditState.status = 'error';
    redditState.error = e.message || String(e);
  }
  if (lastState) renderState(lastState);
});

// Opt-in community lookup for the vibes path — sibling to the Reddit
// validation handler above, same click-to-fetch UX, but free (no
// synthesis LLM call, just a subreddit search).
$('communitiesBtn').addEventListener('click', async () => {
  if (!lastState || !lastState.result || communitiesState.status === 'searching') return;
  communitiesState.status = 'searching';
  communitiesState.error = null;
  renderState(lastState);
  try {
    const resp = await chrome.runtime.sendMessage({
      type: 'FIND_COMMUNITIES',
      payload: {
        title: lastState.title,
        category: lastState.category,
        keywords: lastState.keywords,
        description: lastState.description,
        ytResult: lastState.result
      }
    });
    if (!resp?.ok) throw new Error(resp?.error || 'Unknown error');
    communitiesState.result = resp.result;
    communitiesState.status = 'done';
  } catch (e) {
    communitiesState.status = 'error';
    communitiesState.error = e.message || String(e);
  }
  if (lastState) renderState(lastState);
});

init();
