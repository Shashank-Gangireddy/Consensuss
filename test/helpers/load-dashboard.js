'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { makeFakeChrome } = require('./fake-chrome');

const ROOT = path.join(__dirname, '..', '..');

// Loads dashboard.html + dashboard.js into a real jsdom DOM (not a vm
// sandbox) so tests can assert on actual rendered markup/attributes/text
// content the way a browser would parse them — needed to catch HTML
// injection that a pure-string check on escapeHtml() output could miss.
async function loadDashboard({ history = [], redditLog = [], guidance = [] } = {}) {
  const html = fs.readFileSync(path.join(ROOT, 'dashboard.html'), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'chrome-extension://fakeextensionid0000000000000000/dashboard.html' });
  const { window } = dom;

  const { chrome, storageLocal } = makeFakeChrome();
  await storageLocal.set({ history, redditLog, learnedGuidance: guidance });
  window.chrome = chrome;
  // jsdom's `confirm`/`alert` aren't implemented; stub them so redo/delete
  // flows used by some tests don't throw.
  window.confirm = () => true;
  window.alert = () => {};

  const scriptSrc = fs.readFileSync(path.join(ROOT, 'dashboard.js'), 'utf8');
  window.eval(scriptSrc);
  // dashboard.js's init() is async and self-invoked at load; wait a tick
  // (plus a microtask flush) for its chrome.storage.local.get to resolve
  // and render() to run.
  await new Promise((resolve) => setTimeout(resolve, 20));

  return { dom, window, document: window.document, chrome, storageLocal };
}

module.exports = { loadDashboard };
