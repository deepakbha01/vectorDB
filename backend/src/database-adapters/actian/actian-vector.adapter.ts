import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import {
  SchemaDefinition,
  VectorDatabaseAdapter,
  VectorRecord,
  VectorSearchQuery,
  VectorSearchResult,
} from '../vector-database-adapter.interface';
import { IndexTuningParameter } from '../../schema-generator/schema-generator.types';
import { IndexType } from '../../index-recommendation-engine/enums/index-type.enum';

const NOT_SUPPORTED_MESSAGE =
  'Actian has no maintained Node.js driver, so this tool cannot connect to it directly. Phase 2/3/4/7 (schema, index design, ' +
  "deployment plan, capacity planning) are fully generated - hand the generated SQL to a DBA, or run it via isql/another SQL " +
  'client over an ODBC/JDBC bridge, to actually provision it.';

/**
 * Documents, rather than silently fakes, Phase 5 support for Actian: every
 * other platform's adapter connects live given valid credentials, but no
 * mainstream Node.js driver exists for Actian (ODBC/JDBC only). This adapter
 * implements the same interface so the rest of the app (VectorAdapterFactory,
 * Phase 4 execution flow) can treat every platform uniformly, but every
 * method fails clearly rather than pretending to connect.
 */
@Injectable()
export class ActianVectorAdapter implements VectorDatabaseAdapter {
  readonly platformId = 'actian' as const;
  private readonly logger = new Logger(ActianVectorAdapter.name);

  async healthCheck(): Promise<boolean> {
    this.logger.warn(NOT_SUPPORTED_MESSAGE);
    return false;
  }

  async createSchema(_definition: SchemaDefinition): Promise<void> {
    throw new BadRequestException(NOT_SUPPORTED_MESSAGE);
  }

  async createVectorIndex(_collectionOrTableName: string, _indexType: IndexType, _parameters: IndexTuningParameter[]): Promise<void> {
    throw new BadRequestException(NOT_SUPPORTED_MESSAGE);
  }

  async upsert(_collectionOrTableName: string, _records: VectorRecord[]): Promise<void> {
    throw new BadRequestException(NOT_SUPPORTED_MESSAGE);
  }

  async search(_collectionOrTableName: string, _query: VectorSearchQuery): Promise<VectorSearchResult[]> {
    throw new BadRequestException(NOT_SUPPORTED_MESSAGE);
  }

  async deleteById(_collectionOrTableName: string, _ids: string[]): Promise<void> {
    throw new BadRequestException(NOT_SUPPORTED_MESSAGE);
  }

  async dropSchema(_collectionOrTableName: string, _confirm: boolean): Promise<void> {
    throw new BadRequestException(NOT_SUPPORTED_MESSAGE);
  }
}
