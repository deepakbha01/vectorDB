/**
 * Whether this project is a greenfield build or a modernization of an
 * existing deployment (refactoring spec S3). Existing-customer context
 * (current DB, current vector/search tech, existing Kubernetes/cloud) is
 * captured in Phase 1 Discovery's existing-technology fields
 * (hasExistingOracle/Postgres/Kubernetes, existingPlatforms) rather than
 * duplicated here - this field only records which flow the project is.
 */
export enum CustomerMode {
  NEW = 'new',
  EXISTING = 'existing',
}
