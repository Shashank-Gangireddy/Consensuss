// content.js — runs on youtube.com. Scrapes title/comments, injects badge, talks to popup+background.
//
// Comment fetching strategy:
//   1. PRIMARY: call YouTube's internal "next" continuation endpoint directly
//      (the same endpoint the page itself uses for infinite-scroll comments).
//      This requires no scrolling/visible page movement. The API key + client
//      context needed for that call live in the page's own JS globals
//      (ytcfg/ytInitialData), which are only reachable from a MAIN-world
//      script — see page-bridge.js — so we ask it for those via postMessage.
//   2. FALLBACK: if the API path fails for any reason (YouTube changed its
//      internal response shape, network hiccup, etc.), we transparently fall
//      back to the old scroll-and-scrape-the-DOM approach so the feature
//      never just breaks.

(function () {
  if (window.__ycrInjected) return;
  window.__ycrInjected = true;

  const DEFAULT_FETCH_TARGET = 100; // per pool (top + newest) — fallback ONLY when the video's total comment count can't be read (see pickFetchTarget below, which is the normal path)

  // ---------------------------------------------------------------------
  // Dynamic fetch sizing — scale how many comments we pull per pool to the
  // video's OWN total comment count, instead of always fetching the same
  // fixed 100/pool regardless of whether the video has 40 comments or
  // 400,000. A small video gets everything available (nothing to gain by
  // "trying" for 100 that don't exist); a huge video gets a bigger sample
  // so the consensus/vibes verdict isn't drawn from an unrepresentative
  // sliver. Tiers chosen conservatively — cost/latency still matter, so
  // this grows sub-linearly and caps out, it doesn't scale indefinitely.
  // Total count is read from YouTube's own comments-panel header
  // (`contextualInfo`, e.g. "2.4M") right next to the sort tokens — see
  // findCommentSortTokens() below — confirmed against a live page rather
  // than assumed from the response shape.
  // ---------------------------------------------------------------------
  const FETCH_TIERS = [
    { max: 30, target: 20 },      // tiny — just try to get everything that exists
    { max: 500, target: 120 },    // raised from 100 — bigger raw pool before filtration
    { max: 5000, target: 220 },   // raised from 175
    { max: 50000, target: 300 },  // raised from 225
    { max: Infinity, target: 350 } // hard cap — raised from 250, still bounded for network/token cost
  ];

  function pickFetchTarget(totalCommentCount) {
    if (totalCommentCount == null || !isFinite(totalCommentCount) || totalCommentCount <= 0) {
      return DEFAULT_FETCH_TARGET; // count unreadable — fall back to the old fixed behavior
    }
    for (const tier of FETCH_TIERS) {
      if (totalCommentCount <= tier.max) return tier.target;
    }
    return DEFAULT_FETCH_TARGET;
  }

  // Parses YouTube's compact count text ("2.4M", "48,461", "150K") into a
  // plain number. Same shape of parsing background.js's parseLikeCount does
  // for comment like-counts, duplicated here because content.js and
  // background.js are separate injected scripts with no shared module.
  function parseCountText(raw) {
    if (raw == null) return null;
    const s = String(raw).trim().toUpperCase().replace(/,/g, '');
    if (!s) return null;
    const m = s.match(/^([\d.]+)\s*([KM]?)$/);
    if (!m) return null;
    const num = parseFloat(m[1]);
    if (isNaN(num)) return null;
    if (m[2] === 'K') return Math.round(num * 1_000);
    if (m[2] === 'M') return Math.round(num * 1_000_000);
    return Math.round(num);
  }

  let state = freshState();
  // Persists across freshState() resets (unlike state.title) so a newly
  // detected video's first title read can be checked against what was
  // showing before — see getTitle()'s staleness problem noted below.
  let lastConfirmedTitle = '';

  function freshState() {
    return {
      videoId: getVideoId(),
      title: '',
      url: location.href,
      comments: [],
      topCount: 0,    // how many of `comments` came from the "Top" (like-ranked) pool
      newestCount: 0, // how many came from the "Newest" (chronological) pool
      status: 'idle', // idle | scraping | analyzing | done | error
      result: null,
      error: null,
      fetchMethod: null, // 'api' | 'dom'
      category: null,    // YouTube's own official category (Gaming, Music, etc.)
      keywords: [],       // uploader-supplied tags
      description: '',    // video description — page-bridge.js extracts this; threaded through here so a Reddit community search can pull uploader #hashtags out of it (previously read then dropped before reaching background.js)
      totalCommentCount: null, // video's own total comment count, read from the page header — drives dynamic fetch/send sizing (see pickFetchTarget)
      fromCache: false,   // true if `result` came from the per-video cache, not a fresh call
      cachedAt: null,      // timestamp of the cached analysis, when fromCache
      cacheChecked: false // whether a cache lookup has already been kicked off for this video
    };
  }

  function getVideoId() {
    try {
      return new URL(location.href).searchParams.get('v');
    } catch {
      return null;
    }
  }

  function isWatchPage() {
    return location.pathname === '/watch' && !!getVideoId();
  }

  function getTitle() {
    const selectors = [
      'h1.ytd-watch-metadata yt-formatted-string',
      'ytd-watch-metadata h1 yt-formatted-string',
      'ytd-watch-metadata h1',
      '#title h1',
      'h1.title'
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.textContent.trim()) return el.textContent.trim();
    }
    const fallback = document.title.replace(/ - YouTube$/, '').trim();
    // "YouTube" (with no " - <title>" suffix) means the tab title hasn't
    // updated yet — not a real video title. Treat it as "still unknown"
    // rather than a truthy-but-wrong value that would stop retries.
    if (!fallback || fallback === 'YouTube') return '';
    return fallback;
  }

  function findTitleAnchor() {
    const selectors = ['ytd-watch-metadata h1', '#title h1', 'h1.ydt-watch-metadata', 'h1.title'];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) return el.closest('#title') || el;
    }
    return null;
  }

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  // ---------------------------------------------------------------------
  // API-based comment fetching (primary path)
  // ---------------------------------------------------------------------
  //
  // Handshake with page-bridge.js: the bridge (MAIN world) publishes the
  // extracted ytcfg/ytInitialData context to a DOM attribute
  // (documentElement.dataset.ycrContext) rather than only answering a
  // postMessage RPC. Reading a DOM attribute from the isolated content-
  // script world is synchronous and can't "miss" a message the way a
  // postMessage round-trip can (e.g. content.js posts its request before
  // the bridge's listener is registered, or the response arrives after the
  // timeout already fired) — that race was the main source of "Timed out
  // waiting for page context (bridge not ready)". We still poll with a few
  // short, increasing delays because the bridge's *first* publish can land
  // before ytInitialData/ytcfg are actually populated, and fall back to the
  // legacy postMessage RPC only if the DOM attribute path never works at all.

  function readContextFromDom() {
    const raw = document.documentElement.dataset.ycrContext;
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  function requestFreshPublish() {
    try {
      window.postMessage({ type: 'YCR_REQUEST_PUBLISH' }, window.location.origin);
    } catch {
      // ignore — worst case we just wait for the bridge's own heartbeat
    }
  }

  function getYtContextOnce(timeoutMs) {
    return new Promise((resolve, reject) => {
      const requestId = 'ycr_' + Math.random().toString(36).slice(2);
      const timeout = setTimeout(() => {
        window.removeEventListener('message', onMsg);
        reject(new Error('Timed out waiting for page context (bridge not ready)'));
      }, timeoutMs);

      function onMsg(event) {
        if (event.source !== window) return;
        if (event.origin !== window.location.origin) return; // reject cross-origin senders (e.g. an embedded iframe)
        const data = event.data;
        if (!data || data.type !== 'YCR_YT_CONTEXT' || data.requestId !== requestId) return;
        clearTimeout(timeout);
        window.removeEventListener('message', onMsg);
        if (data.error) reject(new Error(data.error));
        else resolve(data.payload);
      }

      window.addEventListener('message', onMsg);
      window.postMessage({ type: 'YCR_GET_YT_CONTEXT', requestId }, window.location.origin);
    });
  }

  // Primary: poll the DOM attribute the bridge keeps published, with a
  // fresh-publish nudge up front. Falls back to the postMessage RPC (with
  // its own retry) only if the attribute never yields usable data — covers
  // the unlikely case of something blocking dataset writes.
  async function getYtContext() {
    requestFreshPublish();
    const delays = [0, 60, 150, 300, 500, 800, 1200, 1800];
    let lastError = null;
    for (let i = 0; i < delays.length; i++) {
      if (delays[i]) await sleep(delays[i]);
      const ctx = readContextFromDom();
      if (ctx) {
        if (ctx.payload) return ctx.payload;
        if (ctx.error) lastError = ctx.error;
      }
    }

    try {
      return await getYtContextOnce(1500);
    } catch (err) {
      throw new Error(lastError || (err && err.message) || 'Timed out waiting for page context (bridge not ready)');
    }
  }

  // Recursively walk an object/array, yielding every value found under `key`.
  function* findAllByKey(obj, key, _seen = new WeakSet()) {
    if (!obj || typeof obj !== 'object') return;
    if (_seen.has(obj)) return;
    _seen.add(obj);
    if (Array.isArray(obj)) {
      for (const item of obj) yield* findAllByKey(item, key, _seen);
      return;
    }
    for (const k of Object.keys(obj)) {
      if (k === key) yield obj[k];
      else if (obj[k] && typeof obj[k] === 'object') yield* findAllByKey(obj[k], key, _seen);
    }
  }

  // Find the continuation tokens that kick off the comments section, for
  // BOTH sort orders YouTube exposes ("Top" and "Newest"), PLUS the video's
  // total comment count shown in that same panel header (e.g. "2.4M",
  // "48,461") — confirmed live against youtube.com's actual response shape
  // (header.engagementPanelTitleHeaderRenderer.contextualInfo), not
  // assumed. Returns { topToken, newestToken, totalCommentCount }; any of
  // the three can be null if not found. Locating tokens from the same
  // sortFilterSubMenuRenderer lets us fetch two differently-ordered comment
  // pools (see gatherBalancedComments below) instead of just one, for a
  // less like-count-skewed sample.
  function findCommentSortTokens(ytInitialData) {
    if (!ytInitialData) return { topToken: null, newestToken: null, totalCommentCount: null };

    const panels = ytInitialData.engagementPanels;
    if (Array.isArray(panels)) {
      for (const panel of panels) {
        const renderer = panel && panel.engagementPanelSectionListRenderer;
        const id = renderer && (renderer.panelIdentifier || renderer.targetId || '');
        if (!id || !/comment/i.test(id)) continue;

        const titleHeader = renderer.header?.engagementPanelTitleHeaderRenderer;
        const countText = titleHeader?.contextualInfo ? textFromRuns(titleHeader.contextualInfo) : '';
        const totalCommentCount = countText ? parseCountText(countText) : null;

        const subMenu = titleHeader?.menu?.sortFilterSubMenuRenderer;
        const items = subMenu?.subMenuItems;
        if (Array.isArray(items) && items.length) {
          // Prefer LIST POSITION over the `selected` flag: YouTube always
          // lists "Top comments" first and "Newest first" second as a
          // fixed UI/product decision (verified against a live response),
          // whereas `selected` reflects whatever sort the current
          // user/session actually has active and could default to
          // "Newest" for some accounts — using it as the primary signal
          // would silently swap which pool is "top" vs "newest" for those
          // users. Title text is checked first as a belt-and-suspenders
          // English-locale confirmation when present, but index order is
          // the fallback that always works.
          let topToken = null;
          let newestToken = null;
          items.forEach((item, i) => {
            const tok = item?.serviceEndpoint?.continuationCommand?.token;
            if (typeof tok !== 'string' || tok.length <= 20) return;
            const title = (item?.title?.simpleText || '').toLowerCase();
            if (/top/.test(title)) topToken = tok;
            else if (/new/.test(title)) newestToken = tok;
            else if (i === 0 && !topToken) topToken = tok;
            else if (i === 1 && !newestToken) newestToken = tok;
          });
          if (topToken || newestToken) return { topToken, newestToken, totalCommentCount };
        }

        // No sort sub-menu found (older/AB-tested layout) — fall back to
        // whatever single initial token findAllByKey can locate, treated
        // as the "top" pool since that's YouTube's default sort.
        for (const token of findAllByKey(renderer, 'token')) {
          if (typeof token === 'string' && token.length > 20) {
            return { topToken: token, newestToken: null, totalCommentCount };
          }
        }
      }
    }

    // Last-resort fallback: any continuation token anywhere near something
    // comment-ish, same heuristic findInitialCommentsToken used to use.
    for (const section of findAllByKey(ytInitialData, 'itemSectionRenderer')) {
      const idFields = JSON.stringify(section).slice(0, 400);
      if (/comment/i.test(section.sectionIdentifier || '') || /comment/i.test(idFields)) {
        for (const token of findAllByKey(section, 'token')) {
          if (typeof token === 'string' && token.length > 20) {
            return { topToken: token, newestToken: null, totalCommentCount: null };
          }
        }
      }
    }

    return { topToken: null, newestToken: null, totalCommentCount: null };
  }

  function textFromRuns(node) {
    if (!node) return '';
    if (typeof node.simpleText === 'string') return node.simpleText;
    if (Array.isArray(node.runs)) return node.runs.map(r => r.text || '').join('');
    return '';
  }

  // Parse one "next" endpoint response: returns { comments, nextToken }
  function parseCommentsResponse(json) {
    const comments = [];
    let nextToken = null;

    const endpoints = json.onResponseReceivedEndpoints || json.onResponseReceivedActions || [];
    for (const endpoint of endpoints) {
      const cmd =
        endpoint.reloadContinuationItemsCommand ||
        endpoint.appendContinuationItemsAction ||
        null;
      if (!cmd || !Array.isArray(cmd.continuationItems)) continue;

      for (const item of cmd.continuationItems) {
        if (item.commentThreadRenderer) {
          const commentRenderer =
            item.commentThreadRenderer.comment?.commentRenderer ||
            item.commentThreadRenderer.commentViewModel;
          // Modern payload shape (2024+): commentThreadRenderer.commentViewModel is a
          // lightweight ref; actual text/vote data lives in json.frameworkUpdates
          // mutations keyed by that id. Try classic shape first.
          if (item.commentThreadRenderer.comment?.commentRenderer) {
            const cr = item.commentThreadRenderer.comment.commentRenderer;
            const text = textFromRuns(cr.contentText).trim();
            if (text) {
              comments.push({
                text,
                likes: textFromRuns(cr.voteCount) || String(cr.likeCount || '')
              });
            }
          }
        } else if (item.continuationItemRenderer) {
          for (const token of findAllByKey(item.continuationItemRenderer, 'token')) {
            if (typeof token === 'string' && token.length > 20) {
              nextToken = token;
              break;
            }
          }
        }
      }
    }

    // Modern "commentViewModel" payloads store the actual comment text/votes in
    // frameworkUpdates.entityBatchUpdate.mutations, keyed by an entity id
    // referenced from the commentViewModel. Handle that shape too.
    if (comments.length === 0 && json.frameworkUpdates) {
      const byKey = {};
      for (const payload of findAllByKey(json.frameworkUpdates, 'commentEntityPayload')) {
        const key = payload?.key;
        const props = payload?.properties;
        const toolbar = payload?.toolbar; // NOTE: sibling of `properties`, not nested inside it
        if (key && props) {
          const content = props.content;
          const text = typeof content === 'object' ? (content.content || textFromRuns(content)) : '';
          byKey[key] = {
            text: (text || '').toString(),
            likes: toolbar?.likeCountLiked || toolbar?.likeCountNotliked || ''
          };
        }
      }
      Object.values(byKey).forEach(c => {
        if (c.text && c.text.trim()) comments.push({ text: c.text.trim(), likes: c.likes || '' });
      });
    }

    return { comments, nextToken };
  }

  // Fetches ONE comment pool starting from a given continuation token
  // (paginating via nextToken same as before). Used for both the "top"
  // and "newest" pools by gatherBalancedComments() below — token/label are
  // now explicit parameters instead of always looking up the initial
  // (default-sort) token internally, so the same pagination logic serves
  // either sort order.
  async function fetchCommentPoolViaApi(target, ctx, startToken, onProgress) {
    let token = startToken;
    if (!token) throw new Error('Could not locate comments continuation token');

    const collected = [];
    let attempts = 0;
    const seen = new Set();

    while (collected.length < target && token && attempts < 15) {
      attempts++;
      const url = `https://www.youtube.com/youtubei/v1/next?key=${encodeURIComponent(ctx.apiKey)}&prettyPrint=false`;
      const res = await fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Format-Version': '2',
          ...(ctx.clientVersion ? { 'X-Youtube-Client-Version': ctx.clientVersion } : {})
        },
        body: JSON.stringify({ context: ctx.context, continuation: token })
      });
      if (!res.ok) throw new Error(`YouTube internal API returned ${res.status}`);
      const json = await res.json();
      const { comments, nextToken } = parseCommentsResponse(json);

      for (const c of comments) {
        const key = c.text.slice(0, 120);
        if (!seen.has(key)) {
          seen.add(key);
          collected.push(c);
        }
      }
      if (onProgress) onProgress(collected.length);

      if (!nextToken || nextToken === token) break;
      token = nextToken;
      await sleep(150); // be polite, avoid hammering
    }

    if (collected.length === 0) throw new Error('API path returned zero comments');
    return collected.slice(0, target);
  }

  // Fetches BOTH the "Top" (like-count-ranked) and "Newest" (chronological)
  // comment pools and merges them, deduped, into one balanced sample —
  // rather than a single like-sorted pool, which structurally biases
  // toward old, already-popular comments and can miss what people are
  // saying more recently/generally. Each pool independently falls back to
  // whatever token IS available if one sort is missing (e.g. an unusual
  // page layout only exposed one), so this still works when only one pool
  // is fetchable — it just won't be "balanced" in that case.
  async function fetchBalancedCommentsViaApi(targetPerPool, ctx, onProgress) {
    if (!ctx || !ctx.apiKey || !ctx.context) {
      throw new Error('Could not read YouTube page context (ytcfg unavailable)');
    }

    let { topToken, newestToken, totalCommentCount } = findCommentSortTokens(ctx.initialData);
    if (!topToken && !newestToken) {
      // Same retry-on-missing-panel pattern as the old single-token path —
      // ytInitialData's comments engagement panel can populate a beat
      // after ytcfg/videoDetails do.
      for (const delay of [200, 500]) {
        requestFreshPublish();
        await sleep(delay);
        const fresh = readContextFromDom();
        if (fresh && fresh.payload && fresh.payload.initialData) {
          const tokens = findCommentSortTokens(fresh.payload.initialData);
          topToken = tokens.topToken;
          newestToken = tokens.newestToken;
          if (tokens.totalCommentCount != null) totalCommentCount = tokens.totalCommentCount;
          if (topToken || newestToken) break;
        }
      }
    }
    if (!topToken && !newestToken) throw new Error('Could not locate comments continuation token');

    // Re-derive the fetch target from the video's ACTUAL total comment
    // count now that we've read it, rather than whatever the caller
    // guessed before this was known (see scrapeComments below, which
    // passes its best-effort initial target in but expects this function
    // to refine it once the real count is in hand).
    const resolvedTarget = pickFetchTarget(totalCommentCount) || targetPerPool;

    let topComments = [];
    let newestComments = [];
    let topError = null;
    let newestError = null;

    if (topToken) {
      try {
        topComments = await fetchCommentPoolViaApi(resolvedTarget, ctx, topToken, n => onProgress && onProgress(n, newestComments.length));
      } catch (err) {
        topError = err;
      }
    }
    if (newestToken) {
      try {
        newestComments = await fetchCommentPoolViaApi(resolvedTarget, ctx, newestToken, n => onProgress && onProgress(topComments.length, n));
      } catch (err) {
        newestError = err;
      }
    }

    if (!topComments.length && !newestComments.length) {
      throw new Error((topError && topError.message) || (newestError && newestError.message) || 'API path returned zero comments');
    }

    // Merge + dedupe (a comment can legitimately appear in both pools —
    // e.g. a recent comment that's already popular enough to also be
    // "top"). Tag provenance so downstream selection/prompting can see the
    // pool mix without re-deriving it.
    const seen = new Set();
    const merged = [];
    for (const c of topComments) {
      const key = c.text.slice(0, 120);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push({ ...c, pool: 'top' });
    }
    for (const c of newestComments) {
      const key = c.text.slice(0, 120);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push({ ...c, pool: 'newest' });
    }

    return { comments: merged, topCount: topComments.length, newestCount: newestComments.length, totalCommentCount };
  }

  // ---------------------------------------------------------------------
  // DOM-scroll fallback (original approach)
  // ---------------------------------------------------------------------

  function scrapeVisibleComments() {
    const threads = document.querySelectorAll('ytd-comment-thread-renderer');
    const out = [];
    threads.forEach(thread => {
      const textEl = thread.querySelector('#content-text');
      const likesEl = thread.querySelector('#vote-count-middle');
      if (textEl && textEl.textContent.trim()) {
        out.push({
          text: textEl.textContent.trim(),
          likes: likesEl ? likesEl.textContent.trim() : ''
        });
      }
    });
    return out;
  }

  async function fetchCommentsViaDomScroll(target, onProgress) {
    window.scrollTo({ top: Math.min(1400, document.body.scrollHeight), behavior: 'instant' });
    await sleep(600);

    let attempts = 0;
    let comments = scrapeVisibleComments();
    while (comments.length < target && attempts < 25) {
      window.scrollBy({ top: 1200, behavior: 'instant' });
      await sleep(500);
      comments = scrapeVisibleComments();
      attempts++;
      if (onProgress) onProgress(comments.length);
    }
    return comments.slice(0, target);
  }

  // ---------------------------------------------------------------------
  // Orchestration
  // ---------------------------------------------------------------------

  async function scrapeComments(targetPerPool = 40) {
    state.status = 'scraping';
    state.comments = [];
    updateBadge();

    // Grab page context once and reuse it for both free metadata (category/
    // tags — no LLM cost) and the comments call. If this fails we still fall
    // through to DOM scraping for comments; category/keywords just stay null.
    let ctx = null;
    try {
      ctx = await getYtContext();
      if (ctx) {
        state.category = ctx.category || null;
        state.keywords = ctx.keywords || [];
        state.description = ctx.description || '';
      }
    } catch (err) {
      console.warn('[Consensus] Could not read page metadata (category/tags):', err);
    }

    try {
      if (!ctx) throw new Error('No page context available');
      const { comments, topCount, newestCount, totalCommentCount } = await fetchBalancedCommentsViaApi(targetPerPool, ctx, (topN, newestN) => {
        state.comments = new Array(topN + newestN); // progress only; real array set below
        updateBadge();
      });
      state.comments = comments;
      state.topCount = topCount;
      state.newestCount = newestCount;
      state.totalCommentCount = totalCommentCount != null ? totalCommentCount : state.totalCommentCount;
      state.fetchMethod = 'api';
    } catch (err) {
      console.warn('[Consensus] API comment fetch failed, falling back to DOM scroll:', err);
      // DOM-scroll fallback can only read whatever sort order the page is
      // currently displaying (usually "Top") — no balanced dual-pool fetch
      // possible here, so this stays a single pool, same as before.
      const comments = await fetchCommentsViaDomScroll(targetPerPool * 2, count => {
        badgeProgressText = `Reading comments… (${count})`;
        updateBadge();
      });
      state.comments = comments.map(c => ({ ...c, pool: 'top' }));
      state.topCount = state.comments.length;
      state.newestCount = 0;
      state.fetchMethod = 'dom';
      scrollBackToVideo();
    }

    state.status = 'idle';
    updateBadge();
    return state.comments;
  }

  function scrollBackToVideo() {
    const player = document.querySelector('#player') || document.querySelector('ytd-player');
    if (player) {
      player.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }

  // ---------------------------------------------------------------------
  // Per-video cache lookup — background.js owns the actual storage; this
  // just asks it whether this video already has a saved analysis so we can
  // show it instantly without re-scraping comments or spending on the LLM.
  // ---------------------------------------------------------------------

  async function tryLoadFromCache(vid) {
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'GET_CACHED_ANALYSIS', payload: { videoId: vid } });
      // The user may have navigated to a different video while this async
      // lookup was in flight, or a manual scrape/analyze may have already
      // started — only apply the cached result if still relevant.
      if (resp?.ok && resp.cached && state.videoId === vid && state.status === 'idle' && !state.result) {
        state.result = resp.cached.result;
        state.status = 'done';
        state.fromCache = true;
        state.cachedAt = resp.cached.ts || null;
        updateBadge();
      }
    } catch (err) {
      console.warn('[Consensus] Cache lookup failed:', err);
    }
  }

  async function runAnalysis(opts = {}) {
    state.status = 'analyzing';
    state.error = null;
    updateBadge();
    try {
      const resp = await chrome.runtime.sendMessage({
        type: 'ANALYZE_CLAIM',
        payload: {
          title: state.title,
          comments: state.comments,
          videoId: state.videoId,
          url: location.href,
          category: state.category,
          keywords: state.keywords,
          totalCommentCount: state.totalCommentCount,
          topCount: state.topCount,       // how many of `comments` came from the "Top" pool — persisted to history so the dashboard can show the real fetch split even after a later cache-hit reload zeroes these out in live state
          newestCount: state.newestCount, // how many came from the "Newest" pool
          fetchMethod: state.fetchMethod, // 'api' (balanced top+newest) or 'dom' (fallback, top-only)
          userNote: opts.userNote || null,
          redoOfId: opts.redoOfId || null
        }
      });
      if (!resp?.ok) throw new Error(resp?.error || 'Unknown error');
      state.result = resp.result;
      state.status = 'done';
      state.fromCache = false; // this is a fresh result, not the cached one
      state.cachedAt = null;
    } catch (err) {
      state.error = String(err.message || err);
      state.status = 'error';
    }
    updateBadge();
    return state;
  }

  // ---- Badge UI ----
  let badgeProgressText = '';

  function removeBadge() {
    const el = document.getElementById('ycr-badge');
    if (el) el.remove();
  }

  function ratingClass(rating) {
    if (rating >= 8) return 'ycr-good';
    if (rating >= 4) return 'ycr-mid';
    return 'ycr-bad';
  }

  // Badge color class for a vibes-path result — keyed off consensus_lean
  // (or the authenticity lean when that's the more relevant read), reusing
  // the same good/mid/bad/idle classes the consensus path already defines
  // in content.css rather than inventing a parallel set.
  function vibesClass(result) {
    if (result.authenticity_flag) {
      const lean = result.authenticity_flag.lean;
      if (lean === 'Real') return 'ycr-good';
      if (lean === 'Staged') return 'ycr-bad';
      return 'ycr-mid'; // Disputed
    }
    if (result.consensus_lean === 'Positive') return 'ycr-good';
    if (result.consensus_lean === 'Negative') return 'ycr-bad';
    if (result.consensus_lean === 'Split') return 'ycr-mid';
    return 'ycr-idle'; // Insufficient Evidence — neutral, not a red flag
  }

  // Short badge text for a vibes-path result. Authenticity, when flagged,
  // IS the headline consensus question for that video (see the research
  // note on sports/viral-clip content) — surfaced ahead of the quality
  // lean rather than as a secondary detail. Otherwise: lean + strength
  // qualifier, except "Split" (inherently about disagreement, no strength
  // to qualify) and "Insufficient Evidence" (shown plain).
  function vibesBadgeText(result) {
    if (result.authenticity_flag) {
      const lean = result.authenticity_flag.lean;
      const label = lean === 'Real' ? 'Likely Real' : lean === 'Staged' ? 'Likely Staged' : 'Disputed';
      return label;
    }
    if (result.consensus_lean === 'Split') return 'Split opinion';
    if (result.consensus_lean === 'Insufficient Evidence') return 'Not enough signal';
    const strength = result.agreement_strength ? ` · ${result.agreement_strength}` : '';
    return `${result.consensus_lean}${strength}`;
  }

  function updateBadge() {
    let badge = document.getElementById('ycr-badge');
    const anchor = findTitleAnchor();
    if (!anchor) return;
    if (!badge) {
      badge = document.createElement('div');
      badge.id = 'ycr-badge';
      badge.addEventListener('click', onBadgeClick);
      anchor.insertAdjacentElement('afterend', badge);
    }
    badge.className = 'ycr-badge';
    if (state.status === 'scraping') {
      badge.classList.add('ycr-loading');
      badge.textContent = badgeProgressText || `Reading comments… (${state.comments.length})`;
    } else if (state.status === 'analyzing') {
      badge.classList.add('ycr-loading');
      badge.textContent = 'Rating claim…';
    } else if (state.status === 'done' && state.result && state.result.path === 'vibes') {
      badge.classList.add(vibesClass(state.result));
      const cacheTag = state.fromCache ? ' · cached' : '';
      badge.textContent = `${vibesBadgeText(state.result)}${cacheTag}`;
      badge.title = state.fromCache ? 'Cached result — click to re-analyze' : 'Click to re-analyze';
    } else if (state.status === 'done' && state.result) {
      badge.classList.add(ratingClass(state.result.rating));
      const fmt = state.result.video_format ? ` [${state.result.video_format}]` : '';
      const dim = state.result.rating_dimension ? ` (${state.result.rating_dimension})` : '';
      const vol = state.result.evidence_volume ? ` · ${state.result.evidence_volume} evidence` : '';
      const cacheTag = state.fromCache ? ' · cached' : '';
      badge.textContent = `${state.result.rating}/10${dim} — ${state.result.verdict}${fmt}${vol}${cacheTag}`;
      badge.title = state.fromCache ? 'Cached result — click to re-analyze' : 'Click to re-analyze';
    } else if (state.status === 'error') {
      badge.classList.add('ycr-bad');
      badge.textContent = `Rating failed — click for details`;
    } else {
      badge.classList.add('ycr-idle');
      badge.textContent = 'Rate this claim';
    }
  }

  async function onBadgeClick() {
    if (state.status === 'scraping' || state.status === 'analyzing') return;
    if (state.status === 'error') {
      alert('Consensus error: ' + state.error);
      return;
    }
    if (!state.comments.length) {
      await scrapeComments(DEFAULT_FETCH_TARGET);
    }
    await runAnalysis();
  }

  // ---- SPA navigation handling ----
  //
  // YouTube's watch page is a single-page app: clicking a new video (from
  // the sidebar, autoplay, end screen, etc.) does NOT trigger a real
  // navigation/reload — the URL and DOM are swapped in place. That means we
  // can't rely on any one signal to know "we're now looking at a different
  // video". We combine several:
  //   1. YouTube's own custom events (yt-navigate-finish fires on virtually
  //      every SPA transition; yt-page-data-updated is a second, slightly
  //      different signal some YouTube builds use instead/also).
  //   2. History API hooks (pushState/replaceState/popstate) — YouTube
  //      updates the URL via pushState on every video change, so patching
  //      these catches transitions even if YT's custom events don't fire.
  //   3. A cheap poll (every 1s) comparing the URL's video id against what
  //      we last rendered — this is the ultimate fallback and guarantees we
  //      can never get permanently stuck on a stale video, regardless of
  //      which YouTube build/event quirk is in play.
  function checkForNavigation() {
    if (!isWatchPage()) {
      if (state.videoId !== null || document.getElementById('ycr-badge')) {
        removeBadge();
        state = freshState();
        state.videoId = null;
      }
      return;
    }
    const vid = getVideoId();
    const isNewVideo = vid !== state.videoId;
    if (isNewVideo) {
      removeBadge(); // drop the old video's badge immediately, don't let it linger
      state = freshState();
    }
    // Always (re)try grabbing the title if we don't have a *confirmed* one
    // yet. On a fresh SPA video swap, YouTube updates the URL before it
    // updates the title DOM/tab title — so a getTitle() call made right
    // after isNewVideo fires can (and often does) still read back the
    // PREVIOUS video's title text. That's a non-empty, truthy string, so a
    // naive "!state.title" check would wrongly treat it as loaded and never
    // look again, leaving the badge stuck on the old title. Guard against
    // that by comparing each candidate to lastConfirmedTitle (the title
    // that was showing before this navigation) and only accepting it once
    // it differs — or, if nothing distinct shows up in time, accepting
    // whatever's there on the last attempt rather than leaving it blank.
    if (!state.title || state.title === lastConfirmedTitle) {
      const attempts = [0, 200, 400, 700, 1100, 1600, 2300, 3200];
      attempts.forEach((delay, i) => {
        setTimeout(() => {
          if (state.videoId !== vid) return; // navigated again meanwhile; abandon this chain
          if (state.title && state.title !== lastConfirmedTitle) return; // already confirmed by an earlier/faster attempt
          const candidate = getTitle();
          if (!candidate) return;
          const isLast = i === attempts.length - 1;
          if (candidate !== lastConfirmedTitle || isLast) {
            state.title = candidate;
            lastConfirmedTitle = candidate;
            updateBadge();
          }
        }, delay);
      });
    }
    if (isNewVideo || !document.getElementById('ycr-badge')) {
      updateBadge();
    }
    if (!state.cacheChecked) {
      state.cacheChecked = true;
      tryLoadFromCache(vid);
    }
  }

  document.addEventListener('yt-navigate-finish', checkForNavigation);
  document.addEventListener('yt-navigate-start', checkForNavigation);
  document.addEventListener('yt-page-data-updated', checkForNavigation);
  window.addEventListener('popstate', checkForNavigation);
  window.addEventListener('load', checkForNavigation);

  // Patch pushState/replaceState so we hear about YouTube's own client-side
  // URL changes, which is how it actually navigates between videos.
  (function hookHistory() {
    const wrap = fnName => {
      const original = history[fnName];
      history[fnName] = function (...args) {
        const result = original.apply(this, args);
        checkForNavigation();
        return result;
      };
    };
    wrap('pushState');
    wrap('replaceState');
  })();

  // Belt-and-suspenders poll — catches anything the above missed.
  setInterval(checkForNavigation, 1000);

  // Fallback observer for badge re-mounts within the same video (YouTube
  // sometimes rebuilds the title/metadata DOM without a full navigation).
  const mo = new MutationObserver(() => {
    if (isWatchPage() && !document.getElementById('ycr-badge')) {
      updateBadge();
    }
  });
  mo.observe(document.body, { childList: true, subtree: true });

  checkForNavigation();

  // ---- Messaging with popup ----
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    // Same sender-validation discipline as background.js's listener (OWASP
    // Insecure Message Passing guidance: treat every runtime message as
    // untrusted input, even though an external web page can't normally
    // reach a content script's onMessage listener without
    // externally_connectable declared, which this extension doesn't use).
    // sender.id is set by Chrome from the sending context's own extension
    // ID and can't be spoofed via the message payload.
    if (sender.id !== chrome.runtime.id) return;
    if (!isWatchPage()) {
      sendResponse({ ok: false, error: 'Not a YouTube watch page' });
      return;
    }
    if (msg.type === 'GET_STATE') {
      sendResponse({ ok: true, state });
      return;
    }
    if (msg.type === 'SCRAPE_COMMENTS') {
      scrapeComments(msg.target || DEFAULT_FETCH_TARGET).then(() => {
        sendResponse({ ok: true, state });
      });
      return true;
    }
    if (msg.type === 'ANALYZE') {
      (async () => {
        if (!state.comments.length) await scrapeComments(DEFAULT_FETCH_TARGET);
        await runAnalysis();
        sendResponse({ ok: true, state });
      })();
      return true;
    }
    if (msg.type === 'REDO_WITH_NOTE') {
      // Triggered from the dashboard after adding/editing a note on a past
      // analysis. Always re-scrapes fresh comments (a stale in-memory set
      // from a prior visit isn't good enough — the whole point is a genuine
      // redo) and passes the note through as an explicit correction the
      // model must address, plus a link back to the entry being corrected.
      (async () => {
        await scrapeComments(DEFAULT_FETCH_TARGET);
        await runAnalysis({ userNote: msg.userNote, redoOfId: msg.redoOfId });
        sendResponse({ ok: true, state });
      })();
      return true;
    }
  });
})();
