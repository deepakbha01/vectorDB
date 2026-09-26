# Vector Database Assessment & Optimization Platform

Production-grade platform for assessing, designing, provisioning, ingesting,
optimizing, and scaling vector database solutions across 12 platforms:
**Oracle (native vector)**, **PostgreSQL + pgvector**, **Milvus**,
**Pinecone**, **Qdrant**, **Weaviate**, **Chroma**, **Elasticsearch/
OpenSearch**, **Redis**, **MongoDB Atlas**, **LanceDB**, and **Actian**
(Discovery/Design/Deployment/Capacity-Planning only - see the platform
expansion notes below).

Built phase by phase per `Vector_Database_Phase_by_Phase_Claude_Prompt.txt`:
Discovery -> Design -> Implementation -> Operations.

**Documentation**: [User Guide](USER_GUIDE.md) ·
[Deployment Guide](DEPLOYMENT.md) · [Operations Runbook](RUNBOOK.md) ·
[Security](SECURITY.md) · [Troubleshooting](TROUBLESHOOTING.md) ·
[Production Readiness Review](PRODUCTION_READINESS.md)

## Status: Sprint 10 - Production Readiness Review (complete)

All seven phases have a working engine and a live frontend page (since
Sprint 8); every deliverable can now be exported and every action audited.

### Post-Sprint 10: Multi-platform expansion (Pinecone, Qdrant, Weaviate, Chroma, Elasticsearch/OpenSearch, Redis, MongoDB Atlas, LanceDB, Actian)

Extended every phase from 3 platforms to 12:
- **Phase 1 (Discovery)**: scoring and infra estimation generalized onto
  shared categorization constants (`platform.enum.ts`) - SQL-based/bolt-on,
  embedded-library, dedicated-at-scale, Kubernetes-self-hostable, and
  fully-managed-SaaS - so new platforms plug into existing scoring logic
  instead of needing bespoke branches per platform
- **Phase 2/3 (Schema & Index generation)**: JSON-config schema generation
  and platform-native index-tuning artifacts for each new platform - e.g.
  Qdrant HNSW config + scalar quantization, Elasticsearch `int8_hnsw`,
  LanceDB IVF_PQ/IVF_HNSW_SQ - plus a corrected Redis index artifact (RediSearch
  can't alter a live vector field in place, so it's a documented drop/recreate
  substitution snippet, not a fabricated `FT.ALTER`)
- **Phase 4 (Deployment/IaC)**: real Terraform providers for Pinecone
  (`pinecone-io/pinecone`) and MongoDB Atlas (`mongodb/mongodbatlas`);
  Kubernetes manifests for the self-hostable group (Qdrant, Weaviate,
  Elasticsearch via the ECK operator, Redis via the Bitnami chart with the
  `redis-stack-server` image); real per-platform health checks, rollback
  procedures, and deployment checklists; Actian documented as having no
  automated Terraform path
- **Phase 5 (Ingestion adapters)**: real SDK-backed adapters for 8 platforms
  (Pinecone, Qdrant, Weaviate, Chroma, Elasticsearch, Redis, MongoDB Atlas,
  LanceDB), each implementing `healthCheck`/`createSchema`/
  `createVectorIndex`/`upsert`/`search`/`deleteById`/`dropSchema`. **Actian
  is a documented exception**: no maintained Node.js driver exists, so its
  adapter fails clearly with an ODBC/JDBC-bridge pointer rather than
  pretending to connect - Phase 2-4/7 are still fully generated for it
- **Phase 7 (Capacity planning)**: sharding and HA recommendations now
  branch by platform category (K8s-self-hostable sharding advice,
  vendor-managed-scaling advice for fully-managed SaaS, app-level
  partitioning advice for embedded libraries) instead of only knowing about
  Milvus
- New dependencies: `@pinecone-database/pinecone`, `@qdrant/js-client-rest`,
  `weaviate-client`, `chromadb`, `@elastic/elasticsearch`, `redis`,
  `mongodb`, `@lancedb/lancedb`, `apache-arrow`
- Test suite grew to 42 suites / 311 tests, all passing, with unit tests
  against mocked SDK clients for every new adapter plus a live curl-based
  smoke test through the running dev server across Phases 1-4/7 for a real
  project. **Not verified**: actual data read/write round-trips against real
  cloud accounts for the 8 SDK-backed platforms, since no live credentials
  exist in this environment - consistent with this project's existing,
  documented stance on Oracle/Postgres/Milvus connectivity

Sprint 1 delivered the application skeleton (auth, users, projects, dashboard
shell, pluggable database-adapter interfaces, Docker Compose). Sprint 2 added
the Discovery assessment and Architecture Decision Engine. Sprint 3 added
chunking, embedding, schema generation, and the Data Pipeline Design. Sprint 4
added the Index Recommendation Engine and Index Design. Sprint 5 added real
database adapters and the Deployment Plan. Sprint 6 added the ingestion
pipeline. Sprint 7 added runtime search-parameter tuning and the benchmark
harness/Optimization Report. Sprint 8 added the Capacity Forecast Engine and
Capacity Plan. Sprint 9 added reporting/export, the persisted audit trail,
RBAC enforcement, and rate limiting.

Sprint 10 (closing sprint) adds:
- **Production Readiness Review** ([PRODUCTION_READINESS.md](PRODUCTION_READINESS.md))
  - a deliverable-by-deliverable and rule-by-rule check against the source
  prompt's FINAL OUTPUT list and IMPORTANT DEVELOPMENT RULES, plus an honest,
  itemized list of remaining gaps (no live database connectivity verified,
  no generated migrations yet, embeddings are a stand-in without an API key,
  Oracle has no per-query search tuning, 5 npm audit findings deliberately
  deferred, and more - each with the reason and the concrete next step)
- **Migration tooling scaffolded but not yet generated**
  (`backend/src/data-source.ts`, `npm run migration:generate`/`migration:run`) -
  generating a real migration requires diffing against a live database this
  environment doesn't have, so the CLI is wired up and documented rather
  than the SQL being hand-written and unverifiable
- **CI** (`.github/workflows/ci.yml`) - builds and tests both apps on every
  push/PR; `npm audit` runs informationally rather than failing the build,
  since the current findings are already triaged and tracked, not ignored
- **A standalone benchmark CLI script** (`backend/scripts/run-benchmark.ts`,
  `npm run benchmark`) - a thin wrapper around the same in-app benchmark API
  Sprint 7 built, for scripted/CI use, rather than a second implementation
- **Sample dataset** (`sample-datasets/rag-knowledge-base.json`) - 8 ready-to-
  ingest documents for trying Phase 5 end-to-end
- **The rest of the documentation set**: [SECURITY.md](SECURITY.md),
  [DEPLOYMENT.md](DEPLOYMENT.md), [RUNBOOK.md](RUNBOOK.md),
  [USER_GUIDE.md](USER_GUIDE.md), [TROUBLESHOOTING.md](TROUBLESHOOTING.md)
- Caught and fixed a real build-path bug while adding the benchmark script:
  putting it in a top-level `scripts/` folder alongside `src/` shifted
  TypeScript's inferred `rootDir` on a clean build, which would have
  silently produced `dist/src/main.js` instead of `dist/main.js` - breaking
  `node dist/main.js` and the Dockerfile in any environment without a stale
  incremental build cache to mask it. Fixed by excluding `scripts/` from
  `tsconfig.build.json` and verified with a clean (no incremental cache)
  rebuild

Sprint 9 added (Reporting, Auditability, Security):
- **Reporting/export** (`backend/src/reporting`) for every deliverable -
  Architecture Decision Record, Data Pipeline Design, Indexing Strategy
  Guide, Deployment Plan, Optimization Report, Capacity Plan, and a Complete
  Assessment Report combining whichever phases are done. Every deliverable is
  first converted into one format-agnostic intermediate representation
  (`report-document.types.ts`), then rendered by a single PDF renderer
  (`pdfkit`) and a single DOCX renderer (`docx`) - so no report type needed
  its own layout code, and there is exactly one place to fix a rendering bug
  for all of them. `GET /projects/:id/reports/:type?format=pdf|docx`
- **Persisted, queryable audit trail** (`backend/src/audit`) - every mutating
  request (method, path, user, redacted request/response bodies, status,
  duration) is captured centrally by a global `AuditLoggingInterceptor`
  rather than via bespoke calls sprinkled through each service, so no
  mutating endpoint can be added later without being audited by construction.
  Sensitive fields (password, token, secret, etc.) are redacted recursively
  before storage, including inside nested objects/arrays - a real bug where
  the redaction list's casing didn't match its own lookup (so multi-word keys
  like `accessToken` silently passed through unredacted) was caught by its
  own test and fixed before shipping
- **RBAC actually enforced**: the `RolesGuard`/`@Roles()` infrastructure
  existed since Sprint 1 but nothing had ever used it - every mutating
  endpoint across every phase now requires ADMIN or ARCHITECT (VIEWER is
  strictly read-only), and the one endpoint that touches real infrastructure
  (`deployment/execute`) requires ADMIN specifically
- **Rate limiting** (`@nestjs/throttler`) - a configurable app-wide limit
  plus a much tighter, fixed limit on `/auth/login` and `/auth/register`
  specifically, since those are the classic brute-force/enumeration target
- **Security pass**: removed an unused `uuid` dependency (dead weight and a
  reported vulnerability, eliminated by deletion rather than a version bump);
  applied every non-breaking `npm audit fix`; the remaining findings all
  require major-version upgrades to the NestJS/Swagger toolchain and are
  deliberately deferred rather than force-upgraded blind (no way to verify a
  running app end-to-end in this environment) - tracked in the Sprint 10
  production-readiness review instead; added boot-time validation that
  refuses to start in production without a real `JWT_SECRET`; added standard
  security headers (`X-Content-Type-Options`, `X-Frame-Options`,
  `Referrer-Policy`, `Permissions-Policy`) to the frontend's nginx config
- Frontend: a "Project tools" section under the phase list (visible from
  every phase page) links to a Reports page (PDF/DOCX buttons per
  deliverable) and an Audit Log page (chronological, expandable, redacted)

Sprint 8 adds (Phase 7 - Operations: Scaling & Sharding):
- **Capacity Forecast Engine** (`backend/src/capacity-planning`) - projects
  vector count and QPS forward 6/12/24 months (configurable horizons) by
  compounding the Discovery assessment's monthly growth rate, then
  re-estimates memory (reusing Phase 3's `estimateMemoryGb` directly, not a
  duplicate formula), storage, and CPU at each horizon against
  `config/thresholds.yaml`'s scaling-trigger percentages
- **Platform-specific sharding recommendations**: Milvus gets projected
  query/data node counts against the Phase 4 Helm baseline, partitioning
  advice, and an HPA trigger tied to the same CPU threshold used elsewhere;
  Oracle/PostgreSQL get a vertical-scaling-first cascade (read replicas once
  QPS growth crosses a threshold, then table partitioning once vector count
  does, then connection pooling advice - DRCP for Oracle, PgBouncer for
  Postgres)
- **HA and DR recommendations** reuse the Discovery assessment's own
  availability/RPO/RTO targets (no re-asking) - HA recommends Data Guard /
  Multi-AZ / multi-replica depending on platform and whether the target
  clears the same high-availability threshold Phase 1 uses; DR ties backup
  cadence directly to the RPO figure and flags when the RTO target implies a
  warm standby rather than a cold restore
- **Capacity Plan** (`backend/src/capacity-planning/capacity-plan.entity.ts`),
  the Phase 7 deliverable: versioned, persisted, containing the current
  resource snapshot, the full forecast timeline with per-horizon scaling
  triggers, the sharding/HA/DR recommendations, and a final infrastructure
  recommendation sized to the longest horizon
- Frontend: Phase 7 nav item generates a plan and shows the capacity
  timeline table (with triggers highlighted), sharding/HA/DR panels, and the
  final infrastructure recommendation

Sprint 7 adds (Phase 6 - Operations: Latency & Recall Tuning):
- **Runtime search-parameter tuning** added to the adapter interface
  (`VectorSearchQuery.searchParams`) - Postgres applies `efSearch`/`nprobe` as
  `SET LOCAL hnsw.ef_search`/`ivfflat.probes` inside the query's transaction,
  Milvus passes them through as native `ef`/`nprobe` search params. Oracle
  intentionally does not apply them: rather than guess at undocumented SQL,
  its adapter runs with whatever accuracy was set at index-creation time
  until a real per-query mechanism is confirmed
- **Benchmark harness** (`backend/src/benchmark`) - Phase 6's "create
  benchmark capability" requirement: generates a synthetic, deterministic
  corpus at the project's real embedding dimension, provisions it into an
  *ephemeral* collection using the exact Phase 3 index decision and tuned
  build-time parameters, computes brute-force ground truth locally, queries
  the real adapter across several search-parameter variants (defaults from
  `config/thresholds.yaml`, always including the Phase 3 baseline value for a
  fair before/after comparison), and always cleans up the ephemeral
  collection afterward (`dropSchema(..., true)` in a `finally` block) even if
  a query fails mid-run. Pure recall/latency/percentile math lives in
  `benchmark-math.ts`, independently unit-tested
- **Optimization Report** (`backend/src/benchmark/optimization-report.entity.ts`),
  the Phase 6 deliverable: versioned, persisted, containing the baseline
  configuration, every variant's P50/P95/P99 latency + recall@K + achieved
  (single-connection) QPS, rule-based bottleneck detection against the
  project's own latency/recall targets (carried over from Phase 3's stored
  inputs - no need to re-ask), a recommended configuration (highest recall
  among variants meeting both targets, falling back to best-latency), a
  before/after comparison, and capacity/cost impact (memory reused from the
  Phase 3 estimator, cost as an explicitly directional estimate)
- Frontend: Phase 6 nav item runs a benchmark and shows the recommended
  configuration, a Latency vs Recall vs Memory vs Cost comparison table, and
  bottlenecks/before-after panels

Sprint 6 added (Phase 5 - Implementation: Ingestion Pipeline):
- **Embedding client** (`backend/src/embedding-client`) that calls the real
  OpenAI embeddings API when `OPENAI_API_KEY` is set, and otherwise (or on
  failure) falls back to a deterministic, dependency-free offline stand-in
  (a SHA-256-seeded unit vector) - clearly documented as carrying no semantic
  meaning, but letting the full pipeline run end-to-end without network
  access or paid API calls. Only OpenAI has a live client today; adding
  another provider is an isolated change
- **Ingestion pipeline** (`backend/src/ingestion`) implementing every stage
  the spec requires - Source -> Extract -> Clean -> Chunk -> Embed -> Validate
  -> Batch -> Insert -> Index - using the Phase 2 chunking/embedding config
  and the Sprint 5 adapters:
  - **Idempotency**: record IDs are deterministic (`documentId::chunkIndex`),
    so re-running ingestion for the same source overwrites rather than
    duplicates, via each adapter's native upsert
  - **Deduplication**: a persisted content-hash table skips re-embedding and
    re-storing identical chunk text, even across separate runs
  - **Validation**: rejects empty/corrupted documents and embeddings with the
    wrong dimension or non-finite values before they ever reach storage
  - **Retry/backoff, bounded concurrency, and rate limiting** (all
    configurable, defaulting from `config/thresholds.yaml`) via small
    dependency-free utilities (`common/retry.ts`, `common/concurrency-limiter.ts`)
  - **Dead-letter queue + failure recovery**: every unrecoverable failure
    (embedding or storage) is persisted with enough context to retry later;
    a separate `retry-dead-letters` endpoint re-embeds and re-stores them,
    restoring original metadata
  - Fixed a real bug caught while writing this: storage-failure dead letters
    originally captured `metadata` but not the source `text`, while the retry
    path only reprocessed dead letters that had `text` - so the most
    recoverable failure category could never actually be retried. Fixed
    before shipping
- Frontend: Phase 5 nav item accepts a JSON array of documents, runs
  ingestion, and shows per-run metrics plus a dead-letter viewer with retry

Sprint 5 adds (Phase 4 - Implementation: Provisioning & Deployment):
- **Real database adapters** (`backend/src/database-adapters`) replacing the
  Sprint 1 stubs - PostgreSQL (`pg`), Oracle (`oracledb`, Thin mode - no
  Instant Client install required), and Milvus (`@zilliz/milvus2-sdk-node`).
  Connection details come only from `TARGET_*` environment variables (entirely
  separate from this app's own `APP_DB_*` metadata store) and are read lazily,
  so the app runs fine with none configured. `upsert`/`search` map dynamically
  onto whichever per-field metadata columns Phase 2 generated, rather than
  assuming a fixed shape - full batching/retry is Sprint 6's job
  - Every adapter's `dropSchema` refuses unless called with `confirm: true`,
    concretely implementing "never perform destructive infrastructure/database
    operations without explicit confirmation"
  - Caught and fixed a real interface gap while implementing this: the
    original `upsert`/`search`/`deleteById` signatures never took a
    table/collection name, so one adapter instance couldn't route to more
    than one project's data. Fixed before any real caller existed
  - Caught and fixed a second gap: nothing let Phase 3's tuned index
    parameters actually reach a database. Added `createVectorIndex` to the
    adapter interface, backed by a new `SchemaGeneratorService.
    generateIndexArtifact()` that turns the Index Design's decision +
    parameters into real DDL (Postgres `CREATE INDEX ... USING hnsw/ivfflat`,
    Oracle `CREATE VECTOR INDEX ... ORGANIZATION ...`) or a Milvus
    `createIndex` config - including an honest limitation note that pgvector
    has no native Product Quantization and falls back to ivfflat
  - All three adapters are unit-tested against mocked SDK clients (26 tests) -
    connectivity against a real Oracle/Postgres/Milvus instance has not been
    exercised in this environment
- **Deployment Plan** (`backend/src/deployment`), the Phase 4 deliverable: a
  versioned, persisted plan combining the Phase 2 table DDL with the Phase 3
  index DDL into one SQL script, Terraform (Oracle Autonomous DB / RDS
  Postgres / a GKE cluster for Milvus - clearly labeled starting points, not
  ready to `apply` as-is), Kubernetes namespace/secret YAML + Helm values for
  the official `milvus/milvus` chart (Milvus only), a deployment checklist,
  a platform-specific health check, and a rollback procedure that always
  warns against destructive steps without confirmation. Refuses to generate
  before Phase 2 and Phase 3 are both complete
  - A separate, explicit `POST .../deployment/execute` action actually
    connects to the configured target and calls `healthCheck` +
    `createSchema` + `createVectorIndex` for real - it never calls
    `dropSchema`, and generating a plan never executes anything by itself
- Frontend: Phase 4 nav item shows the generated SQL/Terraform/Kubernetes
  artifacts, checklist, health check, and rollback procedure, with a
  checkbox-gated "Execute Deployment" action

Sprint 4 added (Phase 3 - Design: Index Selection):
- **Index Recommendation Engine** (`backend/src/index-recommendation-engine`)
  scoring HNSW, IVF-Flat, and PQ on five weighted criteria - recall
  achievability, latency achievability, memory footprint, throughput at the
  target QPS, and update-frequency friendliness - entirely from
  `config/indexes.yaml` (parameter bounds/defaults, memory/compression
  factors, update-friendliness tables) and the shared `thresholds.yaml`.
  Computes tuned parameters per winner (HNSW: M/efConstruction/efSearch;
  IVF-Flat: nlist/nprobe; PQ: m/nbits/nlist/nprobe, with `m` chosen to evenly
  divide the embedding dimension) plus recall/latency/memory impact notes,
  scaling considerations, and alternatives with comparative reasoning (shared
  with the Phase 1 engine via `common/scoring-utils.ts`)
  - Caught and fixed a real scoring bug during testing: the memory-fit
    criterion flatlined to a score of 0 for any option exceeding available
    memory, so two infeasible options tied and the highest-recall one (HNSW)
    could still win even when it needed 12x the available RAM. Fixed by
    letting the score keep falling out to 3x available memory instead of
    clamping at the boundary
- **Index Design** (`backend/src/index-design`), the Phase 3 deliverable: a
  versioned, persisted Indexing Strategy Guide. Vector count, dimension, QPS,
  recall target, latency target, and available memory default from the
  project's latest Discovery assessment (dimension prefers the Phase 2 Data
  Pipeline Design's resolved embedding dimension when present) - only "update
  frequency" needs to be entered fresh, with optional overrides for a
  what-if comparison. Refuses to run before Phase 1 Discovery is complete
- Frontend: Phase 3 nav item links to a design page showing the recommendation,
  tuned configuration, recall/latency/memory impact, a scored-options
  comparison table, alternatives, and scaling considerations, with collapsible
  advanced overrides

Sprint 3 added (Phase 2 - Design: Data & Embedding Strategy):
- **Chunking engine** (`backend/src/chunking`) implementing all seven required
  strategies - fixed-size, token-based, sentence-based, paragraph-based,
  recursive, semantic (heuristic, sentence-boundary based until Phase 5 wires
  in a live embedding provider for true similarity-based boundaries), and
  sliding-window - each with configurable chunk size/overlap/min/max, plus a
  stateless `/chunking/preview` endpoint used by the frontend
- **Embedding provider abstraction** (`backend/src/embeddings`) backed entirely
  by `config/embeddings.yaml` (OpenAI, Cohere, Google, and open-source models
  with real dimension/max-input/cost/language/quality metadata) with dimension
  validation
- **Schema generator** (`backend/src/schema-generator`) producing real DDL for
  Oracle (native `VECTOR` type) and PostgreSQL+pgvector, and a Milvus
  collection-schema descriptor, from one shared input - identifiers are
  sanitized since this DDL is executed for real in Phase 4/Sprint 5. Reused
  as-is by that future provisioning step
- **Data Pipeline Design** (`backend/src/data-pipeline`), the Phase 2
  deliverable: a versioned, persisted record tying together the chosen
  chunking config + embedding model + metadata schema + generated DDL for all
  three platforms + the Source->Extract->Clean->Chunk->Embed->Validate->
  Store->Index stage plan with configurable retry/dead-letter/monitoring
  defaults, plus validation warnings (e.g. embedding dimension mismatch vs.
  the Discovery assessment, chunk size vs. model max input tokens)
- Frontend: Phase 2 nav item now links to a full design page - chunking
  strategy picker with a live preview against sample text, cascading
  provider/model selection, a metadata-field editor, and the generated
  Oracle/PostgreSQL/Milvus schemas plus pipeline stage plan

Sprint 2 added:
- Phase 1 **Discovery assessment** intake covering every field in the source
  prompt's "Collect" list (scale, performance/SLAs, search capabilities,
  existing platforms, security/compliance) - `backend/src/discovery`
- A real, configurable **Architecture Decision Engine**
  (`backend/src/recommendation-engine`) that scores Oracle / PostgreSQL+pgvector
  / Milvus against weighted criteria (vector volume, QPS, latency, recall,
  existing-platform fit, operational complexity, cost) using only
  `backend/config/thresholds.yaml` + `databases.yaml` - no hard-coded cutoffs
- A persisted, versioned **Architecture Decision Record** per assessment
  (decision, rationale, scored options with evidence, rejected alternatives,
  assumptions, risks, infrastructure estimate, rules version) for full
  reproducibility/auditability
- Submitting an assessment automatically applies the recommendation to the
  project (manual override via the Phase 1 nav's "Platform" page still works
  and is tracked separately in the audit trail)
- Dashboard now surfaces real vector count, dataset size, target QPS/latency/
  recall, and risks pulled from the latest ADR (previously all placeholders)
- Frontend Discovery page: full assessment form + ADR visualization (decision,
  scored-options table, infra estimate, risks/assumptions/rejected alternatives)

All 10 sprints of the source prompt's Development Roadmap are now complete.
See [PRODUCTION_READINESS.md](PRODUCTION_READINESS.md) for what "complete"
does and doesn't mean - it documents real, specific gaps rather than
claiming a demonstration project is production-ready without qualification.

## AI Factory: Token Observability

Behind `AI_FACTORY_ENABLED` and `TOKEN_OBSERVABILITY_ENABLED`, a Token
Observability phase (guided step 7, after Inference) estimates, measures and
alerts on token consumption across GenAI, RAG and agent workloads -
Estimated from the design, Simulated from load tests, Live from usage events
or OpenTelemetry - and feeds Cost & FinOps and the final readiness gate. See
[TOKEN_OBSERVABILITY.md](TOKEN_OBSERVABILITY.md) for the API, configuration,
security and retention.

## Architecture

```
Web Frontend -> API Gateway (Nest) -> Assessment Engine -> Design Engine
             -> Operations Engine -> Recommendation Engine
             -> Oracle / PostgreSQL+pgvector / Milvus / Pinecone / Qdrant /
                Weaviate / Chroma / Elasticsearch / Redis / MongoDB Atlas /
                LanceDB / Actian (pluggable adapters)
```

## Local development

### Backend
```
cd backend
cp .env.example .env   # then edit JWT_SECRET, DB credentials
npm install
npm run start:dev
```
API: http://localhost:3000/api - Swagger docs: http://localhost:3000/api/docs

Requires a Postgres instance for application metadata (users/projects) -
this is the app's own database, not one of the target vector databases.
Run one quickly with:
```
docker run -d --name vector-platform-db -e POSTGRES_USER=vector_platform \
  -e POSTGRES_PASSWORD=change-me -e POSTGRES_DB=vector_platform \
  -p 5432:5432 postgres:16-alpine
```

### Frontend
```
cd frontend
npm install
npm run dev
```
App: http://localhost:5173 (proxies `/api` to the backend on port 3000)

### Everything via Docker Compose
```
docker compose up --build
```

## Tests
```
cd backend && npm test        # unit tests
cd backend && npm run test:e2e
```

## Configuration-driven design

Nothing in the recommendation/design/index/operations engines hard-codes
thresholds, embedding models, index parameters, or infrastructure sizes.
All of it is loaded at runtime from:
```
backend/config/
  databases.yaml       # supported target platforms + capabilities
  embeddings.yaml       # embedding provider/model catalog (dimension, cost, max input, quality)
  indexes.yaml          # index catalog + tuning defaults/bounds (HNSW, IVF-Flat, PQ)
  thresholds.yaml       # scoring weights, decision thresholds, and pipeline defaults
  infrastructure.yaml   # reserved for infrastructure sizing profiles - not yet consumed by any engine (all sizing today lives in thresholds.yaml's infrastructureEstimation section)
```
