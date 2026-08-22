const UNNAMED_DIALOG_SELECTOR = '[role="dialog"]:not([aria-label]):not([aria-labelledby])';
const HEADING_SELECTOR = 'h1,h2,h3,h4,h5,h6';
let generatedHeadingId = 0;

function ensureHeadingId(heading) {
  const existing = String(heading?.id || '').trim();
  if (existing) return existing;

  let candidate;
  do {
    generatedHeadingId += 1;
    candidate = `scopeweave-dialog-title-${generatedHeadingId}`;
  } while (document.getElementById?.(candidate));

  heading.id = candidate;
  return candidate;
}

/**
 * Gives unnamed dialogs an accessible name through their visible heading.
 *
 * ScopeWeave creates several dialogs dynamically. Linking each derived name with
 * `aria-labelledby` keeps assistive-technology output synchronized when visible
 * heading text changes, without duplicating component-specific accessibility
 * code. Dialogs that already declare `aria-label` or `aria-labelledby` are
 * intentionally left unchanged.
 *
 * The root itself is checked when it is an element, then only descendant
 * dialogs are scanned. This lets the mutation observer inspect newly inserted
 * subtrees instead of repeatedly querying the entire document.
 *
 * @param {Document|Element|Node} root DOM root whose unnamed dialogs should be checked.
 * @returns {number} Number of dialogs that received an accessible name.
 */
export function labelUnnamedDialogs(root) {
  const dialogs = [];
  if (typeof root?.matches === 'function' && root.matches(UNNAMED_DIALOG_SELECTOR)) {
    dialogs.push(root);
  }
  if (typeof root?.querySelectorAll === 'function') {
    dialogs.push(...root.querySelectorAll(UNNAMED_DIALOG_SELECTOR));
  }

  let labeled = 0;
  for (const dialog of dialogs) {
    const heading = dialog.querySelector(HEADING_SELECTOR);
    const name = heading?.textContent?.trim();
    if (!name) continue;
    dialog.setAttribute('aria-labelledby', ensureHeadingId(heading));
    labeled += 1;
  }
  return labeled;
}

labelUnnamedDialogs(document);

const dialogObserver = new MutationObserver((mutations) => {
  const ancestorDialogs = new Set();
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      labelUnnamedDialogs(node);
      const ancestorDialog = (node?.parentElement || node?.parentNode)?.closest?.(UNNAMED_DIALOG_SELECTOR);
      if (ancestorDialog) ancestorDialogs.add(ancestorDialog);
    }
  }
  for (const dialog of ancestorDialogs) {
    labelUnnamedDialogs(dialog);
  }
});

dialogObserver.observe(document.documentElement, { childList: true, subtree: true });
