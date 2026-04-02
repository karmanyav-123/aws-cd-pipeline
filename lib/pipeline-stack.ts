import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as actions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import { MainConfig, Environment, getEnabledEnvironments, getBranchForEnv } from './helpers';

// ─────────────────────────────────────────────
// Deployment sequence map
//
// Same runOrder = parallel execution
// Higher runOrder = waits for lower to finish
// ─────────────────────────────────────────────
const COMPONENT_RUN_ORDER: Record<string, number> = {
  kms:             1,
  iam:             2,
  security_group:  2,
  network:         3,
  secrets_manager: 3,
  s3:              4,
  mwaa:            5,
};

export class PipelineStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // InstanceId = "main" (non-prod) or "prod"
    const instanceId = this.node.tryGetContext('InstanceId') as string;
    const config     = this.node.tryGetContext(instanceId) as MainConfig;

    if (!config) {
      throw new Error(`No config found for InstanceId: ${instanceId}. Check cdk.context.json.`);
    }

    this.createPipeline(config, instanceId);
  }

  // ─────────────────────────────────────────────
  // Creates one pipeline with all enabled envs
  // as sequential approval+deploy stage pairs
  //
  // Non-prod: Source → Packages → dev-Approval → dev-Deploy → pv-Approval → pv-Deploy
  // Prod:     Source → Packages → prod-Approval → prod-Deploy
  // ─────────────────────────────────────────────
  private createPipeline(main: MainConfig, instanceId: string): void {
    const pipelineName   = `${main.teamName}-${main.pipelineName}-${instanceId}`;
    const enabledEnvs    = getEnabledEnvironments(main.environments);

    // ── Artifacts ────────────────────────────
    // One source + build artifact per branch (dev and main)
    // dev env uses devBuild, all others use mainBuild
    const devSourceArtifact  = new codepipeline.Artifact('DevSource');
    const mainSourceArtifact = new codepipeline.Artifact('MainSource');
    const devBuildArtifact   = new codepipeline.Artifact('DevBuild');
    const mainBuildArtifact  = new codepipeline.Artifact('MainBuild');

    // ── Source Actions ────────────────────────
    // Checkout-dev  → dev branch
    // Checkout-main → main branch (sourceBranch)
    const checkoutDev = new actions.CodeStarConnectionsSourceAction({
      actionName:    'Checkout-dev',
      owner:         main.sourceRepoOrg,
      repo:          main.sourceRepo,
      branch:        'dev',
      connectionArn: main.codestarArn,
      output:        devSourceArtifact,
    });

    const checkoutMain = new actions.CodeStarConnectionsSourceAction({
      actionName:    'Checkout-main',
      owner:         main.sourceRepoOrg,
      repo:          main.sourceRepo,
      branch:        main.sourceBranch,
      connectionArn: main.codestarArn,
      output:        mainSourceArtifact,
    });

    // ── CodeBuild Projects ────────────────────
    // One per branch — each runs buildspec.yaml with its own ENV
    const devBuildProject = this.createBuildProject('dev', main);
    const mainBuildProject = this.createBuildProject('main', main);

    // ── Stage 1: Source ───────────────────────
    const sourceStage: codepipeline.StageProps = {
      stageName: 'Source',
      actions:   [checkoutDev, checkoutMain],
    };

    // ── Stage 2: Packages ─────────────────────
    // Package-dev  → synth dev branch
    // Package-main → synth main branch
    const packagesStage: codepipeline.StageProps = {
      stageName: 'Packages',
      actions: [
        new actions.CodeBuildAction({
          actionName: 'Package-dev',
          project:    devBuildProject,
          input:      devSourceArtifact,
          outputs:    [devBuildArtifact],
          runOrder:   1,
        }),
        new actions.CodeBuildAction({
          actionName: 'Package-main',
          project:    mainBuildProject,
          input:      mainSourceArtifact,
          outputs:    [mainBuildArtifact],
          runOrder:   1,
        }),
      ],
    };

    // ── Stages 3+: Approval + Deploy per env ──
    // Each env gets its own approval → deploy stage pair
    // dev  → devBuildArtifact
    // others → mainBuildArtifact
    const envStages: codepipeline.StageProps[] = [];

    for (const env of enabledEnvs) {
      const artifact = env.env === 'dev' ? devBuildArtifact : mainBuildArtifact;

      envStages.push({
        stageName: `${env.env}-Approval`,
        actions: [
          new actions.ManualApprovalAction({
            actionName: `Approve-${env.env}-Deploy`,
          }),
        ],
      });

      envStages.push({
        stageName: `${env.env}-Deploy`,
        actions:   this.createDeployActions(env, artifact),
      });
    }

    // ── Trigger ───────────────────────────────
    // Auto trigger on push to main branch only
    const triggers: codepipeline.TriggerProps[] = [
      {
        providerType: codepipeline.ProviderType.CODE_STAR_SOURCE_CONNECTION,
        gitConfiguration: {
          sourceAction: checkoutMain,
          pushFilter: [
            { branchesIncludes: [main.sourceBranch] },
          ],
        },
      },
    ];

    // ── Assemble Pipeline ─────────────────────
    new codepipeline.Pipeline(this, 'Pipeline', {
      pipelineName,
      pipelineType: codepipeline.PipelineType.V2,
      stages:   [sourceStage, packagesStage, ...envStages],
      triggers,
    });
  }

  // ─────────────────────────────────────────────
  // Creates a CodeBuild project for a given branch
  // ─────────────────────────────────────────────
  private createBuildProject(
    branch: string,
    main: MainConfig
  ): codebuild.PipelineProject {
    return new codebuild.PipelineProject(this, `BuildProject-${branch}`, {
      projectName: `${main.pipelineName}-build-${branch}`,
      buildSpec:   codebuild.BuildSpec.fromSourceFilename('buildspec.yaml'),
      environment: {
        buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_5,
        environmentVariables: {
          PROJECT_NAME: { value: main.projectName },
        },
      },
    });
  }

  // ─────────────────────────────────────────────
  // Creates one CloudFormation deploy action per component
  // Stack name format: {Component}Stack-{env}
  // e.g. KmsStack-dev, S3Stack-pv
  // ─────────────────────────────────────────────
  private createDeployActions(
    env: Environment,
    buildArtifact: codepipeline.Artifact
  ): actions.CloudFormationCreateUpdateStackAction[] {
    return env.components.map((component) => {
      const stackName = `${component.charAt(0).toUpperCase() + component.slice(1)}Stack-${env.env}`;
      const runOrder  = COMPONENT_RUN_ORDER[component] ?? 1;

      return new actions.CloudFormationCreateUpdateStackAction({
        actionName:       `Deploy-${component}`,
        stackName,
        templatePath:     buildArtifact.atPath(`cdk.out/${stackName}.template.json`),
        adminPermissions: true,
        runOrder,
      });
    });
  }
}