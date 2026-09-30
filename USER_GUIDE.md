# Evectorize - User Guide

This walks through the platform end to end: assessing a workload, designing
a pipeline, provisioning, ingesting data, and tuning/planning for scale.

## 1. Create an account and a project

Register at `/register`, then **+ New Project** from the dashboard. A
project starts with its target platform `undetermined` - Phase 1 decides it.

To delete a project, click **Delete** next to it on the dashboard and type its
name to confirm (architects for their own projects, admins for any). This
removes every phase deliverable, AI Factory assessment and token usage of the
project and cannot be undone; the audit log keeps its entries and your own
vector databases are not touched.

## 2. Phase 1 - Discovery

Fill in the assessment: expected scale (document count/growth, vector count,
dimension), performance targets (QPS, latency, recall), existing
infrastructure (Oracle/PostgreSQL/Kubernetes you already run), and
security/compliance needs. Submit it and the Architecture Decision Engine
recommends Oracle, PostgreSQL+pgvector, or Milvus - with its reasoning,
alternatives it rejected and why, an infrastructure estimate, and risks.
Disagree with it? Use the "Manually override this decision" link - you'll
be asked for a rationale, which is recorded for audit.

## 3. Phase 2 - Data & Embedding Design

Pick a chunking strategy and preview it against sample text right in the
page before committing. Choose an embedding provider/model - the catalog
shows real dimension, cost, and quality info per model. Define your
metadata fields (name + type). Submitting generates the actual database
schema (SQL for Oracle/Postgres, a collection schema for Milvus) and the
full pipeline plan (retry/dead-letter/monitoring config).

## 4. Phase 3 - Index Design

Most inputs default from Phase 1/2 automatically (vector count, dimension,
QPS, targets) - you only need to say how often data will be
inserted/updated after the initial load. The engine picks HNSW, IVF-Flat, or
PQ and computes real tuned parameters (M/efConstruction/efSearch, or
nlist/nprobe), with impact estimates and scaling considerations.

### Vector DB Selection: how the cost fit is calculated

Each candidate platform is scored 0-1 on seven criteria, and cost fit is one
of them (10% of the total by default, `scoringWeights.cost` in
`config/thresholds.yaml`). It is **directional**: how costly the platform is
to stand up and run relative to the others, from what you already operate
and your scale. It is not a price. Dollar figures for the chosen design come
from the AI Factory's Cost Recommendation, priced from its rate card.

| Cost model | Cost fit |
| --- | --- |
| Reuse existing PostgreSQL (pgvector) | 0.95 |
| New PostgreSQL | 0.60 |
| Reuse existing Oracle, or another SQL platform you run | 0.90 |
| New Oracle, or another new SQL platform | 0.40 |
| Embedded in the application (Chroma, LanceDB) | 0.85, or 0.95 if already used |
| Managed SaaS (Pinecone, MongoDB Atlas) | 0.45 new account, 0.70 existing |
| Self-hosted on Kubernetes (Milvus, Qdrant, Weaviate, Elasticsearch, Redis) | min(1, start + 0.30 × scale) |

For self-hosted platforms the starting point is 0.75 if you already run
that platform, 0.60 if you have Kubernetes to reuse, and 0.25 if a cluster
has to be stood up. The scale term reflects that a dedicated cluster costs
about the same whatever it holds, so its cost per vector falls as the corpus
grows: it rises from 0 at 5 million vectors to 1 at 20 million
(`vectorCount.embeddedMax` and `dedicatedRecommendedMin`). For example,
12.5 million vectors on existing Kubernetes gives min(1, 0.60 + 0.30 × 0.50)
= 0.75.

On the Vector DB Selection page, *Show technical details*, then open *Why
<platform> scored this way*: each platform shows its cost model, why it
applies, the terms added up, the formula with your numbers, and what cost
adds to its total. Selections saved before this was added show the score
only; re-run the selection to see the breakdown.

## 5. Phase 4 - Implementation

**Generate Deployment Plan** combines Phases 2 and 3 into one real SQL/
schema script (with the actual vector index DDL, not a placeholder),
Terraform, and - for Milvus - Kubernetes/Helm artifacts, plus a checklist,
health check, and rollback procedure. This step only *generates* the plan.

**Execute Deployment** is a separate, explicit, checkbox-gated action that
actually connects to your configured target database (`TARGET_*` env vars -
see `DEPLOYMENT.md`) and creates the schema and index for real. It never
drops anything.

## 6. Phase 5 - Ingestion

Paste a JSON array of `{ id?, text, metadata }` documents (see
`sample-datasets/rag-knowledge-base.json` for a ready-made example) and run
ingestion. Watch the run's metrics: chunks produced/stored/deduplicated/
dead-lettered. If anything failed, view the dead letters and retry them
once the underlying issue (e.g. target connectivity) is fixed.

## 7. Phase 6 - Optimization

Run a benchmark. It builds a synthetic, disposable dataset at your real
embedding dimension, tests several search-parameter values around your
Phase 3 recommendation, and reports a Latency vs Recall vs Memory vs Cost
comparison, bottlenecks, and a recommended configuration - all against a
temporary collection that's cleaned up automatically, never your real data.

## 8. Phase 7 - Capacity

Generate a capacity plan. It projects 6/12/24 months forward from your
Phase 1 growth rate and tells you when you'll need more memory/CPU/storage,
what sharding strategy fits your platform, and HA/DR recommendations tied to
your own availability/RPO/RTO targets.

## 9. Reports & Audit Log

From any phase page's sidebar, under "Project tools": **Reports** exports
any completed phase's deliverable (or everything done so far) as PDF or
DOCX. **Audit Log** shows every action taken on the project - who, what,
when - click a row for the full (redacted) request/response detail.

## 10. AI Factory (guided AI architecture assessment)

When the AI Factory is enabled, the sidebar gains an **Inference track**:
**AI Factory (guided)** plus one page per phase - AI Workload Profile, Model
Selection, Inference Architecture, Infrastructure Design, RAG / Agent
Architecture, Security & Governance, Performance & Benchmark, Cost Recommendation,
Operations Model and Final Recommendation.

- Start at **AI Factory (guided)**: it lists the steps (01 Use Case to the
  Final Recommendation) with their status, the phases behind each, and every
  decision record - chosen option, why, alternatives, trade-offs, risks and
  labelled evidence.
- Work through the phase pages in order. Each form is pre-filled from earlier
  phases and shows where every value came from; change anything you need,
  then submit (architects and admins). Each submit saves a new version.
- A phase marked **out of date** was built before something it depends on
  changed - re-run it. **Review** means only a suggestion source changed.
- After changing Discovery answers, the **Impact** panel shows which phases to
  re-run, which to review and which are unaffected.
- **Snapshots** save the whole assessment state; compare any two to see what
  changed.
- The **Final Recommendation** combines everything into a readiness verdict
  (production ready, with conditions, requires further assessment, not
  suitable), the architecture, up to two alternatives, a 22-section ADR and
  an implementation plan. Missing or out-of-date phases are shown, never
  filled in.

Costs are directional estimates, not quotes; performance only passes on
measured evidence. Details: [AI_FACTORY.md](AI_FACTORY.md).

## 11. Token Observability (AI Factory)

When enabled, **Token Observability** appears in the sidebar after Inference
Architecture (guided step 7). Three tabs, never mixed:

- **Estimated** - tokens per request and per month, what makes up the prompt,
  RAG and agent breakdowns, and cost from the versioned price table. *Save
  estimate* to keep a version; it is marked out of date when an upstream
  phase changes.
- **Simulated** - *Upload / manage* a load-test or benchmark result (CSV or
  JSON; download the template from the panel). Rejected rows are listed with
  their row number and reason. Each upload is a run: *View* shows its time
  span, *Delete* removes it.
- **Live telemetry** - *Manage keys / how to connect*: create an ingest key
  (shown once) for your application or OpenTelemetry Collector. Alerts for
  live usage appear at the top; *Acknowledge* records that you are on it.

On the Simulated and Live dashboards: filter by time, environment,
application, service, workflow, provider, model (and tenant, for admins and
architects). Click a trend bar to narrow the time range, a service or model
bar to filter to it, and a request to open its trace. *Export CSV* saves the
summary. Choose *Executive view* for the headline figures only. The Cost
Recommendation page shows token cost estimated vs actual, and the Final
Recommendation weighs token evidence in its cost check. Details:
[TOKEN_OBSERVABILITY.md](TOKEN_OBSERVABILITY.md).

## 12. Data Explorer

When enabled (`DATA_EXPLORER_ENABLED`), **Data Explorer** appears under
*Project tools*. It is a **read-only** look inside the project's target vector
database - the platform chosen in Vector DB Selection, connected through the
server's `TARGET_*` settings or the project's own connection (below). It
never writes to, loads or changes the database. It works with every platform the tool connects to - PostgreSQL +
pgvector, Oracle, Milvus, Qdrant, Pinecone, Weaviate, Chroma, Elasticsearch,
Redis, MongoDB Atlas and LanceDB. Actian says "not supported" (it has no
Node.js driver).

Pick a collection (the one your Data & Embedding design deploys is marked
*designed*), then:

- **Overview** - records, dimension, metric and ANN index, and **Design vs
  deployed**: the collection, vector dimension, similarity metric, index type
  and metadata fields against Data & Embedding design, Index Design and
  Discovery. Each row says *Match*, *Mismatch*, *Info* or *Unknown* and which
  phase the designed value comes from. A value either side does not know is
  *Unknown*, never a guessed match.
- **Documents** - 25 records per page, with their metadata and the first few
  vector values. *Add a filter*: up to five conditions (=, ≠, >, ≥, <, ≤ on
  numbers, or *is one of* a list), all of which must hold (*match all*) or
  any one (*match any*). Where the database can order a listing (PostgreSQL,
  Oracle, MongoDB, Elasticsearch, Weaviate) *Sort by* a field, *then by* up to
  two more. Click an id to
  open the record in full: every field, the first 64 vector values and the
  vector's length (norm).
- **Search** - **Dense**: type text (embedded with the project's own
  embedding model, as ingestion does) or paste a vector. **Keyword**: the
  database's own text ranking (PostgreSQL full text, Elasticsearch and
  Weaviate BM25, LanceDB and MongoDB Atlas full-text indexes). **Hybrid**:
  both, fused by **rank** (RRF - robust to the two lists' different score
  scales), by **weighted scores** (each list rescaled to 0-1; keeps score gaps,
  so one outlier can dominate) or by **the database's own** hybrid search
  (Weaviate hybrid, weighted by the slider; Elasticsearch's RRF retriever,
  equal weight, Elasticsearch 8.14+ with a licence that includes RRF). The
  slider sets the weight on dense. *Min score* drops weaker results (for
  hybrid, from the dense candidates before fusion; not with the database's own
  hybrid), so fewer than Top K may show. Results show their score (and, for
  hybrid, each list's rank), the score spread - max, median, mean, min,
  standard deviation, the gap between the top two and how far the top result
  stands out (σ) - the query vector itself (length, norm, mean, variance,
  zeros), and the query time against the Discovery P95 target (one query -
  the Performance phase measures percentiles).
- **Compare** - the same query run two ways side by side (dense vs hybrid,
  two weightings, with and without a filter, two Top Ks): how many results
  they share, which appear on one side only, and how far each shared record
  moved.
- **Map** - *Draw map* projects a sample of 100-1,000 records to **2D or 3D**
  on the server: **PCA** (distances along the axes mean something; it says
  how much of the variance each axis keeps), **UMAP** (shows clusters;
  distances between clusters mean nothing) or **t-SNE** (the sharpest
  clusters, but the layout between them means nothing; slowest - several
  seconds for 1,000 records). Drag a 3D map, or focus it and use the arrow
  keys, to turn it. *Colour by* a field colours its three most common values;
  the rest are *Other*, and records without a value are drawn hollow. *Show
  as a table* lists every point. Only ids, positions and the colour-by value
  reach the browser - never the vectors.

**Named vectors** (Qdrant, Weaviate, Milvus, PostgreSQL): when a collection
holds several vectors per record, a *Vector* selector appears next to the
collection, with each vector's kind - dense, **sparse** (index → weight, e.g.
SPLADE or BM25 vectors) or **binary** (bits). Search, Compare, the Map and the
record view then use the chosen vector (its own dimension is checked against
the query). A sparse vector is searched with index:weight pairs (Qdrant,
Milvus, pgvector `sparsevec`); a binary one with bits (Milvus, pgvector `bit`,
by Hamming distance). The record view shows a sparse vector's heaviest
entries and a binary vector's bits. The Map and Compare use dense vectors.

**Tenants and namespaces**: a Weaviate multi-tenant collection shows a
*Tenant* selector (every read is for one tenant; counts are per tenant), and a
Pinecone index with namespaces shows a *Namespace* selector with each one's
record count (the default namespace otherwise).

**Connection** - *Manage connection* shows whether the project uses the
server's `TARGET_*` settings or its own. Admins and architects can give a
project its own connection - host, credentials and so on for its platform -
and *Test* it before saving. Ingestion, deployment, benchmarks and the Data
Explorer then use it for that project only; *Remove* goes back to the server's
settings. Settings are stored encrypted with the server's
`CONNECTION_SECRET_KEY` (without one, saving is refused); secret values are
never shown again - leave a secret empty to keep it, or *Clear* it. If the key
is changed, saved connections can no longer be opened: the project then
reports an error rather than quietly using the server's settings. The Audit
Log records which settings changed, never their values.

How each database behaves: Pinecone lists records but cannot filter the list
(filter in Search instead); MongoDB Atlas can filter a search only on the
fields its vector index declares; Milvus collections must be loaded in Milvus
first; offset-paged databases (Milvus, Weaviate, Elasticsearch, Chroma,
Redis, LanceDB) page up to their own depth limits. Where a database chooses
its own index (Pinecone), the design check shows the index as *Unknown*.

Documents, Search, Compare, Map and the record view show customer data, so they are for admins and
architects, and every read is recorded in the Audit Log (who, what, how many
records - never the records themselves). Long values are shortened. A Milvus
collection must be loaded in Milvus first; the explorer does not load it.


- **Viewer**: can see everything, change nothing (except record contents in the Data Explorer).
- **Architect**: can do everything except execute a real deployment.
- **Admin**: everything, including `Execute Deployment`.

Ask an existing admin to change your role (see `RUNBOOK.md`).
