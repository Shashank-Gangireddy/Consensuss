'use strict';
// Minimal in-memory chrome.* mock sufficient to load background.js/
// content.js/page-bridge.js/options.js in a vm context and exercise their
// real logic (not reimplementations of it).

function makeFakeChromeStorageLocal(initial = {}) {
  let store = { ...initial };
  const listeners = [];
  return {
    async get(keys) {
      if (keys == null) return { ...store };
      if (typeof keys === 'string') return { [keys]: store[keys] };
      if (Array.isArray(keys)) {
        const out = {};
        for (const k of keys) out[k] = store[k];
        return out;
      }
      return { ...store };
    },
    async set(obj) {
      const changes = {};
      for (const [k, v] of Object.entries(obj)) {
        changes[k] = { oldValue: store[k], newValue: v };
        store[k] = v;
      }
      for (const l of listeners) l(changes, 'local');
      return undefined;
    },
    _dump() {
      return store;
    },
    _reset(next = {}) {
      store = { ...next };
    },
    _onChangedListeners: listeners,
  };
}

function makeFakeChrome({ extensionId = 'fakeextensionid0000000000000000' } = {}) {
  const messageListeners = [];
  const storageLocal = makeFakeChromeStorageLocal();
  const chrome = {
    runtime: {
      id: extensionId,
      onMessage: {
        addListener(fn) {
          messageListeners.push(fn);
        },
      },
      onInstalled: {
        addListener() {
          // no-op for tests that don't care about install seeding
        },
      },
      getURL(p) {
        return `chrome-extension://${extensionId}/${p}`;
      },
      sendMessage() {
        return Promise.resolve({ ok: true });
      },
    },
    storage: {
      local: storageLocal,
      onChanged: {
        addListener(fn) {
          storageLocal._onChangedListeners.push(fn);
        },
      },
      // Deliberately NOT providing chrome.storage.sync — a test asserts
      // background.js/options.js never reference it at all (static check),
      // and omitting it here means any accidental runtime use throws
      // immediately instead of silently no-op'ing.
    },
    tabs: {
      async query() {
        return [];
      },
      sendMessage() {
        return Promise.resolve({ ok: true });
      },
    },
    scripting: {
      async executeScript() {
        return [];
      },
      async insertCSS() {
        return undefined;
      },
    },
  };
  return { chrome, messageListeners, storageLocal };
}

module.exports = { makeFakeChrome, makeFakeChromeStorageLocal };
