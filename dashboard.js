// dashboard.js

const $ = id => document.getElementById(id);

let history = [];
let redditLog = [];

function fmtDate(ts) {
  return new Date(ts).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
  });
}

function fmtCost(v) {
  if (v == null) return '-';
  return v < 0.01 ? `$${v.toFixed(5)}` : `$${v.toFixed(4)}`;
}

function ratingClass(r) {
  if (r >= 8) return 'rating-good';
  if (r >= 4) return 'rating-mid';
  return 'rating-bad';
}

function renderCards() {
  const n = history.length;
  // Vibes-path entries (path==='vibes') have rating/verdict as null by
  // design (see analyzeVibes() in background.js) — only average rating
  // over CONSENSUS entries, otherwise a vibes-heavy history silently drags
  // the average down toward 0 rather than reflecting real ratings.
  const consensusEntries = history.filter(h => h.path !== 'vibes');
  const totalTokens = history.reduce((a, h) => a + (h.totalTokens || 0), 0);
  const totalCost = history.reduce((a, h) => a + (h.estCostUSD || 0), 0);
  const avgTokens = n ? Math.round(totalTokens / n) : 0;
  const avgCost = n ? totalCost / n : 0;

  const redditCost = redditLog.reduce((a, h) => a + (h.estCostUSD || 0), 0);
  const totalCostAll = totalCost + redditCost;
  const vibesCount = n - consensusEntries.length;

  $('cards').innerHTML = `
    <div class="card"><div class="label">Analyses</div><div class="value">${n}${vibesCount ? ` <span class="muted" style="font-size:12px">(${consensusEntries.length} rated, ${vibesCount} vibes)</span>` : ''}</div></div>
    <div class="card"><div class="label">Total Tokens</div><div class="value">${totalTokens.toLocaleString()}</div></div>
    <div class="card"><div class="label">Total Est. Cost</div><div class="value">${fmtCost(totalCostAll)}</div></div>
    <div class="card"><div class="label">Avg / Analysis</div><div class="value">${avgTokens.toLocaleString()} tok · ${fmtCost(avgCost)}</div></div>
    <div class="card"><div class="label">Reddit Checks</div><div class="value">${redditLog.length} · ${fmtCost(redditCost)}</div></div>
  `;
}

// ---------------------------------------------------------------------
// Result-cell rendering — one column that adapts to whichever shape the
// entry actually is, instead of separate Rating/Verdict/Format columns
// per path (the old layout). Handles three shapes:
//   - consensus (path !== 'vibes'): rating/verdict, as before.
//   - unified vibes (path === 'vibes', has consensusLean): the new
//     consensus_lean/agreement_strength/authenticity shape.
//   - legacy vibes (path === 'vibes', no consensusLean): an old cached
//     entry from before the schema unification — left as-is on disk per
//     product decision, rendered via its old mode/summary fields.
// ---------------------------------------------------------------------

const LEAN_CLASS = {
  Positive: 'rating-good',
  Negative: 'rating-bad',
  Split: 'rating-mid',
  'Insufficient Evidence': 'rating-none'
};
const AUTH_LEAN_CLASS = { Real: 'rating-good', Staged: 'rating-bad', Disputed: 'rating-mid' };

function isLegacyVibesEntry(entry) {
  return entry.path === 'vibes' && entry.consensusLean === undefined;
}

function resultCell(entry) {
  if (entry.path !== 'vibes') {
    const flag = entry.criticalFlag
      ? ` <span class="rating-badge rating-badge-flag ${entry.criticalFlag.corroboration === 'Strong' ? 'rating-bad' : 'rating-mid'}" title="${escapeHtml(entry.criticalFlag.note || entry.criticalFlag.rule || '')}">⚠ ${escapeHtml(entry.criticalFlag.corroboration)}</span>`
      : '';
    // guidanceEnforcement is set by the code-side check in background.js —
    // the model acknowledged (or the text overlap detector caught) a
    // relevant guidance rule it didn't actually reflect in the rating, so
    // the displayed rating here is already the post-penalty value. Surface
    // it the same way as criticalFlag above so a downward-adjusted rating
    // is never silently indistinguishable from an unadjusted one.
    const ge = entry.guidanceEnforcement;
    const enforcement = ge
      ? ` <span class="rating-badge rating-badge-flag rating-mid" title="${escapeHtml((ge.unresolvedRules || []).map(u => u.rule).join(' | '))}">⬇ guidance (was ${ge.originalRating})</span>`
      : '';
    // Wrapped in a flex container so long combinations (rating + verdict +
    // flag + enforcement badges) wrap as whole chunks onto new lines rather
    // than the browser breaking mid-word/mid-badge in a narrow column.
    return `<span class="result-cell-inner"><span class="rating-badge ${ratingClass(entry.rating)}">${entry.rating}/10</span> <span class="muted result-verdict">${escapeHtml(entry.verdict || '')}</span>${flag}${enforcement}</span>`;
  }
  if (isLegacyVibesEntry(entry)) {
    return `<span class="muted">Vibes${entry.mode ? ' · ' + escapeHtml(entry.mode) : ''} (legacy)</span>`;
  }
  if (entry.authenticityLean) {
    const label = entry.authenticityLean === 'Disputed' ? 'Disputed' : `Likely ${entry.authenticityLean}`;
    return `<span class="result-cell-inner"><span class="rating-badge ${AUTH_LEAN_CLASS[entry.authenticityLean] || 'rating-none'}">${escapeHtml(label)}</span></span>`;
  }
  const lean = entry.consensusLean || 'Insufficient Evidence';
  const strength = entry.agreementStrength ? ` <span class="muted result-verdict">${escapeHtml(entry.agreementStrength)}</span>` : '';
  return `<span class="result-cell-inner"><span class="rating-badge ${LEAN_CLASS[lean] || 'rating-none'}">${escapeHtml(lean)}</span>${strength}</span>`;
}

// "Insight" column — merges the consensus path's crowd-pick recommendation
// and the vibes path's caveat into one slot, since both answer the same
// question ("is there one extra specific thing worth knowing beyond the
// headline result?"). Falls back to the plain summary for legacy vibes
// entries, which have neither field. Returns the raw text (not HTML) —
// the table cell only ever shows a "View" button; the full text renders
// in the insight modal via openInsightModal().
function insightText(entry) {
  if (entry.path !== 'vibes') {
    return entry.topRecommendation || '';
  }
  if (isLegacyVibesEntry(entry)) {
    return entry.summary || '';
  }
  return entry.caveat || entry.summary || '';
}

// Collapsed insight cell — a single small button. Empty insights render a
// disabled-looking placeholder rather than a clickable button with nothing
// to show, so the affordance itself communicates whether there's anything
// there before the user clicks.
function insightCell(entry) {
  const text = insightText(entry);
  if (!text) return '<span class="insight-btn empty">&mdash;</span>';
  return '<button class="insight-btn" type="button"><span class="dot"></span>View</button>';
}

function openInsightModal(entry) {
  $('insightModalTitle').textContent = entry.title || '(unknown video)';
  $('insightModalMeta').innerHTML = resultCell(entry);
  $('insightModalBody').textContent = insightText(entry) || 'No insight recorded for this analysis.';
  $('insightModalOverlay').classList.remove('hidden');
}

function closeInsightModal() {
  $('insightModalOverlay').classList.add('hidden');
}

// Detail row — everything that matters for auditing/debugging a specific
// analysis (model/provider, exact comment counts, token/cost breakdown,
// evidence volume, consensus_type) but doesn't need to be visible while
// just scanning history. Collapsed by default; toggled per-row via the
// caret button in the first column. Keeping this out of the main row is
// the actual "keep it concise" fix — the data isn't gone, it's one click
// away instead of permanently occupying 5-6 columns for every row.
function detailRowHtml(entry) {
  const usage = `${entry.commentsAnalyzed ?? '-'}${entry.commentsFetched ? ' / ' + entry.commentsFetched : ''} comments sent/fetched`;
  // Pool split (Top vs Newest) is only present on entries logged after this
  // field was added — older entries simply omit it, so this renders nothing
  // extra for them rather than misleadingly showing "0 newest".
  let poolSplit = '';
  if (entry.topCount != null || entry.newestCount != null) {
    if (entry.fetchMethod === 'dom') {
      poolSplit = `Fetch: DOM fallback, Top only (${entry.topCount ?? 0})`;
    } else {
      poolSplit = `Fetch: ${entry.topCount ?? 0} Top + ${entry.newestCount ?? 0} Newest`;
    }
  }
  const tokens = `${entry.promptTokens ?? 0} / ${entry.completionTokens ?? 0} / ${entry.totalTokens ?? 0} tokens (in/out/total)`;
  const cost = fmtCost(entry.estCostUSD);
  const model = `${escapeHtml(entry.provider || '')} · ${escapeHtml(entry.model || '')}`;
  const vol = entry.evidenceVolume ? `Evidence: ${escapeHtml(entry.evidenceVolume)}` : '';

  let extra = '';
  if (entry.path !== 'vibes') {
    extra = entry.ratingDimension ? `Judged on: ${escapeHtml(entry.ratingDimension)}` : '';
  } else if (!isLegacyVibesEntry(entry)) {
    const bits = [];
    if (entry.consensusType === 'Split-Opinion') bits.push('Split opinion (genuinely divided)');
    if (entry.authenticityLean) bits.push(`Authenticity: ${escapeHtml(entry.authenticityLean)}`);
    extra = bits.join(' · ');
  }

  return `
    <td></td>
    <td colspan="8">
      <div class="detail-grid">
        <span>${model}</span>
        <span>${escapeHtml(usage)}</span>
        ${poolSplit ? `<span>${escapeHtml(poolSplit)}</span>` : ''}
        <span>${escapeHtml(tokens)}</span>
        <span>${cost}</span>
        ${vol ? `<span>${vol}</span>` : ''}
        ${extra ? `<span>${extra}</span>` : ''}
      </div>
    </td>
  `;
}

function renderTable() {
  const body = $('historyBody');
  body.innerHTML = '';
  $('emptyState').classList.toggle('hidden', history.length > 0);

  const sorted = [...history].sort((a, b) => b.ts - a.ts);

  sorted.forEach(entry => {
    const tr = document.createElement('tr');
    tr.dataset.id = entry.id;

    // entry.videoUrl comes from location.href on the YouTube watch page —
    // normally safe, but treat it as untrusted (a compromised/malicious
    // page could in principle influence it before content.js reads it) and
    // never interpolate it into an href attribute unescaped: an unescaped
    // value could break out of the attribute (e.g. a URL containing a
    // stray `"` followed by `onerror=`) and inject a script. escapeHtml()
    // covers attribute contexts the same way it covers text content, and
    // we additionally only ever treat it as an href if it actually parses
    // as an http(s) URL — never as a `javascript:` URL a crafted title/URL
    // could otherwise sneak in as a clickable link.
    const safeVideoUrl = isHttpUrl(entry.videoUrl) ? entry.videoUrl : null;
    const videoLink = safeVideoUrl
      ? `<a href="${escapeHtml(safeVideoUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(entry.title || safeVideoUrl)}</a>`
      : escapeHtml(entry.title || '(unknown)');

    const isVibes = entry.path === 'vibes';
    // The redo-with-note correction flow only applies to the consensus
    // path (it feeds a human correction back into a re-run of the
    // rating/verdict prompt) — there's no verdict to correct on a vibes
    // entry, so that button is hidden rather than silently doing nothing
    // or erroring when clicked.
    const redoCell = isVibes
      ? '<span class="muted">n/a (vibes)</span>'
      : `<button class="redo-btn" title="Re-scrape comments and re-run the analysis, feeding the note above to the model as a correction it must address">↻ Redo w/ note</button>
        <div class="redo-status muted"></div>`;

    tr.innerHTML = `
      <td><button class="row-expand" title="Show details">▸</button></td>
      <td>${fmtDate(entry.ts)}</td>
      <td class="video-cell">${videoLink}</td>
      <td>${escapeHtml(entry.contentCategory || '-')}</td>
      <td>${resultCell(entry)}</td>
      <td class="insight-cell">${insightCell(entry)}</td>
      <td>
        <div class="thumbs">
          <button class="thumb-up ${entry.helpful === true ? 'active-up' : ''}" title="Rating was accurate">👍</button>
          <button class="thumb-down ${entry.helpful === false ? 'active-down' : ''}" title="Rating was off">👎</button>
        </div>
      </td>
      <td><textarea class="notes-input" placeholder="e.g. missed sarcasm in comment #4...">${escapeHtml(entry.note || '')}</textarea></td>
      <td>${redoCell}</td>
      <td><button class="delete-btn" title="Delete this entry">✕</button></td>
    `;

    tr.querySelector('.thumb-up').addEventListener('click', () => setHelpful(entry.id, entry.helpful === true ? null : true));
    tr.querySelector('.thumb-down').addEventListener('click', () => setHelpful(entry.id, entry.helpful === false ? null : false));
    tr.querySelector('.notes-input').addEventListener('change', e => setNote(entry.id, e.target.value));
    tr.querySelector('.delete-btn').addEventListener('click', () => deleteEntry(entry.id));
    const redoBtn = tr.querySelector('.redo-btn');
    if (redoBtn) redoBtn.addEventListener('click', () => redoWithNote(entry.id, tr));
    const insightBtn = tr.querySelector('.insight-btn:not(.empty)');
    if (insightBtn) insightBtn.addEventListener('click', () => openInsightModal(entry));

    const detailTr = document.createElement('tr');
    detailTr.className = 'detail-row hidden';
    detailTr.innerHTML = detailRowHtml(entry);

    tr.querySelector('.row-expand').addEventListener('click', () => {
      const nowHidden = detailTr.classList.toggle('hidden');
      tr.querySelector('.row-expand').textContent = nowHidden ? '▸' : '▾';
    });

    body.appendChild(tr);
    body.appendChild(detailTr);
  });
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

// Only accept http(s) URLs as clickable hrefs — rejects javascript:, data:,
// vbscript:, and any other scheme that could execute if clicked. Defends
// against a hypothetically-tampered videoUrl field ending up as a live link.
function isHttpUrl(str) {
  if (!str) return false;
  try {
    const u = new URL(str);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

async function saveHistory() {
  await chrome.storage.local.set({ history });
}

async function setNote(id, note) {
  const item = history.find(h => h.id === id);
  if (!item) return;
  item.note = note;
  await saveHistory();
  const row = document.querySelector(`tr[data-id="${id}"] .notes-input`);
  if (row) {
    row.classList.add('saved-flash');
    setTimeout(() => row.classList.remove('saved-flash'), 600);
  }
}

async function setHelpful(id, val) {
  const item = history.find(h => h.id === id);
  if (!item) return;
  item.helpful = val;
  await saveHistory();
  render();
}

async function deleteEntry(id) {
  history = history.filter(h => h.id !== id);
  await saveHistory();
  render();
}

// ---------------------------------------------------------------------
// "Redo w/ note" — opens (or focuses) the video's own YouTube tab, forces
// a fresh comment scrape there (this dashboard page can't scrape comments
// itself; only a content script running on the actual watch page can), and
// re-runs the analysis with the note fed to the model as an explicit
// correction. The note must be saved (via the textarea's change/blur, or
// this reads its live value) before redoing, so edit-then-redo works
// without an extra click.
// ---------------------------------------------------------------------

async function findOrOpenVideoTab(videoUrl) {
  const tabs = await chrome.tabs.query({ url: videoUrl.split('&')[0] + '*' });
  const exact = tabs.find(t => t.url && t.url.startsWith(videoUrl.split('&')[0]));
  if (exact) {
    await chrome.tabs.update(exact.id, { active: true });
    if (exact.windowId != null) await chrome.windows.update(exact.windowId, { focused: true });
    return exact.id;
  }
  const created = await chrome.tabs.create({ url: videoUrl, active: true });
  // Wait for the new tab to finish loading before we try to talk to its
  // content script.
  await new Promise(resolve => {
    function onUpdated(tabId, info) {
      if (tabId === created.id && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
    setTimeout(resolve, 8000); // safety net if 'complete' never fires
  });
  return created.id;
}

async function sendRedoWithRecovery(tabId, payload) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: 'REDO_WITH_NOTE', ...payload });
  } catch (e) {
    if (!/Receiving end does not exist/.test(e.message || '')) throw e;
    // Content script wasn't injected yet (fresh tab, or predates a reload
    // of this extension) — inject it, give it a beat, then retry once.
    await chrome.scripting.executeScript({ target: { tabId }, files: ['page-bridge.js'] });
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    await chrome.scripting.insertCSS({ target: { tabId }, files: ['content.css'] });
    await new Promise(r => setTimeout(r, 500));
    return chrome.tabs.sendMessage(tabId, { type: 'REDO_WITH_NOTE', ...payload });
  }
}

async function redoWithNote(id, trInitial) {
  const item = history.find(h => h.id === id);
  if (!item) return;
  if (!item.videoUrl) {
    alert('No video URL saved for this entry — cannot redo.');
    return;
  }

  // Use whatever's currently in the textarea, even if not yet blurred/saved.
  const noteVal = trInitial.querySelector('.notes-input').value.trim();
  if (!noteVal) {
    const proceed = confirm('The note is empty — this will just be a plain re-analysis with no correction. Continue?');
    if (!proceed) return;
  }
  // setNote() saves to storage, which fires the live chrome.storage.onChanged
  // listener below and re-renders the whole table — that detaches the `tr`
  // (and its child button/status elements) we were just holding a reference
  // to. Re-query the row by id afterwards rather than reusing stale nodes.
  if (noteVal !== item.note) await setNote(id, noteVal);
  const tr = document.querySelector(`tr[data-id="${id}"]`) || trInitial;

  const btn = tr.querySelector('.redo-btn');
  const statusEl = tr.querySelector('.redo-status');
  btn.disabled = true;
  statusEl.textContent = 'Opening video tab…';

  try {
    const tabId = await findOrOpenVideoTab(item.videoUrl);
    // Re-query again: findOrOpenVideoTab awaits on tab creation/focus, and
    // nothing here re-renders the table, but staying defensive costs nothing.
    const trNow = document.querySelector(`tr[data-id="${id}"]`) || tr;
    const statusNow = trNow.querySelector('.redo-status') || statusEl;
    statusNow.textContent = 'Re-scraping comments & re-analyzing…';
    const resp = await sendRedoWithRecovery(tabId, { userNote: noteVal, redoOfId: id });
    if (!resp?.ok) throw new Error(resp?.error || 'Unknown error');
    const learnedRule = resp.state?.result?.newGuidanceRule;
    // The new analysis logs a fresh entry, which fires onChanged and
    // re-renders — the old row for `id` still exists (redo doesn't delete
    // it), just re-query once more to report success on the right node.
    const trDone = document.querySelector(`tr[data-id="${id}"]`);
    if (trDone) {
      const statusDone = trDone.querySelector('.redo-status');
      statusDone.textContent = learnedRule
        ? 'Done — new entry logged, and a new rule was learned (see Learned Guidance above).'
        : 'Done — new entry logged below.';
      setTimeout(() => { statusDone.textContent = ''; }, 6000);
      trDone.querySelector('.redo-btn').disabled = false;
    }
    return; // btn/statusEl above are stale by this point; don't touch them
  } catch (e) {
    const trErr = document.querySelector(`tr[data-id="${id}"]`) || tr;
    trErr.querySelector('.redo-status').textContent = 'Failed: ' + (e.message || e);
    trErr.querySelector('.redo-btn').disabled = false;
  }
}

function toCSV() {
  const cols = ['ts','title','videoUrl','provider','model','path','commentsAnalyzed','commentsFetched','topCount','newestCount','fetchMethod','promptTokens','completionTokens','totalTokens','estCostUSD','evidenceVolume','rating','verdict','topRecommendation','criticalFlagCorroboration','criticalFlagNote','guidanceEnforcementOriginalRating','guidanceEnforcementRules','consensusType','consensusLean','agreementStrength','authenticityLean','helpful','note'];
  const rows = [cols.join(',')];
  history.forEach(h => {
    rows.push(cols.map(c => {
      let v;
      if (c === 'criticalFlagCorroboration') v = h.criticalFlag ? h.criticalFlag.corroboration : '';
      else if (c === 'criticalFlagNote') v = h.criticalFlag ? (h.criticalFlag.note || h.criticalFlag.rule || '') : '';
      else if (c === 'guidanceEnforcementOriginalRating') v = h.guidanceEnforcement ? h.guidanceEnforcement.originalRating : '';
      else if (c === 'guidanceEnforcementRules') v = h.guidanceEnforcement ? (h.guidanceEnforcement.unresolvedRules || []).map(u => u.rule).join(' | ') : '';
      else v = h[c];
      if (v == null) v = '';
      v = String(v).replace(/"/g, '""');
      return /[",\n]/.test(v) ? `"${v}"` : v;
    }).join(','));
  });
  return rows.join('\n');
}

function download(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

$('exportBtn').addEventListener('click', () => download('yt-claim-rater-history.csv', toCSV(), 'text/csv'));
$('exportJsonBtn').addEventListener('click', () =>
  download('yt-claim-rater-history.json', JSON.stringify(history, null, 2), 'application/json')
);

// ---------------------------------------------------------------------
// Guidance export/import — carries learned rules to another device/user
// so it starts reinforced instead of relearning every correction from
// scratch. Export writes the SAME shape addGuidance()/distillGuidance()
// produce in background.js; import re-sends that shape through
// IMPORT_GUIDANCE, which merges (word-overlap dedup) rather than
// replacing, so it's also safe to import into a device that already has
// its own learned rules.
$('exportGuidanceBtn').addEventListener('click', () => {
  download('consensus-guidance.json', JSON.stringify(guidanceRules, null, 2), 'application/json');
});

$('importGuidanceBtn').addEventListener('click', () => $('importGuidanceFile').click());

$('importGuidanceFile').addEventListener('change', async () => {
  const file = $('importGuidanceFile').files[0];
  $('importGuidanceFile').value = ''; // allow re-selecting the same file later
  if (!file) return;
  const statusEl = $('importGuidanceStatus');
  statusEl.classList.remove('hidden');
  statusEl.textContent = 'Importing…';
  try {
    const text = await file.text();
    const rules = JSON.parse(text);
    const resp = await chrome.runtime.sendMessage({ type: 'IMPORT_GUIDANCE', payload: { rules } });
    if (!resp?.ok) throw new Error(resp?.error || 'Unknown error');
    const { imported, skippedDupe, skippedInvalid } = resp.result;
    statusEl.textContent =
      `Imported ${imported} rule(s)` +
      (skippedDupe ? `, skipped ${skippedDupe} duplicate(s)` : '') +
      (skippedInvalid ? `, skipped ${skippedInvalid} invalid entry(ies)` : '') + '.';
    await loadGuidance();
    renderGuidance();
    setTimeout(() => statusEl.classList.add('hidden'), 8000);
  } catch (e) {
    statusEl.textContent = 'Import failed: ' + (e.message || String(e));
  }
});

$('clearBtn').addEventListener('click', async () => {
  if (!confirm('Delete all logged analyses? This cannot be undone.')) return;
  history = [];
  await saveHistory();
  render();
});

function render() {
  renderCards();
  renderGuidance();
  renderTable();
}

// ---------------------------------------------------------------------
// Learned Guidance panel
// ---------------------------------------------------------------------

let guidanceRules = [];

function fmtRelDate(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function renderGuidance() {
  const list = $('guidanceList');
  list.innerHTML = '';
  const sorted = [...guidanceRules].sort((a, b) => b.createdAt - a.createdAt);
  $('guidanceEmpty').classList.toggle('hidden', sorted.length > 0);

  sorted.forEach(g => {
    const li = document.createElement('li');
    li.className = 'guidance-item' + (g.active === false ? ' inactive' : '');
    li.dataset.id = g.id;

    const scopeLabel = g.scope && g.scope !== 'global' ? g.scope : 'All videos';
    const appliedLabel = g.timesApplied ? `Applied ${g.timesApplied}x` : 'Not applied yet';
    const sourceLabel = g.sourceVideoTitle ? `From: "${g.sourceVideoTitle}"` : '';
    const isCritical = g.severity === 'critical';

    li.innerHTML = `
      <input type="checkbox" class="g-toggle" ${g.active !== false ? 'checked' : ''} title="Active — applied to future analyses" />
      <div class="g-body">
        <div class="g-rule" contenteditable="true" spellcheck="false">${escapeHtml(g.rule)}</div>
        <div class="g-meta">
          ${isCritical ? '<span class="g-severity-critical" title="Creator genuineness/trust rule — can force a low rating">CRITICAL</span>' : ''}
          <span class="g-scope">${escapeHtml(scopeLabel)}</span>
          ${appliedLabel} · Learned ${fmtRelDate(g.createdAt)}${sourceLabel ? ' · ' + escapeHtml(sourceLabel) : ''}
        </div>
      </div>
      <div class="g-actions">
        <button class="g-delete" title="Delete this rule">✕</button>
      </div>
    `;

    li.querySelector('.g-toggle').addEventListener('change', e => setGuidanceActive(g.id, e.target.checked));
    li.querySelector('.g-delete').addEventListener('click', () => deleteGuidance(g.id));
    const ruleEl = li.querySelector('.g-rule');
    ruleEl.addEventListener('blur', () => {
      const text = ruleEl.textContent.trim();
      if (text && text !== g.rule) editGuidanceRule(g.id, text);
      else ruleEl.textContent = g.rule; // revert if cleared or unchanged
    });
    ruleEl.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); ruleEl.blur(); }
    });

    list.appendChild(li);
  });
}

async function loadGuidance() {
  // Read directly from storage, same as history/redditLog in init() below —
  // do NOT round-trip through chrome.runtime.sendMessage('GET_GUIDANCE') to
  // the background service worker. That handler was a pure passthrough to
  // chrome.storage.local.get('learnedGuidance') with no extra logic, but on
  // a fresh dashboard load the MV3 service worker can still be asleep;
  // waking it via sendMessage right at page-open is racy and can reject
  // before its listener registers, which silently fell through to
  // guidanceRules = [] here — the panel then only ever populated once a
  // redo woke the worker for an actual analysis and its storage write
  // trickled in via chrome.storage.onChanged below. Reading storage
  // directly removes that race entirely.
  try {
    const { learnedGuidance } = await chrome.storage.local.get('learnedGuidance');
    guidanceRules = Array.isArray(learnedGuidance) ? learnedGuidance : [];
  } catch {
    guidanceRules = [];
  }
}

async function setGuidanceActive(id, active) {
  const item = guidanceRules.find(g => g.id === id);
  if (item) item.active = active; // optimistic local update
  renderGuidance();
  try {
    await chrome.runtime.sendMessage({ type: 'SET_GUIDANCE_ACTIVE', payload: { id, active } });
  } catch (e) {
    console.warn('Failed to update guidance rule:', e);
  }
}

async function editGuidanceRule(id, rule) {
  const item = guidanceRules.find(g => g.id === id);
  if (item) item.rule = rule; // optimistic local update
  try {
    await chrome.runtime.sendMessage({ type: 'EDIT_GUIDANCE_RULE', payload: { id, rule } });
  } catch (e) {
    console.warn('Failed to save guidance rule edit:', e);
  }
  renderGuidance();
}

async function deleteGuidance(id) {
  if (!confirm('Delete this learned rule? It will no longer be applied to future analyses.')) return;
  guidanceRules = guidanceRules.filter(g => g.id !== id); // optimistic local update
  renderGuidance();
  try {
    await chrome.runtime.sendMessage({ type: 'DELETE_GUIDANCE', payload: { id } });
  } catch (e) {
    console.warn('Failed to delete guidance rule:', e);
  }
}

$('insightModalClose').addEventListener('click', closeInsightModal);
$('insightModalOverlay').addEventListener('click', e => {
  if (e.target === $('insightModalOverlay')) closeInsightModal();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeInsightModal();
});

async function init() {
  const { history: h, redditLog: rl } = await chrome.storage.local.get(['history', 'redditLog']);
  history = Array.isArray(h) ? h : [];
  redditLog = Array.isArray(rl) ? rl : [];
  await loadGuidance();
  render();
}

// Live-update if a new analysis is logged, or guidance changes, while this
// tab is open. Guidance updates are handled without a full render() when
// possible — but a redo's distillation runs async in the background and
// can add a rule seconds after its history entry lands, so both listeners
// stay simple and just re-render on any relevant change.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.history) {
    history = changes.history.newValue || [];
  }
  if (changes.learnedGuidance) {
    guidanceRules = changes.learnedGuidance.newValue || [];
  }
  if (changes.redditLog) {
    redditLog = changes.redditLog.newValue || [];
  }
  if (changes.history || changes.learnedGuidance || changes.redditLog) render();
});

init();
