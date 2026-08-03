import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync('app.js', 'utf8');
const styles = readFileSync('styles.css', 'utf8');

assert.match(
  app,
  /saveButton\.setAttribute\(['"]aria-disabled['"],\s*['"]true['"]\)/,
  'invalid editor state exposes aria-disabled=true on the save button',
);
assert.match(
  app,
  /saveButton\.removeAttribute\(['"]aria-disabled['"]\)/,
  'valid editor state removes aria-disabled from the save button',
);
assert.match(
  app,
  /renderDraftValidation\.flush\(\);[\s\S]*?const saveButton = form\.querySelector\(['"]button\[type=[\\]?['"]submit[\\]?['"]\]['"]\);[\s\S]*?saveButton\s*&&\s*saveButton\.getAttribute\(['"]aria-disabled['"]\)\s*===\s*['"]true['"]\)\s*\{\s*return;/s,
  'submit flushes current draft validation before consulting aria-disabled',
);
assert.doesNotMatch(
  app,
  /saveButton\.disabled\s*=\s*errors\.length\s*>\s*0/,
  'validation must not make the explanatory save-button tooltip unreachable',
);
assert.match(
  styles,
  /\.primary-button\[aria-disabled=['"]true['"]\][\s\S]*?cursor:\s*not-allowed/,
  'aria-disabled primary buttons preserve the disabled visual treatment',
);

console.log('✓ editor save-button accessibility contract tests passed');
