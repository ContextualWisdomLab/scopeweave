# Clearfolio capability operator and planner surface

## Decision

Startup logs are not a buyer-usable control surface. A planner who opens 산출물
must learn that document conversion is unavailable before selecting a file, and
an operator who cannot read container stdout must still retrieve the same
non-secret readiness record.

ScopeWeave therefore exposes authenticated `GET /api/capabilities` and fails
attachment upload/view with HTTP 503 when Clearfolio is locally unready. Both
surfaces reuse `clearfolioCapabilityStatus()` and never call the provider.
`GET /api/health` remains liveness-only.

This slice does not claim remote Clearfolio reachability. It completes the
operator/planner half of issue #489 configuration readiness.

## Planner next action

The attachments dialog reads `/api/capabilities` after login. When
`ready=false`, it shows the server `action` as a status notice, disables the
file input, and changes the submit label to `변환 설정 필요`. If the advisory
query fails, the dialog stays open and the server remains authoritative: an
unconfigured upload still returns 503 with the same reason and action.

## Why 503 instead of 502

RFC 9110 distinguishes a gateway/proxy error (502) from a service that is
temporarily or locally unable to handle the request (503). An unconfigured or
unsafe Clearfolio deployment is not a failed downstream hop; it is a local
capability that the process has already decided it cannot serve. Returning 503
with a stable reason prevents operators from paging a remote provider that was
never contacted.

## Security and privacy boundary

- Anonymous callers receive `401` and learn only that the route is
  authenticated. Deployment mode (`development_mock` vs `unavailable`) is not
  published on unauthenticated surfaces, including `/api/metrics`.
- The JSON body contains only capability name, readiness, mode, stable reason,
  and fixed remediation text. HMAC material, URLs, tenant claims, job IDs, and
  provider bodies are omitted.
- The UI helper only formats an already-safe record; it does not invent a
  second readiness evaluator.

## Verification contract

`tests/unit/clearfolio-capability-readiness.test.mjs` continues to launch a
fresh process per configuration and replaces `fetch` with a throwing function.
Added cases prove HMAC-invalid readiness, authenticated capability query, and
503 upload rejection without provider traffic.
`tests/unit/cloud-sync-security.test.mjs` locks the planner notice copy.

## Rollback

Remove `GET /api/capabilities`, the 503 attachment short-circuit, and the
attachments-dialog notice together. Do not restore implicit production mocks or
make `/api/health` fail.

## References

Fielding, R., Nottingham, M., & Reschke, J. (2022). *HTTP semantics* (RFC 9110;
STD 97). Internet Engineering Task Force. https://doi.org/10.17487/RFC9110

The Kubernetes Authors. (2026). *Liveness, readiness, and startup probes*.
Kubernetes Documentation.
https://kubernetes.io/docs/concepts/workloads/pods/probes/
