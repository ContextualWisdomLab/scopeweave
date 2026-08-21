const UNNAMED_DIALOG_SELECTOR = '[role="dialog"]:not([aria-label]):not([aria-labelledby])';
const HEADING_SELECTOR = 'h1,h2,h3,h4,h5,h6';

/**
 * Gives unnamed dialogs an accessible name derived from their visible heading.
 *
 * ScopeWeave creates several dialogs dynamically. This helper keeps the
 * rendered heading and assistive-technology name aligned without duplicating
 * component-specific accessibility code. Dialogs that already declare
 * `aria-label` or `aria-labelledby` are intentionally left unchanged.
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
    dialog.setAttribute('aria-label', name);
    labeled += 1;
  }
  return labeled;
}

labelUnnamedDialogs(document);

const dialogObserver = new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      labelUnnamedDialogs(node);
    }
  }
});

dialogObserver.observe(document.documentElement, { childList: true, subtree: true });