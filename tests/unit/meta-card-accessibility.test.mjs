import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync('index.html', 'utf8');
const css = readFileSync('styles.css', 'utf8');

const cards = [
  {
    metricId: 'summary-total-days',
    descriptionId: 'summary-total-days-help',
    description: '프로젝트의 작업 기간(일수) 합계입니다.',
  },
  {
    metricId: 'summary-planned-progress',
    descriptionId: 'summary-planned-progress-help',
    description: '기간(일수) 가중치가 반영된 프로젝트 전체 계획 진척률입니다.',
  },
  {
    metricId: 'summary-actual-progress',
    descriptionId: 'summary-actual-progress-help',
    description: '기간(일수) 가중치가 반영된 프로젝트 전체 실적 진척률입니다.',
  },
];

for (const { metricId, descriptionId, description } of cards) {
  const cardPattern = new RegExp(
    `<div\\s+([^>]*class="[^"]*meta-value-card[^"]*"[^>]*)>[\\s\\S]*?id="${metricId}"[\\s\\S]*?<\\/div>`,
    'm',
  );
  const match = html.match(cardPattern);
  assert.ok(match, `${metricId} summary card exists`);
  const attributes = match[1];
  assert.match(attributes, /tabindex="0"/, `${metricId} is keyboard focusable`);
  assert.match(
    attributes,
    new RegExp(`aria-describedby="${descriptionId}"`),
    `${metricId} references explicit assistive text`,
  );
  assert.match(
    match[0],
    new RegExp(
      `<span\\s+id="${descriptionId}"\\s+class="sr-only">${description.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}<\\/span>`,
    ),
    `${metricId} includes the expected screen-reader description`,
  );
}

assert.match(
  css,
  /\.meta-value-card:focus-visible\s*\{[^}]*outline\s*:/s,
  'summary cards have a visible keyboard focus indicator',
);

console.log('✓ summary metric card accessibility contract tests passed');
