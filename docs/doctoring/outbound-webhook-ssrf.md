# Outbound webhook SSRF and DNS-rebinding boundary

Status: **active pull request only** (`#588`). This document does not claim that the repair is shipped on protected `develop` or released. Protected `develop` remains the source of shipped truth until the reviewed exact contributor head is integrated through live repository and organization gates.

## Customer decision this control supports

A ScopeWeave organization administrator may configure a webhook destination that causes ScopeWeave to send signed event data from the server. Because the administrator controls the destination URL, the product must distinguish an ordinary public webhook endpoint from a destination that could reach the ScopeWeave host, cloud metadata, a private network, or another special-use address.

The active repair therefore makes the network destination an authorization boundary rather than trusting a syntactically valid URL. A customer can use public HTTPS webhook endpoints; production ScopeWeave will reject destinations that are local, private, special-use, ambiguous after DNS resolution, or otherwise outside the public-unicast authority admitted by the transport.

## Threat and control traceability

| Threat / requirement | Active-PR control | Regression evidence |
| --- | --- | --- |
| Direct loopback, private, link-local, reserved, documentation, multicast, or other special-use IP destination | `server/webhook_transport.mjs` parses the URL and rejects non-public destination authorities before network I/O. IPv4-mapped IPv6 forms are normalized into the same decision. | `tests/unit/webhook-transport.test.mjs` exercises representative denied IPv4/IPv6 and mapped forms. |
| Hostname resolves to one denied answer or a mixed public+denied answer set | Every A/AAAA result must pass the public-destination policy; a mixed answer set fails closed. | DNS policy cases in `tests/unit/webhook-transport.test.mjs`. |
| DNS validation and connection use different resolver answers (rebinding/TOCTOU) | Resolution is performed before connection; the HTTPS request receives a custom `lookup` result pinned to an address from the just-validated answer set while the original hostname remains the TLS authority/SNI identity. | Rebinding and pinned-lookup cases in `tests/unit/webhook-transport.test.mjs`. |
| Redirect moves a signed body/secret to a second authority | The bounded transport uses Node HTTPS directly and does not implement redirect following. A redirect response is an application response, not a new destination request. | Redirect/non-replay cases in `tests/unit/webhook-transport.test.mjs`. |
| Retry reuses stale DNS authority | The existing application retry calls the protected transport again, so the outer delivery retry performs a new resolution/validation/pinning decision. Pre-connect failure may try another address only from the same already-validated answer set; once TLS has connected, no candidate replay occurs for that attempt. | Pre-connect fallback, post-connect replay, and rebinding-across-attempts tests. |
| Credential or fragment-bearing registration URL | Production registration accepts canonical public `https:` destinations only and rejects credentials/fragments. | `tests/api/webhook-destination-policy.test.mjs`. |
| Development compatibility accidentally weakens production | HTTP is admitted only when `SCOPEWEAVE_DEV=1` and only for explicit loopback development destinations. | Development/production registration policy tests. |
| Transport or resolver details expose internal information | Customer-visible transport errors are stable and do not include resolver answers, credentials, or lower-layer exception text. | Sanitized-failure regressions in `tests/unit/webhook-transport.test.mjs`. |
| Security wrapper changes unrelated outbound integrations | The fetch facade classifies a signed ScopeWeave webhook from method and signature/event headers without constructing or consuming an unrelated `Request`; all unrelated calls retain their original native-fetch input/init semantics. | Existing `tests/api/orchestrator-attribution.test.mjs` plus `tests/api/webhook-fetch-contract.test.mjs`. |

## Design boundary

`server/app_core.mjs` is the protected-develop application moved without behavioral editing for this slice. `server/app.mjs` is a bounded facade for webhook registration and signed webhook delivery. `server/webhook_transport.mjs` owns destination policy, resolution, address authorization, HTTPS connection pinning, and transport-level replay safety.

This structure is intentional: tenant/auth, billing, attachment, Clearfolio, project-planning, event filtering, webhook signing, attempt accounting, and the existing three-second per-attempt abort budget remain in their prior owning code. The security slice does not make those concerns subordinate to model judgment and does not alter central `.github` policy.

## Evidence state and merge boundary

The preserved RED history is followed by production implementation and two additional compatibility repairs. On contributor head `e4766272b3d5ae47e187431dd60cef7251d2086b`, the repository's existing unit/API/cloud suites are green, including the webhook transport and unrelated orchestrator attribution regressions. That hosted Server Tests run checked out GitHub's synthetic pull-request merge revision, however, so it is useful behavioral evidence but is not accepted here as immutable contributor-head merge authority.

Exact-head repository CI is being repaired independently in ScopeWeave PR `#523`; the centrally owned reusable SAST/Security exact-head defect is tracked through `ContextualWisdomLab/.github#1222`. Before `#588` can integrate, the unchanged final contributor head must receive authoritative exact-head owned coverage, required security/dependency/supply-chain evidence, zero valid unresolved findings, and qualifying independent current-head approval. Pending, synthetic-only, stale, predecessor, status-only, or model-only evidence is non-passing.

## Standards and primary technical basis

OWASP's SSRF guidance explicitly treats custom webhooks as an SSRF risk, recommends disabling redirect following, and for arbitrary external destinations recommends resolving A and AAAA records and applying the same public-address validation to every result. The implementation additionally binds that validation result to the actual socket lookup so the network destination cannot silently diverge from the authorization decision. Node's `https.request()` supports the HTTP request options needed for a custom `lookup` seam while retaining TLS hostname handling. RFC and IANA registries provide the authority for private, link-local, unique-local, and other special-purpose address classifications.

## References (APA 7)

Cheshire, S., Aboba, B., & Guttman, E. (2005). *Dynamic configuration of IPv4 link-local addresses* (RFC 3927). RFC Editor. https://doi.org/10.17487/RFC3927

Hinden, R., & Haberman, B. (2005). *Unique local IPv6 unicast addresses* (RFC 4193). RFC Editor. https://doi.org/10.17487/RFC4193

Internet Assigned Numbers Authority. (n.d.). *Number-related registries*. Retrieved August 23, 2026, from https://www.iana.org/numbers/registries

Node.js contributors. (n.d.). *HTTPS*. Node.js documentation. Retrieved August 23, 2026, from https://nodejs.org/api/https.html

OWASP Foundation. (n.d.). *Server-side request forgery prevention cheat sheet*. OWASP Cheat Sheet Series. Retrieved August 23, 2026, from https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html

Rekhter, Y., Moskowitz, B., Karrenberg, D., de Groot, G. J., & Lear, E. (1996). *Address allocation for private internets* (RFC 1918). RFC Editor. https://doi.org/10.17487/RFC1918
