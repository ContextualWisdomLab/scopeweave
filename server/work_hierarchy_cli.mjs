import { readFile as readFileFs, stat as statFs } from 'node:fs/promises';
import { WorkHierarchyError, validateWorkHierarchy } from './work_hierarchy.mjs';

/** Maximum JSON file size accepted by the hierarchy preflight adapter. */
export const MAX_HIERARCHY_FILE_BYTES = 32 * 1024 * 1024;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Validate either a raw work-item array or a ScopeWeave export envelope.
 *
 * @param {unknown} document - Parsed JSON document.
 * @returns {{itemCount: number, maxDepth: number}} Validated hierarchy summary.
 * @throws {WorkHierarchyError} When the document shape or graph is invalid.
 */
export function validateWorkHierarchyDocument(document) {
  if (Array.isArray(document)) return validateWorkHierarchy(document);
  if (isRecord(document) && Array.isArray(document.tasks)) {
    return validateWorkHierarchy(document.tasks);
  }
  throw new WorkHierarchyError('work_hierarchy_document_invalid');
}

/**
 * Read and validate one hierarchy JSON file using a byte bound before parsing.
 *
 * Filesystem and JSON parser details are deliberately collapsed into stable
 * error codes so local paths or document fragments never become diagnostics.
 * Dependencies are injectable to keep the adapter deterministic in tests and
 * reusable by future desktop/operator shells.
 *
 * @param {string} filePath - Local JSON path selected by an operator.
 * @param {{stat?: typeof statFs, readFile?: typeof readFileFs}} [ports] - I/O ports.
 * @returns {Promise<{itemCount: number, maxDepth: number}>} Validated summary.
 * @throws {WorkHierarchyError} On file, JSON, size, or graph validation failure.
 */
export async function validateWorkHierarchyFile(
  filePath,
  { stat = statFs, readFile = readFileFs } = {},
) {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    throw new WorkHierarchyError('work_hierarchy_file_required');
  }

  let fileInfo;
  try {
    fileInfo = await stat(filePath);
  } catch {
    throw new WorkHierarchyError('work_hierarchy_file_unreadable');
  }
  if (!fileInfo || typeof fileInfo.isFile !== 'function' || !fileInfo.isFile()) {
    throw new WorkHierarchyError('work_hierarchy_file_unreadable');
  }
  if (!Number.isFinite(fileInfo.size) || fileInfo.size < 0) {
    throw new WorkHierarchyError('work_hierarchy_file_unreadable');
  }
  if (fileInfo.size > MAX_HIERARCHY_FILE_BYTES) {
    throw new WorkHierarchyError('work_hierarchy_file_too_large', 413);
  }

  let text;
  try {
    text = await readFile(filePath, 'utf8');
  } catch {
    throw new WorkHierarchyError('work_hierarchy_file_unreadable');
  }

  let document;
  try {
    document = JSON.parse(text);
  } catch {
    throw new WorkHierarchyError('work_hierarchy_json_invalid');
  }
  return validateWorkHierarchyDocument(document);
}

/**
 * Execute the hierarchy preflight command without terminating the host process.
 *
 * Success and failure output contains only decision metadata; source paths,
 * work-item IDs, labels, and arbitrary plan fields are never echoed.
 *
 * @param {object} [options] - CLI ports and arguments.
 * @param {string[]} [options.argv] - Positional arguments; first value is JSON path.
 * @param {{write: (chunk: string) => unknown}} [options.stdout] - Success stream.
 * @param {{write: (chunk: string) => unknown}} [options.stderr] - Failure stream.
 * @param {typeof statFs} [options.stat] - File metadata port.
 * @param {typeof readFileFs} [options.readFile] - File read port.
 * @returns {Promise<number>} Process-compatible exit code (0 success, 1 failure).
 */
export async function runWorkHierarchyCli({
  argv = process.argv.slice(2),
  stdout = process.stdout,
  stderr = process.stderr,
  stat = statFs,
  readFile = readFileFs,
} = {}) {
  try {
    const summary = await validateWorkHierarchyFile(argv[0], { stat, readFile });
    stdout.write(`${JSON.stringify({ valid: true, ...summary })}\n`);
    return 0;
  } catch (error) {
    const code = error instanceof WorkHierarchyError
      ? error.code
      : 'work_hierarchy_preflight_failed';
    stderr.write(`${JSON.stringify({ valid: false, code })}\n`);
    return 1;
  }
}
