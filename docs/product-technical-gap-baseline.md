# Product–technical gap baseline

This baseline is derived from the current ScopeWeave source and is updated with executable evidence rather than aspirational status.

## Bounded-context baseline

ScopeWeave currently contains five product responsibilities. **Planning** is the core subdomain and owns projects, task structures, revisions, baselines, schedule data, and optimistic-concurrency invariants. **Workspace Access** is a supporting subdomain and owns organizations, membership, invitations, OIDC, personal access tokens, and authorization. **Integration Delivery** is a supporting subdomain and owns webhook registration, signed-event delivery, retry outcomes, and its outbound-network security policy. **Commercial Entitlement** is a supporting subdomain and owns plans, usage limits, and checkout. **Operational Telemetry** is a generic subdomain and owns request/delivery metrics and operational logs; it is not an authoritative audit or domain-event store.

The Integration Delivery context must depend on a narrow outbound-network adapter rather than embedding DNS/TLS/HTTP policy in Hono route orchestration. Persisted webhook facts remain owned by ScopeWeave; socket selection, DNS resolution, TLS, redirect policy, and timeout behavior belong to the delivery adapter. External network behavior is an anti-corruption boundary: DNS answers or HTTP redirect targets never become trusted domain facts merely because a webhook record was previously accepted.

## Current security gap: outbound webhook SSRF

| Evidence | Status | Acceptance contract |
| --- | --- | --- |
| PR #649 original head `ce31e62667cb3a3b7d0deb79c5464952f27dd63c` added registration-time hostname prefix checks only. | FAIL | Registration accepts HTTPS only, rejects credentials/local/special-purpose literal addresses, and does not mistake ordinary DNS labels for IP literals. |
| Exact-head production-boundary RED introduced on `e84c47c95ef86da416e361704c8b89675227fcf6`. | RED | A pre-existing persisted loopback webhook must receive zero network requests; the failed delivery must be recorded and stay within the bounded retry contract. |
| Current reviewers identified DNS rebinding/resolution, IPv6, redirects, plaintext HTTP, public numeric-looking hostname false positives, and nondeterministic external-network smoke tests. | OPEN until GREEN | Every delivery attempt re-resolves through the operating-system resolver at the socket boundary, rejects any non-public answer, pins the connection to validated answers, disables redirect following, preserves TLS verification, and uses deterministic network seams in tests. |

### Verification required before merge

The unchanged final PR head must have focused API/unit security tests plus the repository's full required test/coverage/security checks terminal-success. Predecessor, absent, queued, skipped, or model-only evidence is not acceptance evidence. All current substantive review threads must be obsolete by source proof or resolved after reviewers can inspect the repaired head.

## Traceability

- OWASP Foundation. (2026). *Server Side Request Forgery Prevention Cheat Sheet*. https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html
- Internet Assigned Numbers Authority. (2026). *IPv4 Special-Purpose Address Space*. https://www.iana.org/assignments/iana-ipv4-special-registry/iana-ipv4-special-registry.xhtml
- Internet Assigned Numbers Authority. (2026). *IPv6 Special-Purpose Address Space*. https://www.iana.org/assignments/iana-ipv6-special-registry/iana-ipv6-special-registry.xhtml
- Cotton, M., Vegoda, L., Bonica, R., & Haberman, B. (2013). *Special-Purpose IP Address Registries (RFC 6890)*. Internet Engineering Task Force. https://www.rfc-editor.org/rfc/rfc6890
- OpenJS Foundation. (2026). *Node.js DNS API*. https://nodejs.org/api/dns.html
- OpenJS Foundation. (2026). *Node.js HTTPS API*. https://nodejs.org/api/https.html
