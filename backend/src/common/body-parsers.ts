import { INestApplication } from '@nestjs/common';
import { json, urlencoded } from 'express';
import type { NextFunction, Request, Response } from 'express';

/** Routes that receive usage batches: project ingest, key ingest and OTLP. */
export const INGEST_PATH = /^\/api\/(observability\/(usage-events|v1\/traces)|projects\/[^/]+\/token-observability\/usage-events)\/?$/;

/**
 * JSON body limits. Everything keeps Express's 100 KB default except the
 * usage-ingest routes, whose batches of up to 1000 events need more
 * (TOKEN_INGEST_MAX_BODY, default 5 MB). gzip / deflate request bodies are
 * inflated, as OTLP exporters send them.
 *
 * Call on an app created with `bodyParser: false`.
 */
export function configureBodyParsers(app: INestApplication, ingestLimit = process.env.TOKEN_INGEST_MAX_BODY || '5mb') {
  const ingest = json({ limit: ingestLimit });
  const standard = json({ limit: '100kb' });
  app.use((req: Request, res: Response, next: NextFunction) => (INGEST_PATH.test(req.path) ? ingest : standard)(req, res, next));
  app.use(urlencoded({ extended: true, limit: '100kb' }));
}
