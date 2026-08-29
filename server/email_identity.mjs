/**
 * Canonicalize an email mailbox for the identity comparisons used by invites.
 * NFKC handles compatibility forms; lowercasing plus final-sigma and sharp-s
 * folds covers the Unicode case-fold mappings that JavaScript does not expose
 * as a native operation.
 *
 * @param {unknown} value persisted or user-supplied email address
 * @returns {string} deterministic Unicode-aware identity key
 */
export function canonicalizeMailbox(value) {
  return String(value ?? '')
    .trim()
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\u03c2/g, '\u03c3')
    .replace(/\u00df/g, 'ss');
}
