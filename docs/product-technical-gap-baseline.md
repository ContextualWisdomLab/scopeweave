# Product Technical Gap Baseline

This baseline documents acceptable gaps between idealized technical behavior and practical production reality. These gaps are accepted in the current head `f641ac54f4e8f5b35fd98c66d2752ec3c99aa13a` and do not constitute blocking defects.

## Authentication Timing

The system protects against user enumeration by evaluating the `scrypt` hash function even when a user is not found, closing the vast majority of the timing gap.

**Accepted Discrepancy:** The endpoint behavior is not strictly, mathematically constant-time. We bypass `Buffer` allocations and `timingSafeEqual` when using the dummy fallback to avoid unnecessary object allocations. We claim a *discrepancy factor* reduction rather than true constant-time endpoint behavior.
