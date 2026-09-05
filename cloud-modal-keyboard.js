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

const FOCUSABLE_SELECTOR = [
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'button:not([disabled])',
  'a[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

const returnFocusByDialog = new WeakMap();

function cloudDialogFor(node) {
  if (!(node instanceof Element)) return null;
  const dialog = node.closest('[role="dialog"]');
  return dialog && CLOUD_DIALOG_IDS.has(dialog.id) ? dialog : null;
}

function focusablesIn(dialog) {
  return [...dialog.querySelectorAll(FOCUSABLE_SELECTOR)]
    .filter((element) => element instanceof HTMLElement && element.getClientRects().length > 0);
}

function rememberInvokerAndEnter(dialog) {
  if (dialog.classList.contains('hidden')) return;

  const active = document.activeElement;
  if (active instanceof HTMLElement && !dialog.contains(active)) {
    returnFocusByDialog.set(dialog, active);
  }

  queueMicrotask(() => {
    if (dialog.classList.contains('hidden') || dialog.contains(document.activeElement)) return;
    focusablesIn(dialog)[0]?.focus();
  });
}

function observeAddedNode(node) {
  if (!(node instanceof Element)) return;
  if (CLOUD_DIALOG_IDS.has(node.id)) rememberInvokerAndEnter(node);
  for (const dialog of node.querySelectorAll('[role="dialog"]')) {
    if (CLOUD_DIALOG_IDS.has(dialog.id)) rememberInvokerAndEnter(dialog);
  }
}

const observer = new MutationObserver((records) => {
  for (const record of records) {
    if (record.type === 'attributes') {
      if (record.target instanceof Element && CLOUD_DIALOG_IDS.has(record.target.id)) {
        rememberInvokerAndEnter(record.target);
      }
      continue;
    }
    for (const node of record.addedNodes) observeAddedNode(node);
  }
});
observer.observe(document.documentElement, {
  subtree: true,
  childList: true,
  attributes: true,
  attributeFilter: ['class'],
});

// Preserve the invoking control whenever cloud-sync moves focus into a dialog.
document.addEventListener('focusin', (event) => {
  const dialog = cloudDialogFor(event.target);
  const previous = event.relatedTarget;
  if (dialog && previous instanceof HTMLElement && !dialog.contains(previous)) {
    returnFocusByDialog.set(dialog, previous);
  }
}, true);

// Existing close-button and backdrop paths retain ownership of modal state.
// This listener only restores the invoking control after those paths complete.
document.addEventListener('click', (event) => {
  const target = event.target instanceof Element ? event.target : null;
  const close = target?.closest('button.close-button[aria-keyshortcuts~="Escape"]');
  const backdrop = target?.matches('.modal-backdrop') ? target : null;
  const dialog = cloudDialogFor(close || backdrop);
  if (!dialog) return;

  const invoker = returnFocusByDialog.get(dialog);
  queueMicrotask(() => {
    if (!dialog.classList.contains('hidden')) return;
    if (invoker instanceof HTMLElement && invoker.isConnected) invoker.focus();
  });
}, true);

function activeCloudDialog() {
  return [...document.querySelectorAll('[role="dialog"]')]
    .filter((dialog) => CLOUD_DIALOG_IDS.has(dialog.id) && !dialog.classList.contains('hidden'))
    .at(-1) || null;
}

// Cloud dialogs own their Tab loop and Escape dismissal here. Gantt/editor
// keyboard handling remains in app.js, so one Escape cannot dismiss two surfaces.
document.addEventListener('keydown', (event) => {
  if (event.defaultPrevented || (event.key !== 'Escape' && event.key !== 'Tab')) return;

  const dialog = activeCloudDialog();
  if (!dialog) return;

  if (event.key === 'Tab') {
    const focusables = focusablesIn(dialog);
    if (!focusables.length) return;

    const first = focusables[0];
    const last = focusables.at(-1);
    const active = document.activeElement;
    if (event.shiftKey && (!dialog.contains(active) || active === first)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (!dialog.contains(active) || active === last)) {
      event.preventDefault();
      first.focus();
    }
    return;
  }

  const close = dialog.querySelector('button.close-button[aria-keyshortcuts~="Escape"]');
  if (!close) return;

  event.preventDefault();
  event.stopImmediatePropagation();
  close.click();
}, true);
