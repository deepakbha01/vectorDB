# Deployment Guide

This deploys the platform itself (the Nest API + React frontend + its own
Postgres metadata store). It does **not** provision the target vector
database your projects will use - that is generated per-project by the
Phase 4 Deployment Plan (Terraform/Kubernetes/SQL) and is a separate,
explicit, later step per project, described in `USER_GUIDE.md`.

## 1. Prerequisites

- A Postgres instance for the app's own metadata (`APP_DB_*`) - this is
  *not* one of Oracle/PostgreSQL+pgvector/Milvus that a project targets.
- Node.js 20+ if running outside Docker.
- Docker + Docker Compose for the containerized path.

## 2. Configuration

Copy `backend/.env.example` to `backend/.env` and fill in every value that
matters for your environment:

- `JWT_SECRET` - a real random 32+ character value. The app **refuses to
  boot in production without one** (see `SECURITY.md`).
- `APP_DB_*` - this app's own metadata database.
- `TARGET_*` - only fill in the block for whichever platform(s) your
  projects will actually target; leave the rest blank. Adapters connect
  lazily and only error when a project actually tries to use them.
- `OPENAI_API_KEY` - optional; without it, ingestion uses a deterministic
  offline embedding stand-in (see `SECURITY.md`/`PRODUCTION_READINESS.md`).
- `THROTTLE_TTL_SECONDS` / `THROTTLE_LIMIT` - app-wide rate limit.

Never commit a real `.env` file. In a real deployment, source these from
your platform's secret manager (not from files checked into version
control), and confirm `NODE_ENV=production` is set.

## 3. Database schema

The app currently runs with `synchronize: true` outside production, which
creates/updates its own metadata schema automatically on boot - convenient
for development, but **not** what should run in production. Before a
production deployment, apply the committed migrations (with
`NODE_ENV=production` the app does not create its schema itself):

```
cd backend
npm run migration:run
```

`src/migrations/*-InitialSchema.ts` is the baseline for every table. On a
database that was already created by `synchronize` (e.g. local development) it
detects the existing tables and only records itself as applied, so running it
there is safe. For later schema changes, generate a new migration against a
database that is at the current baseline:

```
npm run migration:generate -- src/migrations/<Name>
```

## 4. Docker Compose (fastest path for a full local/staging stack)

```
docker compose up --build
```

This builds and starts: the app's own Postgres (`app-db`), the backend API
(port 3000), and the frontend (port 8080, nginx-served, proxying `/api` to
the backend). Set the same environment variables via `docker-compose.yml`'s
`environment:` blocks (or an `.env` file Compose picks up automatically) -
never bake real secrets into the compose file itself.

## 5. Running each service independently

```
# Backend
cd backend
npm ci
npm run build
npm run start        # node dist/main.js - API on :3000, Swagger at /api/docs

# Frontend
cd frontend
npm ci
npm run build        # outputs to dist/ - serve with any static file server / nginx
```

## 6. TLS

This app does not terminate TLS itself. Put a reverse proxy, load balancer,
or ingress controller in front of it that does (and only forward decrypted
traffic internally). See `SECURITY.md` for what headers are and aren't set
at each layer.

## 7. Scaling this application

- The API is stateless (JWT auth, no server-side session) - run as many
  replicas as you want behind a load balancer.
- The app's own Postgres metadata store is a single logical instance; use
  your provider's managed HA/replica offering if you need it highly
  available (this project does not implement that itself - see
  `PRODUCTION_READINESS.md` §3.9).
- Scaling a *project's target database* (not this app) is what the Phase 7
  Capacity Plan is for - see `USER_GUIDE.md`.

## 8. CI

`.github/workflows/ci.yml` builds and tests both backend and frontend on
every push/PR. `npm audit` runs informationally (does not fail the build) -
see `SECURITY.md` for the known, tracked findings it will report.

## 9. Token Observability (optional)

Enable with `AI_FACTORY_ENABLED=true` and `TOKEN_OBSERVABILITY_ENABLED=true`.
Full reference: [TOKEN_OBSERVABILITY.md](TOKEN_OBSERVABILITY.md).

- **Migrations**: five additive migrations (`*-AiTokenEstimates`,
  `*-AiTokenUsageAndPrices`, `*-AiSimulationRuns`, `*-AiIngestKeys`,
  `*-AiTokenAlerts`) - applied by `npm run migration:run` with the rest.
- **Environment**: `TOKEN_INGEST_MAX_BODY` (usage-ingest routes only; every
  other route keeps 100 KB), `TOKEN_INGEST_RATE_LIMIT_PER_MIN`,
  `TOKEN_ALERTS_ENABLED`, `TOKEN_TENANT_VISIBILITY`,
  `TOKEN_RETENTION_ENABLED` and the three `TOKEN_*_RETENTION_DAYS` - see
  `backend/.env.example`.
- **Live telemetry**: create a project ingest key in the Token Observability
  page (Live telemetry → Manage keys). Applications send usage events to
  `POST /api/observability/usage-events`, or OTLP through the optional
  collector: `AI_FACTORY_INGEST_KEY=aftk_... docker compose --profile
  telemetry up` (`otel/collector.yaml`). In production send collector →
  API traffic over TLS (`AI_FACTORY_OTLP_ENDPOINT=https://.../api/observability/v1/traces`).
- **Background jobs**: alert evaluation (every 15 min) and retention
  clean-up (daily) run inside the API process, guarded by Postgres advisory
  locks so several replicas never run them twice.
- **Data at rest**: the usage tables hold token counts and identifiers, not
  prompts or responses, but treat them as sensitive - keep the app database
  on encrypted storage.
