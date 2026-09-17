# Production Readiness Review

This is the closing review required by the source prompt's EXECUTION MODE:
*"perform a complete Production Readiness Review and identify all remaining
gaps before declaring the application production-ready."* It is honest by
design - several items below are marked **Gap**, not because the sprint ran
out of time to hide them, but because they genuinely require things this
environment doesn't have (a live Oracle/PostgreSQL/Milvus instance, real
API keys, a CI runner with historical data) to close responsibly.

## 1. Deliverable-by-deliverable status (FINAL OUTPUT, source prompt)

| # | Deliverable | Status | Notes |
|---|---|---|---|
| 1 | Complete source code | Done | `backend/src`, `frontend/src` |
| 2 | Project structure | Done | Modular per-phase Nest modules; see `README.md` Architecture |
| 3 | Architecture diagram | Done | `README.md` Architecture section (text form) |
| 4 | Database schema | Done | TypeORM entities (app metadata) + generated DDL per target platform (Phase 2/4) |
| 5 | API specification | Done | Swagger/OpenAPI, auto-generated, served at `/api/docs` |
| 6 | Configuration | Done | `backend/config/*.yaml`, `.env.example` - nothing hard-coded |
| 7 | Docker configuration | Done | `backend/Dockerfile`, `frontend/Dockerfile`, root `docker-compose.yml` |
| 8 | Kubernetes manifests | Done | Generated per-project by the Deployment Plan (Phase 4) for Milvus; not static files, by design - see `DEPLOYMENT.md` |
| 9 | Terraform/IaC | Done | Generated per-project by the Deployment Plan; explicitly labeled as a starting point, not `apply`-ready |
| 10 | Database deployment scripts | Done | Generated per-project (Phase 2/4); real, adapter-executable DDL |
| 11 | Ingestion pipeline | Done | `backend/src/ingestion` - batching, retry, dedup, dead-letter, idempotency |
| 12 | Test suite | Done | 208 backend unit tests, `npm run test:e2e` health check; **Gap**: no integration tests against real Oracle/Postgres/Milvus (see §3) |
| 13 | Sample datasets | Done | `sample-datasets/rag-knowledge-base.json` |
| 14 | Benchmark scripts | Done | In-app harness (`backend/src/benchmark`) + standalone CLI wrapper `backend/scripts/run-benchmark.ts` |
| 15 | Security documentation | Done | `SECURITY.md` |
| 16 | Operations runbook | Done | `RUNBOOK.md` |
| 17 | Deployment guide | Done | `DEPLOYMENT.md` |
| 18 | User guide | Done | `USER_GUIDE.md` |
| 19 | Troubleshooting guide | Done | `TROUBLESHOOTING.md` |
| 20 | Production-readiness checklist | Done | This document |

## 2. Development rules (source prompt, "IMPORTANT DEVELOPMENT RULES")

| Rule | Status |
|---|---|
| 1. Do not skip phases | Done - all 7 phases implemented in order, each gated on the previous |
| 2. No monolithic module | Done - 25 focused Nest modules |
| 3. Clean architecture / separation of concerns | Done - engines (pure logic) separated from persistence services from controllers |
| 4. Pluggable Oracle/PostgreSQL/Milvus | Done - one `VectorDatabaseAdapter` interface, three real implementations, selected via `VectorAdapterFactory` |
| 5. Never hard-code credentials | Done - all secrets via env vars, `.env.example` documents every one |
| 6. Never hard-code infrastructure thresholds | Done - every threshold lives in `config/thresholds.yaml`/`indexes.yaml`/etc. |
| 7. Validate all user input | Done - `class-validator` DTOs + global `ValidationPipe({whitelist, forbidNonWhitelisted})` on every endpoint |
| 8. Explainable recommendations | Done - every engine emits Recommendation → Reason → Evidence → Trade-off → Alternative |
| 9. Automated tests for every major component | Done - 208 unit tests across all engines/services; see §3 for what they don't cover |
| 10. Identify customer-specific configuration | Done - `TARGET_*` env vars documented as "the customer's database," distinct from `APP_DB_*` |
| 11. No destructive ops without confirmation | Done - every adapter's `dropSchema` requires `confirm: true`; `deployment/execute` never calls it |
| 12. Backward-compatible DB migrations | **Gap** - see §3 |
| 13. Log administrative actions | Done - `AuditLoggingInterceptor` persists every mutating request |
| 14. Design for horizontal scalability | Partial - the API is stateless (JWT, no server-side session) so it scales horizontally; the app's own Postgres metadata store is a single instance (see §3) |
| 15. Design APIs for future automation | Done - every phase is a REST resource with a stable shape, not just UI-driven |
| 16. Actionable error messages | Done - `GlobalExceptionFilter` returns structured errors; validation/adapter errors name the missing config var or unmet precondition |
| 17. Security as a core requirement | Done - see `SECURITY.md` |
| 18. Validate each phase before proceeding | Done - every phase N+1 service throws a clear `BadRequestException` naming which prior phase is missing |

## 3. Known gaps (tracked, not hidden)

These are the honest limitations of what could be built and verified in this
environment. None are silent - each is called out here and, where relevant,
in the code comment nearest the limitation.

1. **No live database connectivity verified.** This development environment
   has no running Oracle, PostgreSQL, Milvus, or Kubernetes cluster. Every
   adapter is implemented against the real SDK/driver APIs and unit-tested
   against mocked clients (26 adapter tests), but end-to-end connectivity has
   never been exercised. **Before production use**: run the Deployment Plan's
   `execute` action against a real staging instance of the target platform
   and confirm the health check, schema creation, and index creation succeed.

2. **No database migrations.** The app runs with TypeORM's `synchronize:
   true` outside `NODE_ENV=production` (see `app.module.ts`) and has never
   been pointed at production. Generating real migrations requires
   `typeorm migration:generate` to diff against a live database - this
   environment has none, and hand-writing ~13 entities' worth of DDL by hand
   without a way to verify it is more likely to introduce a bug than to
   prevent one. The CLI scaffold is in place (`backend/src/data-source.ts`,
   `npm run migration:generate`/`migration:run`) so this is a mechanical next
   step, not a redesign. **Before production use**: run
   `npm run migration:generate -- src/migrations/Initial` against a real dev
   database, review the generated SQL, commit it, and set
   `synchronize: false` / run migrations on deploy.

3. **Embeddings are a stand-in without `OPENAI_API_KEY`.** Only OpenAI has a
   real embedding client; every other catalog provider (Cohere, Google,
   open-source) and any run without an API key uses a deterministic,
   semantically meaningless SHA-256-seeded vector (see
   `backend/src/embedding-client`). This is intentional for cost-free,
   offline, deterministic testing - real retrieval quality has not been
   evaluated with real embeddings, only pipeline mechanics (chunking →
   embedding → validation → storage → search).

4. **Oracle has no per-query search-parameter tuning.** Postgres and Milvus
   both apply `efSearch`/`nprobe` at query time for real (Sprint 7); Oracle's
   adapter deliberately does not, because no documented per-query mechanism
   was confirmed rather than guessed at. This means the Optimization Report's
   variant comparison is not meaningful for Oracle deployments today - only
   the index-creation-time parameters apply.

5. **Benchmark QPS is single-connection, sequential.** The benchmark harness
   measures one query at a time on one connection; "achieved QPS" is a
   latency-derived throughput ceiling for a single connection, not a
   concurrent-load test. A real capacity validation needs a proper load-test
   tool (k6, Locust) driving concurrent connections, which is out of scope
   for the in-app harness.

6. **5 npm audit findings remain, deliberately deferred.** `npm audit fix`
   (non-breaking) was applied; the rest require major-version upgrades to
   `@nestjs/platform-express`, `@nestjs/swagger` (pulling in transitive
   `multer`/`body-parser`/`qs`/`js-yaml`/`lodash`/`tar`/`uuid` fixes) that
   this session chose not to force through without being able to run the app
   end-to-end to verify nothing broke. See `SECURITY.md` for the full list
   and re-audit instructions.

7. **RBAC is coarse (3 roles).** ADMIN/ARCHITECT can mutate, VIEWER cannot,
   and only `deployment/execute` is ADMIN-only. There is no per-project
   collaborator model (e.g. inviting a specific architect to a specific
   project) - `ProjectsService.assertAccess` only checks owner-or-admin.

8. **No session revocation.** Auth is stateless JWT with no server-side
   session store, so a compromised token cannot be revoked before it
   expires (`JWT_EXPIRES_IN`, default 8h). Mitigation today is a short
   expiry; a real fix (refresh tokens + a revocation list) is not
   implemented.

9. **App metadata database has no HA story of its own.** The Capacity
   Forecast Engine (Phase 7) plans for the *target* vector database's
   scaling; the app's own Postgres metadata store (users/projects/audit log/
   all deliverables) is a single instance with no documented replica/backup
   setup beyond "use your cloud provider's managed Postgres."

10. **No load/performance testing has been run** against this application
    itself (as opposed to the target vector database, which the benchmark
    harness does exercise). Sprint 10's "performance testing" is therefore
    unverified for the platform's own API layer.

11. **`config/infrastructure.yaml` is unused.** It was scaffolded in Sprint 1
    per the source prompt's configuration-driven-design list but no engine
    ever reads it - every infrastructure sizing calculation (Phase 1, 3, and
    7) ended up living in `thresholds.yaml`'s `infrastructureEstimation`
    section instead. Harmless (it's an empty `sizingProfiles: []` today,
    read by nothing), but worth knowing before assuming it does something.

## 4. What "done" means for the sprints that follow this review

If picking this project back up: items 1-2 above (live DB connectivity,
migrations) are the highest-leverage next steps - everything else is either
a smaller, scoped follow-up or an accepted, documented trade-off.
