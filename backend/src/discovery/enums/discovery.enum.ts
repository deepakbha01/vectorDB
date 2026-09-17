export enum Environment {
  DEVELOPMENT = 'development',
  STAGING = 'staging',
  PRODUCTION = 'production',
}

export enum DeploymentEnvironment {
  CLOUD = 'cloud',
  ON_PREMISES = 'on_premises',
  HYBRID = 'hybrid',
}

/** Team capacity to operate a database day-to-day. Feeds a penalty/discount on operational-complexity scoring. */
export enum OperationalCapability {
  NONE = 'none',
  PART_TIME = 'part_time',
  DEDICATED_DBA = 'dedicated_dba',
  PLATFORM_TEAM = 'platform_team',
}

export enum TenancyModel {
  SINGLE_TENANT = 'single_tenant',
  SHARED_MULTI_TENANT = 'shared_multi_tenant',
  DEDICATED_PER_TENANT = 'dedicated_per_tenant',
}
