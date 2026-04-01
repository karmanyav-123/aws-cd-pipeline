// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export interface MainConfig {
  teamName: string;
  projectName: string;
  sourceRepoOrg: string;        // GitHub org/username
  sourceRepo: string;           // repo name: aws-infra-cdk
  notificationEmail: string;    // approval notification email
  codestarArn: string;          // AWS CodeStar GitHub connection ARN
}

export interface Environment {
  env: string;                  // e.g. "dev", "prod"
  account: string;              // AWS account ID
  branch: string;               // GitHub branch to source from
  disabled: boolean;            // set true to skip this env in pipeline
  components: string[];         // e.g. ["kms", "iam", "s3"]
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

/**
 * Returns only environments that are not disabled.
 */
export function getEnabledEnvironments(environments: Environment[]): Environment[] {
  return environments.filter((e) => !e.disabled);
}
