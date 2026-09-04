const CLOUD_DIALOG_IDS = new Set([
  'cloud-modal',
  'share-modal',
  'report-modal',
  'portfolio-modal',
  'sprint-modal',
  'attachments-modal',
  'comments-modal',
  'search-modal',
  'baseline-modal',
  'team-modal',
]);

const returnFocusByDialog = new WeakMap();

function cloudDialogFor(node) {
  if (!(node instanceof Element)) return null;
  const dialog = node.closest('[role="dialog"]');
  return dialog && CLOUD_DIALOG_IDS.has(dialog.id) ? dialog : null;
}

function focusableIn(dialog) {
  return dialog.querySelector(
    'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
  );
}

function rememberInvokerAndEnter(dialog) {
  if (dialog.classList.contains('hidden')) return;

  const active = document.activeElement;
  if (active instanceof HTMLElement && !dialog.contains(active)) {
    returnFocusByDialog.set(dialog, active);
  }

  queueMicrotask(() => {
    if (dialog.classList.contains('hidden') || dialog.contains(document.activeElement)) return;
    focusableIn(dialog)?.focus();
  });
}

function observeDialog(node) {
  if (!(node instanceof Element)) return;
  const dialog = cloudDialogFor(node) || (CLOUD_DIALOG_IDS.has(node.id) ? node : null);
  if (dialog) rememberInvokerAndEnter(dialog);
  for (const child of node.querySelectorAll?.('[role="dialog"]') || []) {
    if (CLOUD_DIALOG_IDS.has(child.id)) rememberInvokerAndEnter(child);
  }
}

const observer = new MutationObserver((records) => {
  for (const record of records) {
    if (record.type === 'attributes') observeDialog(record.target);
    for (const node of record.addedNodes) observeDialog(node);
  }
});
observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });

// Preserve the invoking control whenever cloud-sync moves focus into a dialog.
document.addEventListener('focusin', (event) => {
  const dialog = cloudDialogFor(event.target);
  const previous = event.relatedTarget;
  if (dialog && previous instanceof HTMLElement && !dialog.contains(previous)) {
    returnFocusByDialog.set(dialog, previous);
  }
}, true);

// Pointer and keyboard close controls use their existing cloud-sync close path;
// this listener only restores the invoking control after that path completes.
document.addEventListener('click', (event) => {
  const close = event.target instanceof Element
    ? event.target.closest('button.close-button[aria-keyshortcuts~="Escape"]')
    : null;
  const dialog = cloudDialogFor(close);
  if (!dialog) return;

  const invoker = returnFocusByDialog.get(dialog);
  queueMicrotask(() => {
    if (!dialog.classList.contains('hidden')) return;
    if (invoker instanceof HTMLElement && invoker.isConnected) invoker.focus();
  });
}, true);

// Escape is owned here only for cloud-sync dialogs. Gantt/editor Escape remains
// with app.js, so one keystroke cannot dismiss two independent surfaces.
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || event.defaultPrevented) return;

  const dialogs = [...document.querySelectorAll('[role="dialog"]')]
    .filter((dialog) => CLOUD_DIALOG_IDS.has(dialog.id) && !dialog.classList.contains('hidden'));
  const dialog = dialogs.at(-1);
  if (!dialog) return;

  const close = dialog.querySelector('button.close-button[aria-keyshortcuts~="Escape"]');
  if (!close) return;

  event.preventDefault();
  event.stopImmediatePropagation();
  close.click();
}, true);
