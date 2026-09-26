# Token Observability

A first-class AI Factory phase (guided step 7, directly after Inference) that
answers: how many tokens this AI solution consumes, where, driven by which
service, model and workflow, how that changes over time, what it costs, and
how it affects cost, performance and the final architecture decision.

It is **off by default**. It needs the AI Factory too:

```
AI_FACTORY_ENABLED=true
TOKEN_OBSERVABILITY_ENABLED=true
```

With either flag off, every Token Observability endpoint answers 404 and the
existing phases behave exactly as before.

## Three modes - never mixed

| Mode | Where the numbers come from | What it is for |
|---|---|---|
| **Estimated** | Projected from Inference, Model Selection, RAG / Agent design and Data & Embeddings, priced from the versioned price table | Pre-production: tokens per request, per month, cost, share of budget |
| **Simulated** | Load-test or benchmark results uploaded as JSON / CSV | Validating the estimate before go-live |
| **Live** | Usage events or OpenTelemetry traces from the running application | Production usage, trends, alerts |

An empty mode says so; it never shows estimated figures as observed ones.

## Estimation inputs and provenance

Every input to the estimate is listed in the **Estimation inputs** table
(architect view) with where its value came from:

| Label | Meaning |
|---|---|
| **User Override** | Set on this page; saved with the estimate and reused by the next one. A later pattern never replaces it. |
| **Calculated** | From another phase (Inference, RAG / Agent design, Discovery) or a documented platform default |
| **Pattern Default** | From the project's AI Factory pattern (`tokenObservabilityProfile` in `config/patterns.yaml`) |
| **Not configured** | Nothing supplies it - shown as a gap, never guessed |

Precedence is override > calculated > pattern default > not configured.

- **Volume.** Requests per day come from an override, the Inference
  assessment, or QPS × 86,400 × **utilization**. Utilization is never assumed
  to be 100%, so a QPS on its own gives no volume. Month = day ×
  operating days per month (default 30.4, `estimation.operatingDaysPerMonth`).
- **LLM usage.** *Required* (every request), *Optional* (only a share of
  requests call the LLM) or *No LLM / vector-only* (for example the
  Recommendation Engine). Search QPS is not LLM QPS, so an optional-LLM pattern
  projects no LLM tokens until you set the share.
- **Other settings.** LLM calls per request (chains), agent steps, retry
  rate (adds to input and output), provider cache hit rate (changes cost, not
  token counts), and overrides for prompt parts, retrieved context, embedding
  and reranking tokens.
- The result adds **tokens per day** and **LLM requests per month**, and the
  CSV export includes the inputs table.

The 12 patterns carry only what they can honestly say: workload type, LLM
usage, the LLM share and calls per request where the pattern implies them,
and token guidance. Token sizes, utilization, retry and cache rates are
deliberately not set by any pattern.

## Using it

See `USER_GUIDE.md` §11 (and [AI_FACTORY.md](AI_FACTORY.md) for the rest of the AI Factory). In short:

1. **Estimated** tab - review the projection, *Save estimate* (creates a
   version; later upstream changes mark it out of date).
2. **Simulated** tab - *Upload / manage*, pick a CSV or JSON file (templates
   on the panel). Each upload is a run you can view or delete.
3. **Live telemetry** tab - *Manage keys / how to connect*, create an ingest
   key, point your application or an OpenTelemetry Collector at it.
4. Dashboard (Simulated / Live): filters, the eight summary cards, trends,
   consumption by service and model, token efficiency, RAG and agent
   breakdowns, requests (drill down to the trace), CSV export, alerts.

## API

All paths are under `/api`. Project routes need a user JWT; ingest routes
need a project ingest key instead.

### Project-scoped (`/projects/:projectId/token-observability/...`)

| Method & path | Who | What |
|---|---|---|
| `GET estimate/preview` | any member | The estimate as the upstream records stand now (saves nothing) |
| `POST estimate/preview` | any member | What-if: body `{ overrides }`; saves nothing |
| `POST estimate` | admin, architect | Save a new estimate version. Optional body `{ overrides }`; omitted = reuse the overrides saved with the latest estimate, `{}` = clear them |
| `GET estimate/latest` | any member | Latest saved estimate |
| `GET prices` / `POST prices` | member / admin, architect | Price table; add a contracted price for this project |
| `POST usage-events` | admin, architect | A batch (≤ 1000) of normalized usage events |
| `GET summary`, `tokens`, `trends`, `services`, `models`, `agents`, `rag`, `cost` | any member | Observed usage, with the shared filters below |
| `GET requests` | any member | Drill-down: requests behind any aggregate (`sort=recent|tokens|cost`, paged) - audited |
| `GET traces/:traceId` | any member | One request as an agent → LLM → tool tree, with the loop indicator - audited |
| `GET dimensions` | any member | Values each filter can take |
| `POST simulations` (multipart `file`, `label`) | admin, architect | Upload a load-test / benchmark result |
| `GET simulations`, `GET simulations/:runId`, `DELETE simulations/:runId` | member / admin, architect | Runs; delete removes only that run's events |
| `POST ingest-keys`, `GET ingest-keys`, `DELETE ingest-keys/:keyId` | admin, architect | Ingest keys (the key is returned once, at creation) |
| `GET alerts?status=open|all`, `POST alerts/evaluate`, `POST alerts/:alertId/acknowledge` | member / admin, architect | Token alerts |

Shared filters (query string): `from`, `to` (ISO 8601, default the last 30
days), `mode` (`live` default, or `simulated`), `environment`, `application`,
`service`, `workflow`, `provider`, `model`, `tenant`, `bucket` (`hour|day`).

The spec lists these routes under `/api/observability/*`. Reads here are
scoped to a project like every other AI Factory endpoint; only machine
ingest is global, because the ingest key identifies the project.

### Machine ingest (ingest key: `Authorization: Bearer aftk_...` or `X-Ingest-Key`)

| Method & path | What |
|---|---|
| `POST /observability/usage-events` | `{ "events": [ ... ] }`, ≤ 1000 normalized events, stored as **live** |
| `POST /observability/v1/traces` | OTLP/HTTP **JSON** traces (gzip accepted). GenAI spans become usage events, other spans are skipped. Replies in the OTLP partial-success shape. Protobuf is refused (415). |

### The usage event (spec §10)

Required: `eventId`, `timestamp`, `provider`, `model`, `operationType`.
Optional: `requestId`, `traceId`, `spanId`, `parentSpanId`, `tenantId`,
`applicationId`, `serviceId`, `workflowId`, `agentId`, `sessionId`,
`modelVersion`, `ragStage` (`query_embedding|retrieval|rerank|generation`),
`toolName`, `environment`, `region`, `inputTokens`, `outputTokens`,
`reasoningTokens`, `cachedInputTokens`, `totalTokens`, `embeddingTokens`,
`rerankingTokens`, `contextTokens`, `retrievalCount`, `toolCallCount`,
`llmCallCount`, `latencyMs`, `ttftMs`, `requestStatus` (`success|error`),
`errorType`. Uploads may also use the spec's snake_case names
(`input_tokens`).

Conventions (as OpenTelemetry reports them): `inputTokens` includes cached
input and `outputTokens` includes reasoning; they are priced separately and
never twice. `embeddings` / `rerank` calls' tokens are counted as embedding /
reranking, not LLM input. `(project, eventId)` is unique - re-sent events
are ignored. Cost is **computed by the server** at the price in force at the
event's timestamp; cost fields sent by a client are ignored.

## Pricing

Prices live in the versioned table `ai_model_prices` and are never
hard-coded. At start-up the table is synced from the existing catalogues -
`inference.yaml` `managedApiTiers` and `embeddings.yaml` - plus any extra
rows in `config/token-observability.yaml` `pricing.prices`. A changed
figure closes the old row and opens a new one; usage already recorded keeps
the cost it was given. Projects can add contracted prices (`POST prices`).
A usage event with no price in force is stored with an empty cost and
flagged "unpriced" - it is never guessed.

## Live telemetry with OpenTelemetry

```
AI_FACTORY_INGEST_KEY=aftk_... docker compose --profile telemetry up
```

starts `otel/opentelemetry-collector-contrib` with `otel/collector.yaml`:
OTLP in on `:4317` (gRPC) and `:4318` (HTTP); only spans with
`gen_ai.operation.name` are kept; prompt / completion attributes
(`gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.prompt`, ...)
are deleted before anything leaves; the rest is sent as OTLP JSON to
`AI_FACTORY_OTLP_ENDPOINT` (default
`http://backend:3000/api/observability/v1/traces`).

Which span / resource attributes map to which usage field is configured in
`config/token-observability.yaml` → `otel` (first attribute present wins, so
older and newer GenAI semantic-convention names both work). Custom
attributes `ai_factory.application_id`, `ai_factory.workflow_id`,
`ai_factory.tenant_id`, `ai_factory.rag_stage`, `ai_factory.context_tokens`
... fill fields the GenAI conventions do not cover. A span whose values fail
validation (e.g. free text in an identifier) is rejected and reported in the
OTLP partial-success message.

## Alerts (spec §14)

Evaluated on **live** usage every `alerts.evaluateEveryMinutes` (default 15)
and on *Evaluate now*. Rules and thresholds: `config/token-observability.yaml`
→ `alerts`.

| Rule | Fires when |
|---|---|
| budget | month-to-date or projected spend reaches 80% (warning) / 100% (critical) of the recorded monthly budget |
| spike | tokens in the last hour ≥ 3× the average hour of the previous 7 days (critical at 6×) |
| tokensPerRequest | tokens per request over the last day ≥ 1.5× the saved estimate |
| unexpectedModel | a provider / model used in the last day was not used in the previous 30 days, is not in the estimate and is not in `allowed` |
| agentLoops | agent tasks made more LLM calls than the design's step limit |
| ragContextGrowth | retrieved-context tokens per request ≥ 1.5× the previous 7 days |
| costIncrease | the last day's cost ≥ 1.5× the average day |

A rule without the data it needs (no budget, no estimate, too little history)
stays silent and says why. An alert stays open while its rule fires and
resolves itself when it stops; acknowledging records who is on it.

## Connections to other phases

- **Change tracking**: the phase depends on Discovery, Data & Embeddings,
  Model Selection, Inference and RAG / Agent (and, advisory, the Workload
  Profile). A change to any of them marks the estimate out of date; QPS,
  top-K, chunk size, model, agent and budget changes all reach it.
- **Final Recommendation** (when enabled): the cost gate stage also weighs
  the token estimate against the budget, whether usage was measured, live
  cost against the estimate and open token alerts; the ADR records token
  consumption. A new estimate marks the recommendation out of date.
- **Cost & FinOps page**: a read-only "Token cost - estimated vs actual"
  panel. The FinOps assessment itself is unchanged.
- **Central state** (spec §16): the `tokenObservability` section.

## Security and privacy (spec §18)

- **No prompt or response text is stored.** Unknown fields (e.g. `prompt`,
  `completion`) are refused, every dimension must be an identifier (no
  spaces), the OTLP mapper never reads content attributes and the collector
  deletes them.
- **RBAC**: writes (estimates, prices, ingest, uploads, keys, alert actions)
  need admin or architect; reads need project access. Machine ingest uses
  per-project keys stored only as SHA-256 hashes; a key can only write live
  usage to its own project and can be revoked at once.
- **Tenants**: tenant ids are shown to, and filterable by, admins and
  architects only (`TOKEN_TENANT_VISIBILITY=all` opens them to viewers).
  Traces return only the fields the view needs - no tenant or session ids.
- **Audit**: every write is in the audit log; so are request-level reads
  (`requests`, `traces/...`) and any tenant-filtered read, with the row
  count but never the rows.
- **Encryption**: terminate TLS in front of the API (`DEPLOYMENT.md` §6) and
  between collector and API in production (`AI_FACTORY_OTLP_ENDPOINT` with
  `https://`). Keep usage tables on encrypted storage (managed Postgres
  encryption at rest, or disk encryption). Treat telemetry metadata as
  potentially sensitive.
- **Retention**: see below.

## Retention

A daily job (one instance at a time, batched deletes) removes:

| Data | Setting | Default |
|---|---|---|
| Usage events (request-level detail, traces) | `TOKEN_USAGE_RETENTION_DAYS` | 395 days |
| Hourly totals (trends, summaries) | `TOKEN_ROLLUP_RETENTION_DAYS` | 1095 days (never less than events) |
| Resolved alerts | `TOKEN_ALERT_RETENTION_DAYS` | 180 days |

Simulation runs whose events have all expired are removed too. Open alerts
are never removed. `TOKEN_RETENTION_ENABLED=false` switches the job off.

## Configuration reference

Environment (`backend/.env`):

| Variable | Default | Purpose |
|---|---|---|
| `TOKEN_OBSERVABILITY_ENABLED` | `false` | Feature flag (needs `AI_FACTORY_ENABLED`) |
| `TOKEN_OBSERVABILITY_CONFIG_PATH` | `./config/token-observability.yaml` | Pricing treatment, estimation, OTel mapping, alerts |
| `TOKEN_INGEST_MAX_BODY` | `5mb` | Body limit for usage-ingest routes only (others keep 100 KB) |
| `TOKEN_INGEST_RATE_LIMIT_PER_MIN` | `600` | Requests per minute per client for machine ingest |
| `TOKEN_ALERTS_ENABLED` | `true` | Scheduled alert evaluation |
| `TOKEN_TENANT_VISIBILITY` | `privileged` | `all` lets viewers see tenant ids |
| `TOKEN_RETENTION_ENABLED` | `true` | Daily retention clean-up |
| `TOKEN_USAGE_RETENTION_DAYS` / `TOKEN_ROLLUP_RETENTION_DAYS` / `TOKEN_ALERT_RETENTION_DAYS` | 395 / 1095 / 180 | Retention |

Collector (`docker compose --profile telemetry`): `AI_FACTORY_INGEST_KEY`,
`AI_FACTORY_OTLP_ENDPOINT`.

## Database

Tables: `ai_token_estimates`, `ai_model_prices`, `ai_usage_events`,
`ai_usage_rollups`, `ai_simulation_runs`, `ai_ingest_keys`,
`ai_token_alerts`. Migrations (additive only; each is safe on a database
created by `synchronize`):

```
1790353304271-AiTokenEstimates
1790353685329-AiTokenUsageAndPrices
1790359832028-AiSimulationRuns
1790360876558-AiIngestKeys
1790361955476-AiTokenAlerts
1790384458955-TokenReviewFixes      # failed-upload status; one open alert per problem
```

Apply with `cd backend && npm run migration:run`.

## Tests

- Unit: `npm test` (pricing, estimate engine, ingest, OTLP mapping, alert
  rules, scheduler, uploads, privacy).
- Postgres integration: `npm run test:e2e -- token-usage` (throwaway schema
  built from the migrations; needs `APP_DB_*`).
- Real HTTP ingest (body limits, keys, OTLP): `npm run test:e2e -- observability-ingest`.
