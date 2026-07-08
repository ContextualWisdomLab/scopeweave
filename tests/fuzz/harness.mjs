// Fuzz harness loader for ScopeWeave.
//
// app.js is a browser module that wires up the DOM and calls bootstrap() on
// load, so it cannot be imported directly in Node. Instead we evaluate its
// verbatim source inside a `vm` sandbox with stubbed browser globals — the same
// non-invasive extraction pattern the existing Playwright e2e tests use (they
// append `window.fn = fn` to the intercepted source). This lets the fuzz
// targets exercise the REAL, un-forked parser/importer functions.
//
// No production code is modified: we strip only the trailing `bootstrap();`
// call (which would kick off DOM rendering + fetch) and append an export
// collector that captures the top-level bindings we want to fuzz.

import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appJsPath = path.resolve(here, '..', '..', 'app.js');

const EXPORTED = [
  'parseSafeJson',
  'parseCsv',
  'normalizeImportedTasks',
  'validateImportedTasks',
  'validateImportedTask',
  'validateCsvCell',
  'sanitizeCsvFormulaValue',
  'isValidDateString',
  'buildHierarchicalTasksFromFlatSource',
  'hydrateState',
  'normalizeStoredTask',
  'isTaskRecord',
  'state',
];

function loadAppExports() {
  let source = fs.readFileSync(appJsPath, 'utf8');

  // Neutralize the top-level bootstrap() invocation (DOM + fetch side effects).
  source = source.replace(/^\s*bootstrap\(\);\s*$/m, ';');

  // Append an export collector evaluated in the same lexical scope, so it can
  // reach the top-level const/function bindings directly.
  source += `\n;globalThis.__fuzzExports = { ${EXPORTED.join(', ')} };\n`;

  // A dummy DOM element that swallows any property access/assignment. The
  // `elements` object literal calls document.getElementById(...) at load time;
  // the results are only used inside functions we do not invoke here.
  const dummyElement = new Proxy(
    {},
    {
      get: () => dummyElement,
      set: () => true,
      apply: () => dummyElement,
    }
  );

  const windowStub = {};

  const sandbox = {
    window: windowStub,
    self: windowStub,
    document: {
      getElementById: () => dummyElement,
      createElement: () => dummyElement,
      body: dummyElement,
    },
    localStorage: {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    },
    fetch: () => Promise.reject(new Error('fetch disabled in fuzz harness')),
    AbortController: globalThis.AbortController,
    crypto: globalThis.crypto,
    Uint32Array,
    console,
    // Timers are referenced (window.setTimeout) but never fire at load time.
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    // Core intrinsics.
    Date,
    Math,
    JSON,
    Object,
    Array,
    Set,
    Map,
    WeakMap,
    Symbol,
    String,
    Number,
    Boolean,
    RegExp,
    Error,
    TypeError,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    URL: globalThis.URL,
  };
  sandbox.globalThis = sandbox;
  windowStub.window = windowStub;

  const context = vm.createContext(sandbox);
  vm.runInContext(source, context, { filename: 'app.js' });

  const exportsObj = sandbox.__fuzzExports;
  if (!exportsObj || typeof exportsObj.parseCsv !== 'function') {
    throw new Error('Failed to extract fuzz targets from app.js');
  }
  return exportsObj;
}

export const app = loadAppExports();
