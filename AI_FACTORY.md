# AI Factory

The AI Factory turns the platform's vector-database assessment into a guided,
end-to-end **AI architecture assessment**: from use case and scale, through
data, model, inference, infrastructure, RAG / agent design, security,
performance, cost and operations, to a final architecture recommendation with
a production-readiness gate and an Architecture Decision Record.

It is built in waves on top of the existing VectorDB workflow and **never
changes how the existing phases compute** - it reads their deliverables and
adds its own phases alongside. This document covers Waves 1-11; Token
Observability (Wave 12, guided step 7) has its own reference:
[TOKEN_OBSERVABILITY.md](TOKEN_OBSERVABILITY.md).

## Enabling it

```
AI_FACTORY_ENABLED=true        # backend/.env
```

Off by default. With it off, every AI Factory endpoint answers 404, the
sidebar shows only the existing VectorDB phases and no extra requests are
made. Nothing about the existing workflow depends on the flag.

## Principles

- **Technology-neutral.** Catalogues describe capabilities, not vendors'
  marketing; proprietary models are API *tiers* (small / mid / frontier),
  never named products. No option is preferred in code.
- **Eligibility first, then scoring.** Every choice is made in the spec §3
  order: mandatory requirements decide what is *not eligible* (whatever its
  score), conditions make an option *conditional*, and only then are eligible
  options scored with stated weights and priority multipliers. Ties are
  reported, with the tie-break stated.
- **Every figure says what it is.** Evidence is labelled *estimated*,
  *vendor-listed*, *measured* or *assumption*. Costs are directional, never
  quotes. Performance can only pass on measured evidence.
- **Nothing is filled in.** A missing or out-of-date phase is shown as
  missing or out of date - it never inherits a default that looks like a
  decision.
- **Additive and safe.** Each wave adds its own table, config file and page.
  53 golden-master snapshots (Wave 0) freeze the existing engines' outputs;
  none has changed since.
- **Configuration-driven.** Rules, weights, catalogues and assumptions live
  in `backend/config/*.yaml`, not in code.

## The guided workflow

The **AI Factory (guided)** page lists the steps below with their status
(current, out of date, needs review, in progress, not started), the phases
behind each, and each phase's decision record and state. Every phase also has
its own page in the sidebar's *Inference track*.

| Step | Title | Phase(s) | Page | Wave |
|---|---|---|---|---|
| 01 | Use Case | AI Workload Profile | `workload-profile` | 2 |
| 02 | Scale | AI Workload Profile, Discovery | `workload-profile`, `discovery` | 2 |
| 03 | Data & Embedding | Data & Embedding design | `data-pipeline` | existing + 3 |
| 04 | VectorDB & Index | Index design, Vector DB selection | `index-design`, `vector-db-selection` | existing |
| 05 | Model | Model Selection | `model-selection` | 3 |
| 06 | Inference | Inference assessment, Inference Architecture | `inference`, `inference-architecture` | existing + 4 |
| 07 | Token Observability | Token observability | `token-observability` | 12 |
| 08 | Infrastructure | Infrastructure Design, Deployment plan | `infrastructure-design`, `deployment` | 5 |
| 09 | RAG / Agent | RAG / agent architecture | `rag-agent` | 6 |
| 10 | Security | Security & Governance | `security-governance` | 7 |
| 11 | Performance | Performance & Benchmark, Optimization | `performance`, `optimization` | 8 |
| 12 | Cost | Cost & FinOps | `finops` | 9 |
| 13 | Operations | Operations Model, Capacity plan | `operations-model`, `capacity` | 10 |
| 14 | Final Recommendation | Final recommendation | `final-recommendation` | 11 |

Pages are at `/projects/:id/<page>`. With Token Observability switched off
its step is left out and the steps are numbered 01-13.

## Foundations (Wave 1)

### Phase graph and lineage

`config/ai-factory.yaml` → `phases` lists every deliverable and the upstream
deliverables its service actually reads (verified against the code):

- **hard** - the phase is computed from that upstream;
- **advisory** - the upstream only pre-fills suggestions the user can override.

Lineage is inferred from when each deliverable version was saved (every phase
builds from the latest upstream), so existing services needed no hooks. Each
phase is:

| Status | Meaning |
|---|---|
| current | built from the latest version of everything it depends on |
| out of date (stale) | a hard upstream changed, or is itself stale, since it was built - re-run it |
| needs review | only an advisory upstream changed - suggestions may be out of date |
| not started | no deliverable yet |

Staleness propagates down hard edges only. The sidebar shows *out of date* /
*review* badges.

### Discovery impact analysis (spec §22)

`parameterImpact` maps every Discovery answer to the phases that read it
directly (a test enforces that every Discovery field is mapped; `none` marks
answers reviewed and found to drive no decision). Comparing two Discovery
versions shows which answers changed, which phases must be **re-run**
(direct readers and everything built on them through hard edges), which only
need **review**, and which are unaffected - with the reason for each.

### Standard decision record (spec §3, §16, §17, §24)

Every technology choice is presented the same way, built by adapters from
each phase's deliverable: status (decided / tied / conditional / not
feasible), recommendation and confidence, why, every candidate with its
eligibility and score, up to two alternatives (never a not-eligible one),
trade-offs, risks, assumptions, labelled evidence, what needs benchmarking,
what would change the decision, and gaps the phase cannot answer yet.

Wave 3 added eligibility layers for choices the existing engines make
without one - **index** (memory fit, recall ceiling per family, update
sensitivity) and **embedding** (input limit vs chunk size, self-hosting,
languages, lifecycle) - applied in the decision records only; a chosen option
that fails a rule is flagged as a conflict, never silently swapped.

### Central assessment state and snapshots (spec §23)

One state object per project with a section per concern (use case, scale,
data, embedding, vector DB, index, model, inference, token observability,
infrastructure, RAG, security, performance, cost, operations,
recommendation), each with its status, coverage, source version and summary.
Snapshots save the state with an optional label; any two can be compared
section by section.

## Phases (Waves 2-11)

Each phase is versioned per project: saving creates a new version, never an
edit. Each has a *defaults* view (what the form is pre-filled with and where
each value came from), a submit action (admins and architects) and a
*latest* view.

### AI Workload Profile (Wave 2, spec §4) - steps 01-02

Captures what Discovery does not ask: business objective and criticality,
users and applications, SLA, AI workload types, data types and sources,
end-to-end latency / TTFT / throughput, named deployment targets
(on-premises, Azure, AWS, OCI, GCP - more than one means hybrid) and
PHI / PCI / confidential data. Nothing is asked twice: blank answers resolve
from Discovery or the project, derived values are labelled, and every value
records its source.

Classifies, from `ai-factory.yaml` → `workloadProfile`:

- **workload size** - small, medium, large, enterprise, extreme scale - by the
  *highest* answered dimension (vectors, daily requests, peak QPS, users,
  concurrent users, applications), so one large dimension is never averaged
  away;
- **architecture class** - RAG, agent, copilot, generative AI, search,
  multimodal, or hybrid;
- **data classification** with the security controls it implies, and
  deployment notes. A completeness check runs before downstream phases use it.

### Model Selection (Wave 3, spec §7) - step 05

From a technology-neutral catalogue (`config/models.yaml`; open-weight models
share ids with `inference.yaml`). Requirements are derived from the Workload
Profile (with the reason per field) and can be overridden.

- Not eligible: context window, multimodal, tool calling, structured output,
  languages, self-hosting, fine-tuning, licence, GPU size.
- Conditional: accuracy / reasoning tier, restricted data on an API.
- Then weighted scoring (quality, reasoning, latency, cost, context headroom,
  deployment flexibility) with priority multipliers.

Result: **primary**, **secondary** (the other deployment family, for
portability) and **fallback** (fastest / cheapest usable) model, with
confidence and honest explanations (it never claims "highest score" when a
conditional model out-scores the primary).

### Inference Architecture (Wave 4, spec §8) - step 06

Designed on top of the existing inference sizing (unchanged), Model Selection,
the Workload Profile and Discovery. Serving options (`config/serving.yaml`):
vLLM / TGI / Triton + TensorRT-LLM on Kubernetes, vLLM on VMs, a cloud
managed endpoint, a cloud model service, CPU runtime, custom runtime -
eligibility first (model family vs sizing decision, allowed targets, required
inference patterns, precision, tensor parallelism, model size, multi-LoRA),
conditions (missing Kubernetes or on-prem GPUs, ops capability, restricted
data on an API, residency), then scoring.

Also produces: inference patterns (synchronous, streaming, asynchronous,
batch, real-time), the API / gateway / policy engine / model router design
(policy first, then default / cost / availability routes over primary,
secondary and fallback), replica strategy, autoscaling signal, load
balancing, fallback, SLA, observability, security, cost, and P50 / P95 / P99
latency estimates (a P95 miss becomes a risk).

### Infrastructure Design (Wave 5, spec §9) - step 08

Places inference serving, the vector database and the application tier on an
allowed target (on-premises, Azure, AWS, OCI, GCP): eligibility (target
allowed, GPU offered, ops capability, on-prem Kubernetes / GPU / sites,
restricted data in cloud), then weighted scoring with co-location. Produces
the deployment model (single target / hybrid / not feasible) and compute,
memory, storage, network, cluster, availability, DR, scaling and security
sections with labelled sizing. The existing Deployment plan still provides
the IaC. Catalogue: `config/infrastructure-targets.yaml`.

### RAG / Agent Architecture (Wave 6, spec §10) - step 09

Three decisions, eligibility first then weighted score:

- **retrieval** - semantic, native hybrid, or hybrid via a separate keyword index;
- **reranking** - none, self-hosted cross-encoder, managed API, or LLM reranking;
- **agent orchestration** - deterministic workflow, single tool-calling agent,
  or supervisor with sub-agents.

The rest of the RAG and agent checklist is derived from earlier phases
(filtering, context and prompt construction, citation, grounding,
hallucination mitigation, tools, memory, planning, guardrails, human
approval, tool security, isolation), with a **context-window budget** against
the primary model and a stage-by-stage **latency budget** against the TTFT
and end-to-end targets. Gaps are listed (e.g. no source field for citations).
Config: `config/rag-agent.yaml`.

### Security & Governance (Wave 7, spec §12) - step 10

A policy status - **Approved / Approved with conditions / Restricted / Not
eligible** - for every component (vector database, embedding model, each
selected model, serving runtime, reranker, agent tools, every placement),
judged by *where it processes data and on which path*, never by vendor. For
example: external processing when only on-premises is allowed is not
eligible; restricted data (PHI / PCI) is not eligible on the document path
and restricted on the request path (the policy engine routes it
in-boundary); tools that act with no policy engine are restricted.

The 18 spec §12 control areas are each required / recommended / not
applicable, and traced to the design statements that address them; required
controls nothing addresses are gaps. Validation: **pass / pass with
conditions / requires further assessment / fail**, with reasons. Config:
`config/security-governance.yaml`.

### Performance & Benchmark (Wave 8, spec §11) - step 11

Four groups of metrics - vector (recall, QPS, P95 / P99 latency, index build),
embedding (tokens/s, documents/s, cost), LLM (TTFT P50 / P95 / P99, tokens/s
per stream, end-to-end P95, quality) and infrastructure (GPU utilisation and
memory, CPU, RAM, network). Each keeps **target, estimate and measurement
apart**: targets from Discovery, the Workload Profile and Inference (or
labelled assumptions); estimates from earlier phases; measurements from the
existing vector benchmark and ingestion runs, or results an architect records
with a mandatory source.

**PASS / PASS WITH CONDITIONS / FAIL only on measured evidence**; without it a
metric **REQUIRES BENCHMARK**, whatever the estimate says (an estimate that
already misses is flagged early). Small samples, results older than the
design and assumed targets make a pass conditional. A benchmark plan lists
what to measure next. Config: `config/performance.yaml`.

### Cost & FinOps (Wave 9, spec §13) - step 12

Operating cost of the recommended architecture from the sizing in earlier
phases and a directional rate card (`config/finops.yaml`, with a review
date), compared across on-premises, Azure, AWS, OCI, GCP and the hybrid
placement: inference (GPU or managed API; cost per request, per 1K and 1M
tokens), vector DB (per replica, managed / SaaS premiums), embedding
(monthly, plus initial and re-embedding one-offs), infrastructure (app tier,
egress, hybrid interconnect) and operations (monitoring, backup, DR by tier,
support). Budget check: **within / near / over budget** (or no budget), and
the cheapest allowed option; targets that cannot host a component are *not
feasible*, not priced. Every figure is labelled; nothing is a quote.

With Token Observability enabled, the page also shows a read-only "token cost
- estimated vs actual" panel; the FinOps assessment itself is unchanged.

### AI Operations Model (Wave 10, spec §14) - step 13

Whether the design can be operated as a production AI platform:

- **SLA** - serial availability of the request path (gateway, inference, vector
  database with replicas as parallel redundancy, managed services at typical
  SLAs, capped by site / region) against the availability target;
- **RTO** - recovery time for the DR tier the design implies (cold: provision,
  restore vector data, reload weights, validate; warm / active: failover)
  against the RTO; **RPO** - snapshots or replication, with conditions;
- scaling policy, failover strategy, capacity thresholds;
- whether the team can run it - operational load against the stated
  operations capability, 24x7 on-call at high availability.

Each of the 13 spec areas is marked *from the design*, *defined here* or a
*gap*. Verdict: **operable with conditions / requires further assessment /
not operable as designed** - never unconditional, since availability and
recovery are estimates until DR is rehearsed and availability measured. The
DR tier rule is shared with Cost & FinOps so the two never disagree. Config:
`config/operations.yaml`.

### Final Recommendation (Wave 11, spec §15-§18, §25, §26) - step 14

Combines every phase; nothing is decided afresh.

- **Production readiness gate** (spec §25): data, requirements, security,
  technology eligibility, performance, cost and operations - each from the
  phases that own it; a missing or out-of-date phase never passes. Result:
  **PRODUCTION READY / PRODUCTION READY WITH CONDITIONS / REQUIRES FURTHER
  ASSESSMENT / NOT SUITABLE**, always with reasons. With Token Observability
  enabled, the cost stage also weighs token evidence.
- **Level 1** executive summary (use case, architecture, deployment, primary
  model, vector DB, inference architecture, scale, key risks, confidence).
- **Level 2** technical recommendation per decision (why, satisfied /
  partially / not satisfied, trade-offs, assumptions, evidence, benchmarks,
  what would change it).
- **Level 3** architecture chain (spec §15), each step current, out of date or
  missing.
- Primary recommendation and **up to two alternatives** in order of
  architectural impact, never one that fails a mandatory requirement.
- The **22-section Architecture Decision Record** (spec §18).
- **Level 4** implementation plan: build, deploy, benchmark, secure, operate,
  scale.

The recommendation depends on every phase, so any upstream change marks it
out of date.

## API

All under `/api/projects/:projectId/ai-factory` and behind
`AI_FACTORY_ENABLED`. Reads need access to the project; writes need the
**admin** or **architect** role.

| Method & path | What |
|---|---|
| `GET /` | Overview: guided steps, phase lineage, central state |
| `GET /decisions` | Standard decision records for every decided phase |
| `GET /impact?from=&to=` | Impact of Discovery changes between two versions (default: the previous and latest) |
| `GET /snapshots` · `POST /snapshots` · `GET /snapshots/compare?from=&to=` | Saved states; save one (optional label); compare two versions |
| `GET <phase>/defaults` | Pre-filled inputs and where each came from |
| `POST <phase>` | Run and save a new version |
| `GET <phase>/latest` | Latest saved version |

`<phase>` is `workload-profile`, `model-selection`, `inference-architecture`,
`infrastructure`, `rag-agent`, `security-governance`, `performance`, `finops`,
`operations` or `final` (the final recommendation has `preview` instead of
`defaults` and takes no body). `workload-profile` and `model-selection` also
have `GET <phase>` (version history); `model-selection` has `GET catalogue`.

Swagger documents request bodies at `/api/docs` (tag *ai-factory*).

## Configuration

| Variable | Default | File |
|---|---|---|
| `AI_FACTORY_ENABLED` | `false` | feature flag |
| `AI_FACTORY_CONFIG_PATH` | `./config/ai-factory.yaml` | phase graph, impact map, guided steps, workload-profile rules, eligibility layers |
| `AI_FACTORY_MODELS_CONFIG_PATH` | `./config/models.yaml` | model catalogue, licences, scoring weights |
| `AI_FACTORY_SERVING_CONFIG_PATH` | `./config/serving.yaml` | serving options |
| `AI_FACTORY_INFRASTRUCTURE_CONFIG_PATH` | `./config/infrastructure-targets.yaml` | deployment targets |
| `AI_FACTORY_RAG_AGENT_CONFIG_PATH` | `./config/rag-agent.yaml` | retrieval / reranking / agent patterns, token and latency assumptions |
| `AI_FACTORY_SECURITY_CONFIG_PATH` | `./config/security-governance.yaml` | policy rules, control areas |
| `AI_FACTORY_PERFORMANCE_CONFIG_PATH` | `./config/performance.yaml` | metrics, margins, assumed targets |
| `AI_FACTORY_FINOPS_CONFIG_PATH` | `./config/finops.yaml` | directional rate card |
| `AI_FACTORY_OPERATIONS_CONFIG_PATH` | `./config/operations.yaml` | availability, recovery and operational-load rules |

Figures in these files are directional planning values - review them (rate
card dates, `lastVerifiedDate` in `embeddings.yaml`) before relying on them.

## Database

One additive table per deliverable, each versioned per project:
`ai_factory_state_snapshots`, `ai_workload_profiles`, `ai_model_selections`,
`ai_inference_architectures`, `ai_infrastructure_designs`,
`ai_rag_agent_designs`, `ai_security_assessments`,
`ai_performance_assessments`, `ai_finops_assessments`,
`ai_operations_models`, `ai_final_recommendations`. Migrations (each guarded:
on a database created by `synchronize` it only records itself as applied):

```
1790177146289-AiFactorySnapshots
1790178687791-AiWorkloadProfiles
1790179946896-AiModelSelections
1790182338236-AiInferenceArchitectures
1790188588717-AiInfrastructureDesigns
1790189769100-AiRagAgentDesigns
1790190851170-AiSecurityAssessments
1790191906836-AiPerformanceAssessments
1790193029557-AiFinopsAssessments
1790194027644-AiOperationsModels
1790205916302-AiFinalRecommendations
```

Apply with `cd backend && npm run migration:run` (Token Observability adds
six more - see its reference).

## Tests

- `npm test` - engines, rules and adapters for every phase, including the real
  `config/ai-factory.yaml` (acyclic graph, every Discovery field mapped).
- `npm run test:golden` - the 53 golden-master snapshots of the existing
  VectorDB engines (Wave 0). A change that moves any existing decision or
  artefact fails CI; accept an intended change with `-- -u` and explain it in
  the commit.
