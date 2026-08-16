# Microsoft Project XML delimiter boundary

## Decision

ScopeWeave's Microsoft Project import profile accepts XML whitespace between an
exact supported element name and the closing `>` delimiter. The accepted code
points are:

- U+0020 SPACE;
- U+0009 CHARACTER TABULATION;
- U+000D CARRIAGE RETURN; and
- U+000A LINE FEED.

The parser deliberately does not become a general XML processor. It recognizes
only the exact `Task`, `PredecessorLink`, and scalar element names already used
by the import adapter. Attributes, namespace prefixes, longer lookalike names,
non-XML whitespace, self-closing forms, nested same-name blocks, and truncated
blocks are rejected or yield no value under this narrow profile.

## Security and complexity boundary

The scanner remains monotonic and regex-free. It advances through every rejected
candidate and uses bounded `indexOf()` and `slice()` operations rather than
constructing dynamic regular expressions or lazy whole-document block matches.
This preserves the existing denial-of-service boundary for malformed or
adversarial uploads.

An unmatched outer element cannot consume a later nested element's closing tag.
If another same-name opening appears before the candidate closing tag, block
collection stops at the unmatched outer element instead of silently producing a
mis-parented task.

## Executable evidence

`tests/unit/msproject.test.mjs` covers:

- space, tab, carriage-return, and line-feed delimiters;
- scalar and predecessor-link elements using each allowed delimiter;
- an actual U+000B vertical tab, which is not XML whitespace;
- attributes and longer element names;
- truncated and repeated unclosed task blocks;
- nested same-name openings before a closing element; and
- the existing valid import and predecessor contracts.

The test is already part of the full unit and coverage command paths. No package
or lockfile change is required.

## Compatibility and rollback

The change broadens acceptance only for documents that are conformant with the
XML whitespace production at the delimiter positions used by this adapter.
Existing byte-exact exports retain the same task identifiers, names, dates,
parents, progress, and predecessor values.

Rollback must revert the scanner, focused tests, security documentation,
CHANGELOG entry, and this record together. Reintroducing byte-exact delimiters
would again reject standards-compliant Microsoft Project exports that contain
formatting whitespace before `>`.

## Reference

World Wide Web Consortium. (2008). *Extensible Markup Language (XML) 1.0
(Fifth Edition)*. https://www.w3.org/TR/2008/REC-xml-20081126/
