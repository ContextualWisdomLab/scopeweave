import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(testDirectory, "../..");
const indexHtml = readFileSync(resolve(repositoryRoot, "index.html"), "utf8");
const styleSheet = readFileSync(resolve(repositoryRoot, "styles.css"), "utf8");

const metaCards = [
  ...indexHtml.matchAll(
    /<div class="[^"]*\bmeta-value-card\b[^"]*"[^>]*>[\s\S]*?<\/div>/g,
  ),
].map((match) => match[0]);

assert.equal(metaCards.length, 3, "expected three summary meta cards");

for (const card of metaCards) {
  assert.doesNotMatch(card, /\btabindex=/, "static notes must not enter tab order");
  assert.match(card, /\brole="note"/, "summary cards keep note semantics");
  const descriptionId = card.match(/\baria-describedby="([^"]+)"/)?.[1];
  assert.ok(descriptionId, "each summary card names an explicit description");
  assert.match(
    indexHtml,
    new RegExp(
      `<span id="${descriptionId}" class="sr-only">[^<]+<\\/span>`,
    ),
    "each referenced description exists in reading order",
  );
}

assert.doesNotMatch(
  styleSheet,
  /\.meta-value-card:focus-visible/,
  "static notes must not advertise an interactive focus state",
);
