/** How use cases deploy across subscriptions (spec 3.2). Hub-and-spoke is the default. */
export enum DeploymentModel {
  CENTRALISED = 'centralised',
  HUB_AND_SPOKE = 'hub_and_spoke',
  FEDERATED = 'federated',
}

/** The role the user holds on the target scope. Offline it is declared; live it is read from Microsoft.Authorization (owner = can deploy and assign roles). */
export enum AzureRole {
  OWNER = 'owner',
  CONTRIBUTOR = 'contributor',
  READER = 'reader',
  UNKNOWN = 'unknown',
}

export enum ResourceGroupMode {
  EXISTING = 'existing',
  NEW = 'new',
}

/** Where a connection's details came from: declared by the user (offline) or verified against Azure with their sign-in (live). */
export enum ConnectionSource {
  DECLARED = 'declared',
  LIVE = 'live',
}

export enum ProfileSource {
  FORM = 'form',
  RESOURCE_GRAPH = 'resource_graph',
  SAMPLE = 'sample',
  /** Read from the subscription with the user's Azure sign-in (Wave 6). */
  LIVE = 'live',
}
