# Operations Runbook

## Health checks

- **This app**: `GET /api/health` - no auth required, returns `{status:
  "ok"}`. Use this for your load balancer/orchestrator's liveness probe.
- **A project's target database**: the Phase 4 Deployment Plan generates a
  platform-specific health check (`SELECT 1`, `SELECT 1 FROM DUAL`, or
  `MilvusClient.checkHealth()`) - view it on the project's Infrastructure
  page, or call `deployment/execute`, which runs it before touching schema.

## Common operational tasks

### Rotate `JWT_SECRET`

Every previously issued token becomes invalid immediately (there is no
grace period/dual-secret support). Expect every logged-in user to be signed
out. Do this during a maintenance window, not silently.

### A user is locked out / needs a role change

There is no admin UI for this yet - update the `users` table directly:
`UPDATE users SET role = 'admin' WHERE email = '...'`. Treat this as a
privileged, logged action on your side (this app's own audit log only
covers its own API, not direct database access).

### Re-process failed ingestion records

Every ingestion run's dead letters are inspectable and (for those that
captured source text - embedding or storage failures, not corrupted-input
failures) reprocessable:

```
GET  /api/projects/:id/ingestion/runs/:runId/dead-letters
POST /api/projects/:id/ingestion/runs/:runId/retry-dead-letters
```

The frontend Ingestion page's "View dead letters" / "Retry Dead Letters"
buttons do the same thing.

### A project's target database is unreachable

`deployment/execute` and the ingestion pipeline's adapter calls will surface
a clear error naming the missing/wrong `TARGET_*` variable, or "Target
database is not reachable." Checklist:
1. Is the right `TARGET_*` block set for that project's platform?
2. Network path (VPC peering, security group, firewall) from wherever this
   app runs to that database?
3. Are credentials still valid (not rotated/expired on the target side)?

### Re-run a phase's recommendation after requirements changed

Every phase deliverable is versioned, not edited in place - re-submitting a
phase's form (Discovery, Data Pipeline Design, Index Design, etc.) creates a
new version and leaves the old one in history (`GET .../latest` vs
`GET .../` for the full list). Nothing is destroyed.

### Something needs to be regenerated after a config change

`backend/config/*.yaml` changes take effect on the next app restart
(loaded once at boot by `PlatformConfigService`) - no code change needed
for threshold/catalog tuning, but a restart is required.

## What to watch (metrics/logs)

- Nest's own request logs (stdout) plus `[Audit]`-tagged lines for every
  mutating request (see `SECURITY.md`).
- `npm run test:cov` locally for coverage trends; CI runs the full suite on
  every push (`.github/workflows/ci.yml`).
- There is no built-in metrics/alerting integration (Prometheus, etc.) for
  this application's own API today - only for the *target* vector database,
  via the generated Kubernetes/Helm values' `metrics.serviceMonitor` (Milvus)
  or your cloud provider's managed-database monitoring (Oracle/Postgres).

## Backup & restore

- **This app's own metadata** (users/projects/every phase deliverable/audit
  log): back up the `APP_DB_*` Postgres instance per your provider's normal
  mechanism (snapshots, WAL archiving, etc.) - not built into this app.
- **A project's target database**: the Phase 7 Capacity Plan's DR
  recommendation ties a backup cadence to that project's own RPO; the Phase
  4 Deployment Plan's rollback procedure describes the platform-specific
  restore path (Data Guard / RDS snapshot / Milvus `helm rollback`).

## Incident: suspected credential leak

1. Rotate `JWT_SECRET` immediately (see above - this invalidates every
   session).
2. Rotate whichever `TARGET_*` or `APP_DB_*` credential leaked, on the
   database side first, then update this app's environment.
3. Check the audit log for the affected project(s) for anything unexpected
   in the window of exposure.
4. There is no automated credential-leak detection in this app - this is a
   manual runbook step, not a triggered alert.
