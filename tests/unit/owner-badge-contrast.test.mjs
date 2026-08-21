import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const styles = fs.readFileSync(path.join(repositoryRoot, 'styles.css'), 'utf8');

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readHexProperty(selector, property) {
  const selectorPattern = escapeRegExp(selector);
  const rule = styles.match(new RegExp(`${selectorPattern}\\s*\\{([^}]*)\\}`));
  assert.ok(rule, `missing CSS rule for ${selector}`);
  const declaration = rule[1].match(
    new RegExp(`${escapeRegExp(property)}\\s*:\\s*(#[0-9a-fA-F]{6})\\b`),
  );
  assert.ok(declaration, `missing ${property} hex value for ${selector}`);
  return declaration[1];
}

function channelToLinear(channel) {
  const normalized = channel / 255;
  return normalized <= 0.04045
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(hex) {
  assert.match(hex, /^#[0-9a-fA-F]{6}$/);
  const red = Number.parseInt(hex.slice(1, 3), 16);
  const green = Number.parseInt(hex.slice(3, 5), 16);
  const blue = Number.parseInt(hex.slice(5, 7), 16);
  return (
    0.2126 * channelToLinear(red)
    + 0.7152 * channelToLinear(green)
    + 0.0722 * channelToLinear(blue)
  );
}

function contrastRatio(first, second) {
  const brighter = Math.max(relativeLuminance(first), relativeLuminance(second));
  const darker = Math.min(relativeLuminance(first), relativeLuminance(second));
  return (brighter + 0.05) / (darker + 0.05);
}

const foreground = readHexProperty('.owner-badge', 'color');
for (let index = 0; index < 20; index += 1) {
  const selector = `.owner-badge--color-${index}`;
  const background = readHexProperty(selector, 'background');
  const ratio = contrastRatio(foreground, background);
  assert.ok(
    ratio >= 4.5,
    `${selector} contrast ${ratio.toFixed(2)}:1 is below the WCAG 2.2 normal-text minimum of 4.5:1`,
  );
}

console.log('✓ owner badge palette meets WCAG normal-text contrast');
