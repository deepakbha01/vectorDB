/**
 * How often vectors are inserted/updated/deleted after the initial load.
 * Affects index choice: graph- and cluster-based indexes degrade differently
 * under sustained write pressure (see `updateFriendliness` in indexes.yaml).
 */
export enum UpdateFrequency {
  STATIC = 'static',
  LOW = 'low',
  MODERATE = 'moderate',
  HIGH = 'high',
}
