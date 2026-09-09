'use strict';
const { loadScript } = require('./load-script');
const { makeFakeChrome } = require('./fake-chrome');
const nodeCrypto = require('node:crypto');

// Loads background.js into a vm context wired with a fake chrome.storage,
// a controllable fetch mock, and real crypto.randomUUID — so tests call
// the SAME functions (analyzeClaim, checkGlobalRateLimit, buildPrompt,
// callOpenAI, etc.) the real service worker runs, not reimplementations.
function loadBackground({ fetchImpl, extensionId } = {}) {
  const { chrome, messageListeners, storageLocal } = makeFakeChrome({ extensionId });
  let currentFetch = fetchImpl || defaultFetchStub;

  const fetchProxy = (...args) => currentFetch(...args);

  const context = loadScript('background.js', {
    chrome,
    fetch: fetchProxy,
    crypto: { randomUUID: () => nodeCrypto.randomUUID() },
    TextEncoder,
    TextDecoder,
  });

  return {
    context,
    chrome,
    messageListeners,
    storageLocal,
    setFetch(fn) {
      currentFetch = fn;
    },
    // Convenience: invoke the ONLY onMessage listener background.js
    // registers, exactly like Chrome would, capturing the sendResponse
    // value via a promise (handles both sync and async `return true` shapes).
    sendMessage(msg, sender = { id: extensionId || chrome.runtime.id }) {
      return new Promise((resolve) => {
        const listener = messageListeners[0];
        const keepAlive = listener(msg, sender, resolve);
        if (!keepAlive) {
          // Listener didn't ask to keep the channel open — nothing more
          // will call sendResponse; resolve with undefined so callers
          // relying on this path don't hang.
        }
      });
    },
  };
}

async function defaultFetchStub() {
  throw new Error('fetch not stubbed for this test');
}

module.exports = { loadBackground };
