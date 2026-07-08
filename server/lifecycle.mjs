// Work-item + Service-Request status state machines (pure, dependency-free).
//
// Historically a task's "status" was only ever DERIVED from its progress percent
// (actualProgressStatus / actualProgress). That cannot express "picked up but 0%
// done" vs "not started", and it has no notion of an explicit workflow. This
// module adds a real, explicit state machine for both layers of the ITSM model:
//
//   Work item (the performing team's board):   open → in_progress → done
//                                               (any) → cancelled
//   Service Request (the requester's ticket):  submitted → approved → in_progress
//                                               → fulfilled → closed
//                                               submitted → rejected
//                                               (pre-fulfilled) → cancelled
//
// Everything here is a pure function so it is trivially unit-testable and shared
// between the API layer and any future client.

// ----------------------------------------------------------- work item status
export const TASK_STATUSES = ['open', 'in_progress', 'done', 'cancelled'];

// Allowed transitions. `done` and `cancelled` are terminal-ish; we still allow
// reopening done→in_progress (real boards need to undo a premature completion).
const TASK_TRANSITIONS = {
  open: ['in_progress', 'done', 'cancelled'],
  in_progress: ['done', 'open', 'cancelled'],
  done: ['in_progress'], // reopen
  cancelled: ['open'],   // resurrect
};

export function isTaskStatus(s) {
  return TASK_STATUSES.includes(s);
}

export function canTransitionTask(from, to) {
  if (!isTaskStatus(to)) return false;
  if (from === to) return true; // idempotent no-op
  return (TASK_TRANSITIONS[from] || []).includes(to);
}

// Legacy bridge: when a task has no explicit `status`, derive one from its
// progress so old projects (and MS-Project / percent-only imports) still slot
// into the state machine. 0% → open, 1–99% → in_progress, 100% → done.
export function deriveTaskStatus(task) {
  if (task && isTaskStatus(task.status)) return task.status;
  const pct = progressPercent(task);
  if (pct >= 100) return 'done';
  if (pct > 0) return 'in_progress';
  return 'open';
}

export function isTaskDone(task) {
  return deriveTaskStatus(task) === 'done';
}

// Best-effort numeric progress from the heterogeneous task shapes in the tree.
function progressPercent(task) {
  if (!task || typeof task !== 'object') return 0;
  if (Number.isFinite(Number(task.actualProgress))) return clampPct(Number(task.actualProgress));
  // "PM확인(100%)" / "미착수(0%)" style enum → pull the % out.
  const m = String(task.actualProgressStatus || '').match(/(\d{1,3})\s*%/);
  if (m) return clampPct(Number(m[1]));
  return 0;
}
const clampPct = (n) => (Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0);

// Apply a transition, returning the updated task (never mutates the input).
export function applyTaskTransition(task, to) {
  const from = deriveTaskStatus(task);
  if (!canTransitionTask(from, to)) {
    throw new Error(`invalid task status transition: ${from} → ${to}`);
  }
  const next = { ...task, status: to };
  // Keep the derived/percent view coherent with the explicit status so existing
  // EVM/rollup math that reads actualProgress stays correct.
  if (to === 'done') next.actualProgress = 100;
  else if (to === 'open') next.actualProgress = 0;
  else if (to === 'in_progress' && (!Number.isFinite(Number(next.actualProgress)) || Number(next.actualProgress) >= 100 || Number(next.actualProgress) <= 0)) {
    next.actualProgress = 50; // a sensible "in flight" default; user can refine
  }
  return next;
}

// ------------------------------------------------------ service request status
export const SR_STATUSES = ['submitted', 'approved', 'in_progress', 'fulfilled', 'closed', 'rejected', 'cancelled'];

const SR_TRANSITIONS = {
  submitted: ['approved', 'rejected', 'cancelled'],
  approved: ['in_progress', 'cancelled'],
  in_progress: ['fulfilled', 'cancelled'],
  fulfilled: ['closed', 'in_progress'], // reopen if the rollup regresses
  closed: [],
  rejected: [],
  cancelled: [],
};

export function isSrStatus(s) {
  return SR_STATUSES.includes(s);
}

export function canTransitionSr(from, to) {
  if (!isSrStatus(to)) return false;
  if (from === to) return true;
  return (SR_TRANSITIONS[from] || []).includes(to);
}

// A request is "live" (its fulfillment can still be driven by task rollup) while
// it is approved / in_progress / fulfilled — not once it is closed/rejected/etc.
export function isSrLive(status) {
  return status === 'approved' || status === 'in_progress' || status === 'fulfilled';
}
