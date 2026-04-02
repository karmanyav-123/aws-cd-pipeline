// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export interface MainConfig {
  teamName: string;
  projectName: string;
  pipelineName: string;
  sourceRepoOrg: string;
  sourceRepo: string;
  sourceBranch: string;        // default branch (main) — used for pv, prod envs
  notificationEmail: string;
  codestarArn: string;
  environments: Environment[];
}

export interface Environment {
  env: string;                  // e.g. "dev", "pv", "prod"
  account: string;
  disabled: boolean;
  components: string[];
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

/**
 * Returns the branch to use for a given environment.
 * dev env → "dev" branch
 * all others → sourceBranch (main)
 */
export function getBranchForEnv(env: string, sourceBranch: string): string {
  return env === 'dev' ? 'dev' : sourceBranch;
}