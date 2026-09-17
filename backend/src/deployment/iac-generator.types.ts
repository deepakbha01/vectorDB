export interface HealthCheckDefinition {
  description: string;
  check: string;
}

export interface KubernetesArtifacts {
  namespaceYaml: string;
  secretYaml: string;
  helmValuesYaml: string;
  notes: string[];
}
