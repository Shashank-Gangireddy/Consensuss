'use strict';
// Loads a plain (non-module) extension source file into an isolated vm
// context so we can call its top-level function declarations directly and
// inspect/replace the globals (chrome.*, fetch, document, etc.) it touches.
// Function DECLARATIONS at a script's top level attach to the vm context's
// global object; `const`/`let` bindings stay in the script's lexical scope
// but remain visible to those same functions across repeated calls, since
// the whole file executes as one vm.Script bound to one persistent context.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadScript(relativePath, extraGlobals = {}) {
  const filePath = path.join(__dirname, '..', '..', relativePath);
  const code = fs.readFileSync(filePath, 'utf8');
  const context = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Promise,
    Array,
    Object,
    JSON,
    Math,
    Date,
    RegExp,
    Map,
    Set,
    WeakSet,
    String,
    Number,
    Boolean,
    Error,
    isNaN,
    isFinite,
    parseFloat,
    parseInt,
    encodeURIComponent,
    decodeURIComponent,
    URL,
    URLSearchParams,
    AbortController,
    ...extraGlobals,
  };
  vm.createContext(context);
  const script = new vm.Script(code, { filename: filePath });
  script.runInContext(context);
  return context;
}

module.exports = { loadScript };
