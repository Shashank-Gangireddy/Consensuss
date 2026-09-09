'use strict';
// Priority group 8 — Host permissions / manifest scope.
// Statically verifies manifest.json declares exactly the permissions the
// code actually needs, no more (least-privilege), and that no dynamic
// script/CSS injection targets a remote or user-controlled path.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
function readSource(file) {
  return fs.readFileSync(path.join(ROOT, file), 'utf8');
}
const manifest = JSON.parse(readSource('manifest.json'));

test('manifest-permissions-minimal: permissions[] is exactly {storage, scripting, tabs}, nothing broader', () => {
  assert.deepEqual([...manifest.permissions].sort(), ['scripting', 'storage', 'tabs'].sort());
  // Explicitly must NOT ask for anything broader than needed.
  for (const dangerous of ['<all_urls>', 'webRequest', 'webRequestBlocking', 'debugger', 'management', 'proxy', 'cookies', 'history']) {
    assert.ok(!manifest.permissions.includes(dangerous), `permissions[] must not include ${dangerous}`);
  }
});

test('manifest-permissions-minimal: host_permissions is scoped to exactly the 5 hosts the code contacts, never <all_urls> or a wildcard TLD', () => {
  const expected = [
    'https://www.youtube.com/*',
    'https://api.openai.com/*',
    'https://api.anthropic.com/*',
    'https://generativelanguage.googleapis.com/*',
    'https://www.reddit.com/*',
  ];
  assert.deepEqual([...manifest.host_permissions].sort(), expected.sort());
  for (const perm of manifest.host_permissions) {
    assert.ok(!perm.includes('<all_urls>'), `host_permissions entry ${perm} must not be <all_urls>`);
    assert.ok(!/^\*:\/\//.test(perm), `host_permissions entry ${perm} must not use a wildcard scheme`);
    assert.ok(!/\*\.\*/.test(perm), `host_permissions entry ${perm} must not use a wildcard TLD/domain`);
  }
});

test('manifest-permissions-minimal: every host in host_permissions is actually referenced somewhere in the extension source', () => {
  const allSrc = ['background.js', 'content.js', 'page-bridge.js', 'options.js', 'popup.js', 'dashboard.js']
    .map(readSource).join('\n');
  for (const perm of manifest.host_permissions) {
    const host = new URL(perm.replace('/*', '')).hostname;
    assert.ok(allSrc.includes(host), `declared host_permission ${host} must actually be used somewhere in source (no unused/speculative grants)`);
  }
});

test('manifest-csp-present-and-narrow: content_security_policy.extension_pages disallows unsafe-eval / unsafe-inline / remote script sources', () => {
  const csp = manifest.content_security_policy?.extension_pages;
  assert.ok(csp, 'extension_pages CSP must be set');
  assert.doesNotMatch(csp, /unsafe-eval/);
  assert.doesNotMatch(csp, /unsafe-inline/);
  assert.match(csp, /script-src 'self'/, "script-src must be locked to 'self' (no remote script sources)");
  assert.match(csp, /object-src 'self'/, "object-src must be locked to 'self'");
});

test('manifest-csp-present-and-narrow: connect-src in the CSP exactly matches the 4 API hosts (youtube/reddit excluded — those are page/fetch contexts, not extension-page connect-src)', () => {
  const csp = manifest.content_security_policy.extension_pages;
  const connectSrcMatch = csp.match(/connect-src ([^;]+)/);
  assert.ok(connectSrcMatch, 'connect-src directive must be present');
  const hosts = connectSrcMatch[1].trim().split(/\s+/);
  assert.deepEqual(
    hosts.sort(),
    ['https://api.openai.com', 'https://api.anthropic.com', 'https://generativelanguage.googleapis.com', 'https://www.reddit.com'].sort()
  );
});

test('manifest-externally-connectable-scope: externally_connectable is absent (no external web page/extension can message this extension)', () => {
  assert.equal(manifest.externally_connectable, undefined, 'externally_connectable must not be declared unless explicitly needed — it is not used here');
});

test('manifest-content-scripts-scope: content scripts only match youtube.com, never a broader pattern', () => {
  for (const cs of manifest.content_scripts) {
    for (const m of cs.matches) {
      assert.equal(m, 'https://www.youtube.com/*', `content script match pattern must be exactly youtube.com, got ${m}`);
    }
  }
});

test('manifest-web-accessible-resources-scope: web_accessible_resources only exposes fonts, only to youtube.com, never JS/HTML', () => {
  for (const war of manifest.web_accessible_resources) {
    assert.deepEqual(war.matches, ['https://www.youtube.com/*']);
    for (const resource of war.resources) {
      assert.doesNotMatch(resource, /\.(js|html)$/, `web_accessible_resources must not expose executable/markup files (${resource})`);
    }
  }
});

test('script-injection-target-allowlist: every chrome.scripting.executeScript/insertCSS call targets a fixed, bundled local file, never a remote URL or variable path', () => {
  for (const file of ['popup.js', 'dashboard.js']) {
    const src = readSource(file);
    const calls = [...src.matchAll(/chrome\.scripting\.(executeScript|insertCSS)\(\{[\s\S]*?\}\);?/g)].map((m) => m[0]);
    assert.ok(calls.length > 0, `${file} should contain at least one scripting call to check`);
    for (const call of calls) {
      const filesMatch = call.match(/files:\s*\[([^\]]*)\]/);
      assert.ok(filesMatch, `scripting call in ${file} must use a static files: [...] array, not a dynamic code: string\n${call}`);
      const filesLiteral = filesMatch[1];
      assert.doesNotMatch(filesLiteral, /\$\{/, `files array in ${file} must not be built from a template-literal interpolation (no runtime-controlled path)\n${call}`);
      assert.doesNotMatch(call, /\bcode:\s*/, `scripting call in ${file} must not use the deprecated 'code:' (arbitrary string execution) option\n${call}`);
      for (const f of filesLiteral.split(',').map((s) => s.trim().replace(/['"]/g, ''))) {
        if (!f) continue;
        assert.match(f, /^[a-zA-Z0-9_.-]+\.(js|css)$/, `injected file ${f} in ${file} must be a bare local filename, not a path/URL`);
      }
    }
  }
});
