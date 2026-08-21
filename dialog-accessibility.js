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
 * @param {Document|Element} root DOM root whose unnamed dialogs should be checked.
 * @returns {number} Number of dialogs that received an accessible name.
 */
export function labelUnnamedDialogs(root) {
  let labeled = 0;
  for (const dialog of root.querySelectorAll(UNNAMED_DIALOG_SELECTOR)) {
    const heading = dialog.querySelector(HEADING_SELECTOR);
    const name = heading?.textContent?.trim();
    if (!name) continue;
    dialog.setAttribute('aria-label', name);
    labeled += 1;
  }
  return labeled;
}

labelUnnamedDialogs(document);

const dialogObserver = new MutationObserver(() => {
  labelUnnamedDialogs(document);
});

dialogObserver.observe(document.documentElement, { childList: true, subtree: true });
