# User Guide

This walks through the platform end to end: assessing a workload, designing
a pipeline, provisioning, ingesting data, and tuning/planning for scale.

## 1. Create an account and a project

Register at `/register`, then **+ New Project** from the dashboard. A
project starts with its target platform `undetermined` - Phase 1 decides it.

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

## Roles

- **Viewer**: can see everything, change nothing.
- **Architect**: can do everything except execute a real deployment.
- **Admin**: everything, including `Execute Deployment`.

Ask an existing admin to change your role (see `RUNBOOK.md`).
