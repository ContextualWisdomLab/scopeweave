// Ingestion mapping: external issue / Service-Request payloads → ScopeWeave work
// items, plus a NON-CLOBBERING merge into the existing task tree and the
// parent→child rollup used to drive Service-Request fulfillment.
//
// Source payload = naruon "ProjectSemanticObject" style items:
//   { uid|id, title, kind, source_segment_uids[], confidence, edges[], owner? }
// where kind ∈ {issue, requirement, feature, service_request} and `edges`
// express structure (a parent/decomposition edge nests the item under another).
//
// Pure + dependency-free so the mapping and merge are unit-testable in isolation.
import { deriveTaskStatus, isTaskDone } from './lifecycle.mjs';

export const WORK_ITEM_KINDS = ['issue', 'requirement', 'feature', 'service_request', 'task'];

// Edge relation names (case/format-insensitive) that mean "this item hangs under
// its target in the WBS tree". Anything else is preserved as a non-structural
// edge on the work item but does not affect nesting.
const PARENT_EDGE_RELS = new Set([
  'parent', 'child_of', 'subtask_of', 'decomposes_from', 'part_of', 'belongs_to', 'derived_from',
]);

const clampConfidence = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(1, n));
};

// Stable, collision-resistant id for an incoming item so re-importing the same
// external object UPDATES rather than duplicates it.
function externalId(item) {
  const raw = item.uid ?? item.id ?? item.external_id ?? item.externalId;
  if (raw != null && String(raw).trim()) return `imp-${String(raw).trim()}`;
  return null; // caller will synthesize one
}

function edgeRel(edge) {
  return String(edge?.rel ?? edge?.type ?? edge?.relation ?? '').toLowerCase().replace(/[\s-]+/g, '_');
}
function edgeTarget(edge) {
  const t = edge?.to ?? edge?.target ?? edge?.targetUid ?? edge?.parent ?? edge?.parentUid;
  return t != null && String(t).trim() ? String(t).trim() : null;
}

// Map ONE semantic object to a normalized work item (no tree context yet).
export function mapSemanticObject(item, { fallbackIndex = 0 } = {}) {
  if (!item || typeof item !== 'object') throw new Error('semantic object must be an object');
  const title = String(item.title ?? item.name ?? '').trim();
  if (!title) throw new Error('semantic object requires a title');

  const rawKind = String(item.kind || 'issue').trim();
  const kind = WORK_ITEM_KINDS.includes(rawKind) ? rawKind : 'issue';

  const id = externalId(item) || `imp-${Date.now().toString(36)}-${fallbackIndex}`;

  // Provenance: source_segment_uids → a first-class evidence array on the work
  // item (schema extension). Accept a few shapes defensively.
  const rawUids = item.source_segment_uids ?? item.sourceSegmentUids ?? item.citations ?? [];
  const source_segment_uids = (Array.isArray(rawUids) ? rawUids : [rawUids])
    .map((u) => String(u ?? '').trim())
    .filter(Boolean);

  const edges = Array.isArray(item.edges) ? item.edges : [];
  const parentExternal = firstParentTarget(edges);

  return {
    id,
    name: title,
    kind,
    status: 'open',
    source_segment_uids,
    evidence_confidence: clampConfidence(item.confidence),
    // structural edges resolved later in merge(); keep the raw target for now.
    _parentExternal: parentExternal,
    // preserve non-structural relationships for downstream tooling
    edges: edges
      .filter((e) => !PARENT_EDGE_RELS.has(edgeRel(e)))
      .map((e) => ({ rel: edgeRel(e), to: edgeTarget(e) }))
      .filter((e) => e.rel && e.to),
    owner: String(item.owner ?? item.assignee ?? '').trim(),
    ...(item.service_request_id != null ? { service_request_id: item.service_request_id } : {}),
  };
}

function firstParentTarget(edges) {
  for (const e of edges) {
    if (PARENT_EDGE_RELS.has(edgeRel(e))) {
      const t = edgeTarget(e);
      if (t) return t;
    }
  }
  return null;
}

// Map a whole payload → work items, resolving parent edges to imported ids.
// `payload` may be an array of items or { items: [...] } or a single object.
export function mapPayload(payload) {
  const items = Array.isArray(payload) ? payload
    : Array.isArray(payload?.items) ? payload.items
      : payload?.title ? [payload] : [];
  if (!items.length) throw new Error('payload contained no importable items');

  // First pass: map each. Build an external-uid → imported-id lookup so parent
  // edges (which reference external uids) can be resolved to our ids.
  const mapped = items.map((it, i) => mapSemanticObject(it, { fallbackIndex: i }));
  const byExternal = new Map();
  items.forEach((it, i) => {
    const raw = it.uid ?? it.id ?? it.external_id ?? it.externalId;
    if (raw != null && String(raw).trim()) byExternal.set(String(raw).trim(), mapped[i].id);
  });

  for (const wi of mapped) {
    const ext = wi._parentExternal;
    delete wi._parentExternal;
    wi.parentId = ext != null && byExternal.has(ext) ? byExternal.get(ext) : null;
  }
  return mapped;
}

// Merge mapped work items INTO an existing task tree without clobbering it.
//  - unknown id  → appended (created)
//  - known id    → selectively updated in place (updated); existing progress,
//                  owner, dates, weight etc. are preserved unless the incoming
//                  item explicitly carries them.
// Returns { tasks, created, updated } where `tasks` is a NEW array (input tree
// is never mutated).
export function mergeWorkItems(existingTasks, workItems) {
  const tasks = Array.isArray(existingTasks) ? existingTasks.map((t) => ({ ...t })) : [];
  const indexById = new Map(tasks.map((t, i) => [String(t.id), i]));
  let created = 0;
  let updated = 0;

  for (const wi of workItems) {
    const key = String(wi.id);
    if (indexById.has(key)) {
      const idx = indexById.get(key);
      const prev = tasks[idx];
      tasks[idx] = {
        ...prev, // preserve everything already there
        name: wi.name || prev.name,
        kind: wi.kind || prev.kind,
        source_segment_uids: mergeUids(prev.source_segment_uids, wi.source_segment_uids),
        ...(wi.evidence_confidence != null ? { evidence_confidence: wi.evidence_confidence } : {}),
        ...(wi.owner ? { owner: wi.owner } : {}),
        ...(wi.edges && wi.edges.length ? { edges: wi.edges } : {}),
        // parentId only overwritten when the import actually resolved one
        ...(wi.parentId != null ? { parentId: wi.parentId } : {}),
        // never downgrade an in-flight/done status back to open on re-import
        status: prev.status && prev.status !== 'open' ? prev.status : wi.status,
      };
      updated++;
    } else {
      tasks.push({ ...wi });
      indexById.set(key, tasks.length - 1);
      created++;
    }
  }
  return { tasks, created, updated };
}

function mergeUids(a, b) {
  const set = new Set([...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])].map(String).filter(Boolean));
  return [...set];
}

// -------------------------------------------------------------- rollup
// Given the child work items linked to a Service Request, compute completion and
// the fulfillment state that drives the request's lifecycle.
export function rollupChildren(childTasks) {
  const children = Array.isArray(childTasks) ? childTasks : [];
  const counts = { total: 0, done: 0, in_progress: 0, open: 0, cancelled: 0 };
  for (const t of children) {
    const st = deriveTaskStatus(t);
    counts.total++;
    counts[st] = (counts[st] || 0) + 1;
  }
  // active = everything except cancelled; a request with only cancelled children
  // is treated as having no fulfilling work.
  const active = counts.total - counts.cancelled;
  let fulfillmentState;
  if (active <= 0) fulfillmentState = 'pending';
  else if (counts.done >= active) fulfillmentState = 'fulfilled';
  else if (counts.done > 0 || counts.in_progress > 0) fulfillmentState = 'in_progress';
  else fulfillmentState = 'pending';

  const ratio = active > 0 ? counts.done / active : 0;
  return { ...counts, active, fulfillmentState, ratio: Math.round(ratio * 1000) / 1000 };
}

// Convenience: pull the tasks linked to a given service request id out of a tree.
export function childrenOf(tasks, serviceRequestId) {
  const sid = String(serviceRequestId);
  return (Array.isArray(tasks) ? tasks : []).filter((t) => String(t.service_request_id ?? '') === sid);
}

export { isTaskDone };
