# Clearfolio capability readiness and liveness separation

## Decision

Clearfolio is an optional ScopeWeave MSA capability. Its local configuration state must be visible to an operator without turning the whole planner process unhealthy and without making a provider network request merely to answer a health question.

ScopeWeave therefore keeps `GET /api/health` as whole-process liveness and publishes one non-secret structured `capability.readiness` record for Clearfolio at server startup. The readiness record is produced by the same configuration validator used by production Clearfolio operations and returns only four bounded fields: `ready`, `mode`, `reason`, and `action`.

This is a bounded follow-up slice of issue #489. It does not claim remote Clearfolio reachability, latency, authentication success, artifact availability, or end-to-end readiness. Those require operational evidence from real provider calls and the attachment status path; the startup record proves configuration readiness only.

## States

### Provider

A valid root Clearfolio origin, HMAC secret, and optional artifact-origin policy returns:

```json
{"ready":true,"mode":"provider","reason":null,"action":null}
```

No DNS lookup or HTTP request occurs while deriving this state.

### Explicit development mock

`SCOPEWEAVE_DEV=1` with no provider URL returns:

```json
{"ready":true,"mode":"development_mock","reason":null,"action":"Configure a Clearfolio provider before using this deployment for production document conversion."}
```

The mode name deliberately prevents the mock from being presented as production-provider readiness.

### Unavailable or invalid production configuration

Missing or invalid production configuration returns `ready=false`, `mode=unavailable`, a stable configuration reason, and an action that tells the operator what to change without echoing a URL, shared secret, provider body, network address, or tenant claim.

Examples include:

- `clearfolio_not_configured` -> configure the provider URL and HMAC secret, or use the development flag only for local work;
- `clearfolio_hmac_secret_invalid` -> provide at least 32 non-whitespace characters;
- URL component or transport failures -> use a root HTTPS origin without credentials, path, query, or fragment;
- `clearfolio_artifact_origins_invalid` -> provide only comma-separated HTTPS origins or remove the optional setting.

## Why liveness remains independent

Kubernetes distinguishes liveness from readiness: a failed liveness probe can trigger container restart, while readiness controls whether a workload should receive service traffic. Clearfolio is not required for planning, authentication, project CRUD, or the static client, so treating its configuration as whole-process liveness would turn an optional dependency failure into an unnecessary planner outage.

The existing `/api/health` response remains `{"ok":true}` while the Clearfolio capability is unavailable. Operators inspect the startup readiness record for the optional integration and continue to use attachment failure/status evidence for remote operational diagnosis.

RFC 9110 defines a successful GET response as a representation of the target resource state. ScopeWeave keeps the `/api/health` resource narrowly defined as process liveness rather than silently changing its semantics to aggregate every optional dependency.

## Security and privacy boundary

The readiness function calls only local configuration validators. It never:

- calls `fetch`, resolves DNS, follows redirects, or contacts Clearfolio;
- includes `CLEARFOLIO_HMAC_SECRET`, tenant claims, provider response text, job IDs, artifact tokens, or configured URLs in output;
- changes a capability from unavailable to a successful mock outside explicit development mode;
- weakens the provider URL or artifact-origin allowlist checks established by the parent stack.

Unknown non-configuration exceptions are rethrown instead of being silently misclassified as a configuration state.

## Verification contract

`tests/unit/clearfolio-capability-readiness.test.mjs` launches fresh processes so module-import configuration cannot leak between cases. It replaces global `fetch` with a throwing function and proves that readiness evaluation performs no provider transport. The cases cover:

- unconfigured production with live `/api/health` and unavailable Clearfolio;
- explicit development mock with a production-configuration action;
- valid production provider configuration;
- insecure production HTTP configuration;
- malformed artifact-origin policy detected before provider transport.

The regression executes in both `test:unit` and `test:coverage:cases`; `server/clearfolio.mjs` remains in the canonical owned-production c8 target set.

## Rollback

Rollback removes the startup capability record and exported readiness function together. It must not restore implicit production mocks or make `/api/health` fail because Clearfolio is optional. If operators require a remote dependency probe later, add it as a separately named operational signal with bounded timeout and explicit failure semantics rather than expanding liveness implicitly.

## References

Fielding, R., Nottingham, M., & Reschke, J. (2022). *HTTP semantics* (RFC 9110; STD 97). Internet Engineering Task Force. https://doi.org/10.17487/RFC9110

The Kubernetes Authors. (2026). *Liveness, readiness, and startup probes*. Kubernetes Documentation. https://kubernetes.io/docs/concepts/workloads/pods/probes/
