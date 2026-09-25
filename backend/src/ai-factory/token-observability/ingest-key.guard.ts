import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { IngestKeyService } from './ingest-key.service';
import { keyFromHeaders } from './ingest-keys';

export interface IngestPrincipal {
  projectId: string;
  keyId: string;
  prefix: string;
}

/**
 * Authenticates collectors and SDKs by project ingest key (not a user login).
 * The key decides the project - an event can never be written anywhere else.
 */
@Injectable()
export class IngestKeyGuard implements CanActivate {
  constructor(private readonly keys: IngestKeyService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const key = keyFromHeaders(req.headers ?? {});
    const principal = key ? await this.keys.verify(key) : null;
    if (!principal) throw new UnauthorizedException('A valid, unrevoked ingest key is required (Authorization: Bearer aftk_... or X-Ingest-Key).');
    req.ingestKey = principal satisfies IngestPrincipal;
    return true;
  }
}
