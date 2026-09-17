# Sample datasets

`rag-knowledge-base.json` is a small, self-contained set of 8 documents about
vector database concepts - matching the shape the Phase 5 Ingestion Pipeline
expects (`{ id, text, metadata }[]`).

Use it to try ingestion end-to-end once a project has completed Phase 2
(Data & Embedding Design): open the project's Ingestion page, paste this
file's contents into the documents field, and run ingestion. It is small
enough to complete in a few seconds even against the offline embedding
stand-in (see `backend/src/embedding-client`).

```
curl -s -X POST http://localhost:3000/api/projects/<project-id>/ingestion/runs \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d "{\"documents\": $(cat sample-datasets/rag-knowledge-base.json)}"
```
