'use strict';
// Priority group 6 — Output escaping / rendered-UI XSS.
// Ports rabbithole's HOSTILE-payload pattern: inject real attack strings
// into every LLM-controlled / user-controlled field the dashboard and
// popup render into the DOM, then assert on the actual parsed DOM (via
// jsdom) that nothing executes and nothing breaks out of its context.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadDashboard } = require('../helpers/load-dashboard');

const ROOT = path.join(__dirname, '..', '..');

const HOSTILE_STRINGS = [
  '<script>window.__pwned=(window.__pwned||0)+1</script>',
  '<img src=x onerror="window.__pwned=2">',
  '"><svg onload="window.__pwned=3">',
  "'><svg onload='window.__pwned=4'>",
  'javascript:window.__pwned=5',
  '<iframe src="javascript:window.__pwned=6"></iframe>',
  '</textarea><script>window.__pwned=7</script>',
  '"autofocus onfocus="window.__pwned=8',
];

function hostileEntry(overrides = {}) {
  return {
    id: 'hostile-1',
    ts: Date.now(),
    title: HOSTILE_STRINGS[0],
    videoUrl: 'javascript:window.__pwned_href=1',
    path: 'consensus',
    provider: HOSTILE_STRINGS[1],
    model: HOSTILE_STRINGS[2],
    rating: 3,
    verdict: HOSTILE_STRINGS[3],
    contentCategory: HOSTILE_STRINGS[4],
    videoFormat: 'Review',
    ratingDimension: HOSTILE_STRINGS[5],
    topRecommendation: HOSTILE_STRINGS[6],
    note: HOSTILE_STRINGS[7],
    criticalFlag: { corroboration: 'Strong', note: '<script>window.__pwned=9</script>', rule: 'x' },
    ...overrides,
  };
}

test('hostile-content-render-safety (dashboard table): no LLM/user-controlled field executes or breaks out of its HTML context', async () => {
  const { document, window } = await loadDashboard({ history: [hostileEntry()] });
  assert.equal(window.__pwned, undefined, 'no hostile payload should have executed during render');

  const body = document.getElementById('historyBody');
  assert.ok(body.querySelectorAll('script').length === 0, 'no <script> element should exist in the rendered row');

  // Every element with an on* handler attribute must be gone — jsdom does
  // not execute inline handlers on innerHTML assignment, but a *real*
  // Chrome DOM would if the attribute is present, so presence itself is
  // the vulnerability signal, not just non-execution here.
  const allEls = [...body.querySelectorAll('*')];
  const withHandlers = allEls.flatMap((el) => [...el.attributes]).filter((a) => /^on/i.test(a.name));
  assert.deepEqual(withHandlers.map((a) => a.name), [], 'no element should carry an on*-handler attribute');

  const jsUrls = allEls
    .flatMap((el) => [...el.attributes])
    .filter((a) => /^(?:href|src)$/i.test(a.name) && /^\s*javascript:/i.test(a.value));
  assert.deepEqual(jsUrls, [], 'no href/src should resolve to a javascript: URL');
});

test('hostile-content-render-safety (dashboard): a javascript: videoUrl never becomes a clickable link', async () => {
  const { document } = await loadDashboard({
    history: [hostileEntry({ videoUrl: 'javascript:window.__pwned_href=1', title: 'javascript-url-probe-title' })],
  });
  const body = document.getElementById('historyBody');
  const anchors = [...body.querySelectorAll('a')];
  assert.equal(anchors.length, 0, 'a javascript: videoUrl must not be rendered as an <a href>');
  // The title text should still render, just as plain text, not a link.
  assert.match(body.textContent, /javascript-url-probe-title/);
});

test('hostile-content-render-safety (dashboard): a real http(s) videoUrl DOES render as a safe rel=noopener link', async () => {
  const { document } = await loadDashboard({
    history: [hostileEntry({ videoUrl: 'https://www.youtube.com/watch?v=abcdefghijk', title: 'Normal Title' })],
  });
  const body = document.getElementById('historyBody');
  const a = body.querySelector('a');
  assert.ok(a, 'a real https videoUrl should render as a link');
  assert.equal(a.getAttribute('rel'), 'noopener noreferrer');
  assert.equal(a.getAttribute('target'), '_blank');
});

test('hostile-content-render-safety (insight modal): attribute-context payload cannot break out of a quoted attribute', async () => {
  const { document, window } = await loadDashboard({
    history: [hostileEntry({ id: 'hostile-2', criticalFlag: { corroboration: 'Strong', note: '"><svg onload=window.__pwned=10>', rule: 'r' } })],
  });
  const row = document.querySelector('tr[data-id="hostile-2"]');
  const flagSpan = row.querySelector('.rating-badge-flag');
  assert.ok(flagSpan, 'critical flag badge should render');
  // The dangerous string must be present only as the ATTRIBUTE VALUE
  // (properly escaped), never having escaped into a new element.
  assert.equal(flagSpan.tagName, 'SPAN', 'no extraneous <svg> element should have been injected via the title attribute');
  assert.equal(window.__pwned, undefined);
});

test('escapeHtml source-level check: encodes all five HTML-significant characters (&, <, >, ", \')', () => {
  const src = fs.readFileSync(path.join(ROOT, 'dashboard.js'), 'utf8');
  const match = src.match(/function escapeHtml\(str\) \{[\s\S]*?\n\}/);
  assert.ok(match, 'escapeHtml function must exist in dashboard.js');
  for (const ch of ['&', '<', '>', '"', "'"]) {
    assert.ok(match[0].includes(`'${ch}'`) || match[0].includes(`"${ch}"`), `escapeHtml must handle ${JSON.stringify(ch)}`);
  }
});

test('dangerous-sink-static-scan: no source file uses eval, Function(), document.write, or insertAdjacentHTML on unescaped input', () => {
  for (const file of ['background.js', 'content.js', 'popup.js', 'dashboard.js', 'options.js', 'page-bridge.js']) {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.doesNotMatch(src, /\beval\s*\(/, `${file} must not call eval()`);
    assert.doesNotMatch(src, /new Function\s*\(/, `${file} must not construct Function() dynamically`);
    assert.doesNotMatch(src, /document\.write\s*\(/, `${file} must not use document.write`);
    assert.doesNotMatch(src, /insertAdjacentHTML/, `${file} must not use insertAdjacentHTML`);
  }
});

// Values known-safe by construction wherever they appear inside an
// innerHTML template literal: plain numbers/counts, calls into functions
// this suite (or the escapeHtml test above) already proves are safe, or
// fixed lookups into a hardcoded *_CLASS constant map. Anything NOT on
// this list must be wrapped in escapeHtml(...) directly at its use site.
// Generated by enumerating every top-level ${...} interpolation actually
// present in dashboard.js/popup.js's innerHTML template literals (see
// extractTopLevelInterpolations below) and manually auditing each one.
const SAFE_INNERHTML_EXPRESSIONS = new Set([
  'n', 'vibesCount', 'consensusEntries.length',
  'totalTokens.toLocaleString()', 'fmtCost(totalCostAll)', 'fmtCost(avgCost)', 'fmtCost(redditCost)',
  'avgTokens.toLocaleString()', 'redditLog.length',
  'fmtDate(entry.ts)', "entry.helpful === true ? 'active-up' : ''",
  "entry.helpful === false ? 'active-down' : ''",
  "g.active !== false ? 'checked' : ''",
  "isCritical ? '<span class=\"g-severity-critical\" title=\"Creator genuineness/trust rule — can force a low rating\">CRITICAL</span>' : ''",
  'appliedLabel', 'fmtRelDate(g.createdAt)',
  // Functions verified elsewhere in this file to internally call
  // escapeHtml() on every dynamic value they interpolate: resultCell()
  // wraps entry.verdict/criticalFlag.note/guidanceEnforcement text;
  // insightCell() returns a fixed static button/placeholder string with no
  // interpolation of entry data at all (the raw insight text only ever
  // reaches textContent via openInsightModal, never innerHTML); videoLink
  // and redoCell are pre-built locals whose OWN construction already
  // wraps every dynamic piece in escapeHtml()/isHttpUrl() before being
  // assigned (verified by direct read of dashboard.js lines building them).
  'resultCell(entry)', 'insightCell(entry)', 'videoLink', 'redoCell',
]);

// Extracts the ${...} interpolation expressions from a template-literal
// body, correctly skipping over NESTED template literals (which contain
// their own ${...} and unbalanced }/`  characters that a naive regex
// mis-parses) by tracking brace/backtick depth char-by-char.
function extractTopLevelInterpolations(templateBody) {
  const out = [];
  let i = 0;
  while (i < templateBody.length) {
    if (templateBody[i] === '$' && templateBody[i + 1] === '{') {
      let depth = 1;
      let j = i + 2;
      let inNestedTemplate = false;
      const start = j;
      while (j < templateBody.length && depth > 0) {
        const c = templateBody[j];
        if (c === '`') inNestedTemplate = !inNestedTemplate;
        if (!inNestedTemplate) {
          if (c === '{') depth++;
          else if (c === '}') depth--;
        }
        if (depth > 0) j++;
      }
      out.push(templateBody.slice(start, j));
      i = j + 1;
    } else {
      i++;
    }
  }
  return out;
}

test('dangerous-sink-static-scan: every innerHTML template interpolation is escapeHtml()-wrapped or on the proven-safe allowlist', () => {
  for (const file of ['dashboard.js', 'popup.js']) {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const assignments = [...src.matchAll(/\.innerHTML\s*=\s*`([\s\S]*?)`;/g)];
    for (const [, literal] of assignments) {
      const interpolations = extractTopLevelInterpolations(literal).map((s) => s.trim());
      for (const expr of interpolations) {
        // A nested template literal (e.g. the vibesCount ternary building a
        // whole extra `<span>...</span>` chunk) is checked recursively for
        // its OWN interpolations rather than as one opaque expression.
        if (expr.includes('`')) {
          const nestedInterpolations = extractTopLevelInterpolations(expr).map((s) => s.trim());
          for (const nested of nestedInterpolations) {
            const looksEscaped = /escapeHtml\(/.test(nested) || /_CLASS\[/.test(nested) || /^\d/.test(nested);
            assert.ok(
              looksEscaped || SAFE_INNERHTML_EXPRESSIONS.has(nested),
              `${file}: nested interpolation "${nested}" must be escapeHtml()-wrapped, a *_CLASS lookup, or on the reviewed safe-allowlist`
            );
          }
          continue;
        }
        const looksEscaped = /escapeHtml\(/.test(expr) || /_CLASS\[/.test(expr) || /^\d/.test(expr);
        assert.ok(
          looksEscaped || SAFE_INNERHTML_EXPRESSIONS.has(expr),
          `${file}: interpolation "${expr}" in an innerHTML template must be escapeHtml()-wrapped, a *_CLASS lookup, or added to the reviewed safe-allowlist after manual audit`
        );
      }
    }
  }
});
