## 2026-08-22 - Fix IDOR in webhook delivery lookup
**Vulnerability:** The POST `/api/webhooks/:provider` endpoint (or similar `GET /api/orgs/:id/webhooks/:whId/deliveries`) failed to verify that a webhook belongs to the project/org specified in the payload or path, allowing an attacker to modify or view data for any project by supplying a known webhook ID.
**Learning:** Proper Object-Level Authorization (BOLA/IDOR protection) must verify ownership of the specific resource against the authenticated user's organization context, not just rely on the webhook secret or a global ID.
**Prevention:** Always validate that `row.org_id` or `row.project_id` matches the authenticated/requested `org_id` or `project_id` when performing operations on resources like webhooks.
