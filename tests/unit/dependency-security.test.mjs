import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const repositoryRoot = new URL("../../", import.meta.url);

test("Hono manifests retain the fixed dependency floor", async () => {
  const packageManifest = JSON.parse(
    await readFile(new URL("package.json", repositoryRoot), "utf8"),
  );
  const packageLock = JSON.parse(
    await readFile(new URL("package-lock.json", repositoryRoot), "utf8"),
  );

  assert.equal(packageManifest.dependencies.hono, "^4.13.9");
  assert.equal(packageLock.packages[""].dependencies.hono, "^4.13.9");
  assert.equal(packageLock.packages["node_modules/hono"].version, "4.13.9");
});
