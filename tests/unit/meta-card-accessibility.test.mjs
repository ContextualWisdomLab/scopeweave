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

const cardBlocks = [...html.matchAll(
  /<div\s+([^>]*class="[^"]*meta-value-card[^"]*"[^>]*)>([\s\S]*?)<\/div>/g,
)];
assert.equal(cardBlocks.length, cards.length, 'all summary metric cards are discoverable');

for (const { metricId, descriptionId, description } of cards) {
  const match = cardBlocks.find(([, , content]) => content.includes(`id="${metricId}"`));
  assert.ok(match, `${metricId} summary card exists`);

  const [, attributes, content] = match;
  assert.match(attributes, /tabindex="0"/, `${metricId} is keyboard focusable`);
  assert.ok(
    attributes.includes(`aria-describedby="${descriptionId}"`),
    `${metricId} references explicit assistive text`,
  );
  assert.ok(
    content.includes(`<span id="${descriptionId}" class="sr-only">${description}</span>`),
    `${metricId} includes the expected screen-reader description`,
  );
}

assert.match(
  css,
  /\.meta-value-card:focus-visible\s*\{[^}]*outline\s*:/s,
  'summary cards have a visible keyboard focus indicator',
);

console.log('✓ summary metric card accessibility contract tests passed');
