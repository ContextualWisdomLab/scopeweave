import { constants as fsConstants } from 'node:fs';
import { createHash, timingSafeEqual } from 'node:crypto';
import { lstat, open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SCHEMA_VERSION = 'scopeweave.release_artifact_manifest.v1';
const MAX_ARTIFACTS = 256;
const MAX_ARTIFACT_NAME_LENGTH = 240;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const SOURCE_REVISION = /^[0-9a-f]{40}$/;
const ARTIFACT_NAME_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._@+-]*$/;

/**
 * Stable, non-secret failure raised by the release-artifact manifest boundary.
 * Callers should branch on `code` rather than exposing filesystem error text.
 */
export class ReleaseArtifactManifestError extends Error {
  /**
   * @param {string} code Stable machine-readable failure code.
   */
  constructor(code) {
    super(code);
    this.name = 'ReleaseArtifactManifestError';
    this.code = code;
  }
}

function fail(code) {
  throw new ReleaseArtifactManifestError(code);
}

function compareArtifactNames(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function validateSourceRevision(value) {
  if (typeof value !== 'string' || !SOURCE_REVISION.test(value)) {
    fail('source_revision_invalid');
  }
  return value;
}

function validateArtifactName(value) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > MAX_ARTIFACT_NAME_LENGTH
    || value.includes('\\')
    || value.startsWith('/')
    || value.endsWith('/')
    || value.includes('\u0000')
  ) {
    fail('artifact_name_invalid');
  }

  const segments = value.split('/');
  if (
    segments.some((segment) => (
      segment === ''
      || segment === '.'
      || segment === '..'
      || !ARTIFACT_NAME_SEGMENT.test(segment)
    ))
  ) {
    fail('artifact_name_invalid');
  }
  return value;
}

function validateArtifactInputs(artifacts) {
  if (!Array.isArray(artifacts) || artifacts.length === 0 || artifacts.length > MAX_ARTIFACTS) {
    fail('artifact_set_invalid');
  }

  const names = new Set();
  return artifacts.map((artifact) => {
    if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
      fail('artifact_input_invalid');
    }
    const name = validateArtifactName(artifact.name);
    if (names.has(name)) {
      fail('artifact_name_duplicate');
    }
    names.add(name);
    if (typeof artifact.path !== 'string' || artifact.path.length === 0 || artifact.path.includes('\u0000')) {
      fail('artifact_path_invalid');
    }
    return { name, path: artifact.path };
  });
}

function stableStatMatches(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

async function statWithoutPathDisclosure(path, errorCode) {
  try {
    return await lstat(path, { bigint: true });
  } catch {
    fail(errorCode);
  }
}

async function openRegularFile(path, options = {}) {
  const {
    symlinkCode = 'artifact_symlink_not_allowed',
    invalidCode = 'artifact_not_regular_file',
    unreadableCode = 'artifact_unreadable',
    changedCode = 'artifact_changed_during_read',
  } = options;

  const before = await statWithoutPathDisclosure(path, unreadableCode);
  if (before.isSymbolicLink()) fail(symlinkCode);
  if (!before.isFile()) fail(invalidCode);

  let handle;
  try {
    const noFollow = Number.isInteger(fsConstants.O_NOFOLLOW) ? fsConstants.O_NOFOLLOW : 0;
    handle = await open(path, fsConstants.O_RDONLY | noFollow);
  } catch (error) {
    if (error?.code === 'ELOOP') fail(symlinkCode);
    fail(unreadableCode);
  }

  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile()) fail(invalidCode);
    if (!stableStatMatches(before, opened)) fail(changedCode);
    return { handle, opened };
  } catch (error) {
    await handle.close().catch(() => {});
    if (error instanceof ReleaseArtifactManifestError) throw error;
    fail(unreadableCode);
  }
}

async function hashArtifactFile(path, options = {}) {
  const { afterOpen } = options;
  const { handle, opened } = await openRegularFile(path);
  const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);
  if (opened.size > maxSafe) {
    await handle.close().catch(() => {});
    fail('artifact_size_unsupported');
  }

  const digest = createHash('sha256');
  try {
    if (afterOpen !== undefined) {
      if (typeof afterOpen !== 'function') fail('artifact_changed_during_read');
      try {
        await afterOpen();
      } catch {
        fail('artifact_changed_during_read');
      }
    }

    const pathAfterOpen = await statWithoutPathDisclosure(path, 'artifact_changed_during_read');
    if (!stableStatMatches(opened, pathAfterOpen)) fail('artifact_changed_during_read');

    const stream = handle.createReadStream({ autoClose: false });
    for await (const chunk of stream) {
      digest.update(chunk);
    }
    const after = await handle.stat({ bigint: true });
    if (!stableStatMatches(opened, after)) fail('artifact_changed_during_read');
    const pathAfterRead = await statWithoutPathDisclosure(path, 'artifact_changed_during_read');
    if (!stableStatMatches(after, pathAfterRead)) fail('artifact_changed_during_read');
    return {
      byte_length: Number(after.size),
      digest: { sha256: digest.digest('hex') },
    };
  } catch (error) {
    if (error instanceof ReleaseArtifactManifestError) throw error;
    fail('artifact_unreadable');
  } finally {
    await handle.close().catch(() => {});
  }
}

function payloadForDigest(manifest) {
  return {
    schema_version: manifest.schema_version,
    source_revision: manifest.source_revision,
    artifacts: manifest.artifacts.map((entry) => ({
      name: entry.name,
      byte_length: entry.byte_length,
      digest: { sha256: entry.digest.sha256 },
    })),
  };
}

function digestPayload(payload) {
  return createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex');
}

function exactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function validateManifestShape(manifest) {
  if (!exactKeys(manifest, ['schema_version', 'source_revision', 'artifacts', 'manifest_digest'])) {
    fail('manifest_schema_invalid');
  }
  if (manifest.schema_version !== SCHEMA_VERSION) fail('manifest_schema_invalid');
  if (typeof manifest.source_revision !== 'string' || !SOURCE_REVISION.test(manifest.source_revision)) {
    fail('manifest_schema_invalid');
  }
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0 || manifest.artifacts.length > MAX_ARTIFACTS) {
    fail('manifest_schema_invalid');
  }
  if (!exactKeys(manifest.manifest_digest, ['sha256']) || !SHA256_HEX.test(manifest.manifest_digest.sha256)) {
    fail('manifest_schema_invalid');
  }

  let previousName = null;
  for (const entry of manifest.artifacts) {
    if (!exactKeys(entry, ['name', 'byte_length', 'digest'])) fail('manifest_schema_invalid');
    try {
      validateArtifactName(entry.name);
    } catch {
      fail('manifest_schema_invalid');
    }
    if (
      !Number.isSafeInteger(entry.byte_length)
      || entry.byte_length < 0
      || !exactKeys(entry.digest, ['sha256'])
      || !SHA256_HEX.test(entry.digest.sha256)
    ) {
      fail('manifest_schema_invalid');
    }
    if (previousName !== null && compareArtifactNames(previousName, entry.name) >= 0) {
      fail('manifest_schema_invalid');
    }
    previousName = entry.name;
  }

  const expectedDigest = digestPayload(payloadForDigest(manifest));
  const actualBuffer = Buffer.from(manifest.manifest_digest.sha256, 'hex');
  const expectedBuffer = Buffer.from(expectedDigest, 'hex');
  if (!timingSafeEqual(actualBuffer, expectedBuffer)) fail('manifest_digest_mismatch');
  return manifest;
}

/**
 * Hash built release artifacts and bind their logical identities to one exact Git revision.
 * The result is deterministic unsigned integrity metadata; it is not a provenance attestation.
 *
 * @param {{sourceRevision: string, artifacts: Array<{name: string, path: string}>}} input Build inputs.
 * @returns {Promise<object>} Canonical manifest with a self-digest over its unsigned payload.
 */
export async function buildReleaseArtifactManifest({ sourceRevision, artifacts }) {
  const revision = validateSourceRevision(sourceRevision);
  const inputs = validateArtifactInputs(artifacts);
  const entries = [];

  for (const artifact of inputs) {
    const evidence = await hashArtifactFile(artifact.path);
    entries.push({ name: artifact.name, ...evidence });
  }
  entries.sort((left, right) => compareArtifactNames(left.name, right.name));

  const payload = {
    schema_version: SCHEMA_VERSION,
    source_revision: revision,
    artifacts: entries,
  };
  return {
    ...payload,
    manifest_digest: { sha256: digestPayload(payloadForDigest(payload)) },
  };
}

/**
 * Verify a manifest, its exact source revision, and the current bytes of every declared artifact.
 * Verification fails closed when the manifest set and supplied artifact set are not identical.
 * `afterArtifactOpen` is an optional deterministic test seam invoked after each artifact is opened.
 *
 * @param {{manifest: object, sourceRevision: string, artifacts: Array<{name: string, path: string}>, afterArtifactOpen?: Function}} input Verification inputs.
 * @returns {Promise<{ok: true, source_revision: string, artifact_count: number, manifest_sha256: string}>} Stable verification receipt.
 */
export async function verifyReleaseArtifactManifest({ manifest, sourceRevision, artifacts, afterArtifactOpen }) {
  const revision = validateSourceRevision(sourceRevision);
  const checkedManifest = validateManifestShape(manifest);
  if (checkedManifest.source_revision !== revision) fail('source_revision_mismatch');

  const inputs = validateArtifactInputs(artifacts)
    .sort((left, right) => compareArtifactNames(left.name, right.name));
  if (inputs.length !== checkedManifest.artifacts.length) fail('artifact_set_mismatch');

  for (let index = 0; index < inputs.length; index += 1) {
    const input = inputs[index];
    const expected = checkedManifest.artifacts[index];
    if (input.name !== expected.name) fail('artifact_set_mismatch');
    const actual = await hashArtifactFile(input.path, { afterOpen: afterArtifactOpen });
    if (actual.digest.sha256 !== expected.digest.sha256) fail('artifact_digest_mismatch');
    if (actual.byte_length !== expected.byte_length) fail('artifact_size_mismatch');
  }

  return {
    ok: true,
    source_revision: revision,
    artifact_count: inputs.length,
    manifest_sha256: checkedManifest.manifest_digest.sha256,
  };
}

function parseArtifactArgument(value, cwd) {
  if (typeof value !== 'string') fail('cli_usage_invalid');
  const separator = value.indexOf('=');
  if (separator <= 0 || separator === value.length - 1) fail('cli_usage_invalid');
  const name = value.slice(0, separator);
  const localPath = value.slice(separator + 1);
  validateArtifactName(name);
  return { name, path: resolve(cwd, localPath) };
}

function parseCliArguments(argv, cwd) {
  if (!Array.isArray(argv) || (argv[0] !== 'generate' && argv[0] !== 'verify')) {
    fail('cli_usage_invalid');
  }
  const command = argv[0];
  let sourceRevision = null;
  let manifestPath = null;
  const artifacts = [];

  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--source-revision' && sourceRevision === null && value !== undefined) {
      sourceRevision = value;
      index += 1;
      continue;
    }
    if (flag === '--manifest' && manifestPath === null && value !== undefined) {
      manifestPath = resolve(cwd, value);
      index += 1;
      continue;
    }
    if (flag === '--artifact' && value !== undefined) {
      artifacts.push(parseArtifactArgument(value, cwd));
      index += 1;
      continue;
    }
    fail('cli_usage_invalid');
  }

  if (sourceRevision === null || artifacts.length === 0) fail('cli_usage_invalid');
  validateSourceRevision(sourceRevision);
  if (command === 'generate' && manifestPath !== null) fail('cli_usage_invalid');
  if (command === 'verify' && manifestPath === null) fail('cli_usage_invalid');
  return { command, sourceRevision, manifestPath, artifacts };
}

async function readManifest(path, options = {}) {
  const { afterOpen } = options;
  const { handle, opened } = await openRegularFile(path, {
    symlinkCode: 'manifest_file_invalid',
    invalidCode: 'manifest_file_invalid',
    unreadableCode: 'manifest_file_invalid',
    changedCode: 'manifest_file_invalid',
  });

  try {
    if (opened.size > BigInt(MAX_MANIFEST_BYTES)) fail('manifest_file_invalid');

    if (afterOpen !== undefined) {
      if (typeof afterOpen !== 'function') fail('manifest_file_invalid');
      try {
        await afterOpen();
      } catch {
        fail('manifest_file_invalid');
      }
    }

    const pathAfterOpen = await statWithoutPathDisclosure(path, 'manifest_file_invalid');
    if (!stableStatMatches(opened, pathAfterOpen)) fail('manifest_file_invalid');

    let text;
    try {
      text = await handle.readFile({ encoding: 'utf8' });
    } catch {
      fail('manifest_file_invalid');
    }

    const afterRead = await handle.stat({ bigint: true });
    if (!stableStatMatches(opened, afterRead)) fail('manifest_file_invalid');
    const pathAfterRead = await statWithoutPathDisclosure(path, 'manifest_file_invalid');
    if (!stableStatMatches(afterRead, pathAfterRead)) fail('manifest_file_invalid');
    if (Buffer.byteLength(text, 'utf8') > MAX_MANIFEST_BYTES) fail('manifest_file_invalid');

    try {
      return JSON.parse(text);
    } catch {
      fail('manifest_json_invalid');
    }
  } finally {
    await handle.close().catch(() => {});
  }
}

function errorAction(code) {
  if (code === 'manifest_json_invalid' || code === 'manifest_schema_invalid' || code === 'manifest_digest_mismatch') {
    return 'regenerate_release_manifest';
  }
  if (
    code === 'artifact_changed_during_read'
    || code === 'artifact_digest_mismatch'
    || code === 'artifact_size_mismatch'
    || code === 'source_revision_mismatch'
  ) {
    return 'rebuild_release_artifacts';
  }
  if (code === 'unexpected_release_manifest_error') return 'inspect_release_manifest_tool';
  return 'fix_release_manifest_input';
}

/**
 * Run the release-manifest operator CLI without leaking local build paths in machine-readable errors.
 * `generate` prints a manifest; `verify` prints a verification receipt. The caller owns redirection/storage.
 * `afterManifestOpen` and `afterArtifactOpen` are optional deterministic test seams invoked after opening the corresponding file.
 *
 * @param {{argv?: string[], cwd?: string, stdout?: {write: Function}, stderr?: {write: Function}, afterManifestOpen?: Function, afterArtifactOpen?: Function}} options Runtime adapters.
 * @returns {Promise<number>} Process-style exit code: 0 success, 2 deterministic validation failure.
 */
export async function runReleaseArtifactManifestCli(options = {}) {
  const {
    argv = process.argv.slice(2),
    cwd = process.cwd(),
    stdout = process.stdout,
    stderr = process.stderr,
    afterManifestOpen,
    afterArtifactOpen,
  } = options;

  try {
    const parsed = parseCliArguments(argv, cwd);
    if (parsed.command === 'generate') {
      const manifest = await buildReleaseArtifactManifest({
        sourceRevision: parsed.sourceRevision,
        artifacts: parsed.artifacts,
      });
      stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
      return 0;
    }

    const manifest = await readManifest(parsed.manifestPath, { afterOpen: afterManifestOpen });
    const verification = await verifyReleaseArtifactManifest({
      manifest,
      sourceRevision: parsed.sourceRevision,
      artifacts: parsed.artifacts,
      afterArtifactOpen,
    });
    stdout.write(`${JSON.stringify(verification)}\n`);
    return 0;
  } catch (error) {
    const code = error instanceof ReleaseArtifactManifestError
      ? error.code
      : 'unexpected_release_manifest_error';
    stderr.write(`${JSON.stringify({ ok: false, error: code, action: errorAction(code) })}\n`);
    return 2;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  process.exitCode = await runReleaseArtifactManifestCli();
}
