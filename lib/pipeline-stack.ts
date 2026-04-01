import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as actions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import { MainConfig, Environment, getEnabledEnvironments } from './helpers';

// ─────────────────────────────────────────────
// Deployment sequence map
//
// Same runOrder = parallel execution
// Higher runOrder = waits for lower to finish
//
// Example:
//   kms: 1, iam: 1 → both deploy in parallel
//   s3:  2          → waits for kms + iam to finish
// ─────────────────────────────────────────────
const COMPONENT_RUN_ORDER: Record<string, number> = {
  kms:     1,
  iam:     2,
  security_group:      2,
  network: 3,
  secrets_manager: 3,
  s3:      4,
  mwaa:    5,
};

export class PipelineStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const main = this.node.tryGetContext('main') as MainConfig;
    const environments = this.node.tryGetContext('environments') as Environment[];

    // Create one pipeline per enabled environment
    for (const env of getEnabledEnvironments(environments)) {
      this.createEnvPipeline(env, main);
    }
  }

  // ─────────────────────────────────────────────
  // Creates a full pipeline for one environment
  // ─────────────────────────────────────────────
  private createEnvPipeline(env: Environment, main: MainConfig): void {
    const pipelineName = `${main.projectName}-${env.env}`;

    // Artifacts passed between stages
    const sourceArtifact = new codepipeline.Artifact('Source');
    const buildArtifact = new codepipeline.Artifact('Build');

    // SNS topic — sends email when approval is needed
    const approvalTopic = new sns.Topic(this, `ApprovalTopic-${env.env}`, {
      topicName: `${pipelineName}-approval`,
    });

    if (main.notificationEmail) {
      approvalTopic.addSubscription(
        new subscriptions.EmailSubscription(main.notificationEmail)
      );
    }

    // CodeBuild project — runs buildspec.yaml from aws-infra-cdk repo
    const buildProject = new codebuild.PipelineProject(this, `BuildProject-${env.env}`, {
      projectName: `${pipelineName}-build`,
      buildSpec: codebuild.BuildSpec.fromSourceFilename('buildspec.yaml'),
      environment: {
        buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_5,
        environmentVariables: {
          ENV:          { value: env.env },
          PROJECT_NAME: { value: main.projectName },
        },
      },
    });

    // ── Stage 1: Source ───────────────────────
    // Pulls aws-infra-cdk from the env-specific branch
    const sourceStage: codepipeline.StageProps = {
      stageName: 'Source',
      actions: [
        new actions.CodeStarConnectionsSourceAction({
          actionName: 'GitHub_Source',
          owner:         main.sourceRepoOrg,
          repo:          main.sourceRepo,
          branch:        env.branch,
          connectionArn: main.codestarArn,
          output:        sourceArtifact,
        }),
      ],
    };

    // ── Stage 2: Packages ─────────────────────
    // Runs buildspec.yaml: npm ci + cdk synth
    // Output: cdk.out/ with CloudFormation templates
    const packagesStage: codepipeline.StageProps = {
      stageName: 'Packages',
      actions: [
        new actions.CodeBuildAction({
          actionName: 'Build',
          project: buildProject,
          input:   sourceArtifact,
          outputs: [buildArtifact],
        }),
      ],
    };

    // ── Stage 3: Approval ─────────────────────
    // Manual gate before any deployment
    const approvalStage: codepipeline.StageProps = {
      stageName: `${env.env}-Approval`,
      actions: [
        new actions.ManualApprovalAction({
          actionName:        `Approve-${env.env}-Deploy`,
          notificationTopic: approvalTopic,
        }),
      ],
    };

    // ── Stage 4: Deploy ───────────────────────
    // One CloudFormation action per component
    // runOrder controls parallel vs sequential execution
    const deployStage: codepipeline.StageProps = {
      stageName: `${env.env}-Deploy`,
      actions:   this.createDeployActions(env, main, buildArtifact),
    };

    // Assemble pipeline
    new codepipeline.Pipeline(this, `Pipeline-${env.env}`, {
      pipelineName,
      pipelineType: codepipeline.PipelineType.V2,
      stages: [sourceStage, packagesStage, approvalStage, deployStage],
    });
  }

  // ─────────────────────────────────────────────
  // Creates one CloudFormation deploy action per component
  // Stack name format: {projectName}-{env}-{component}
  // e.g. fhir-platform-dev-kms
  // ─────────────────────────────────────────────
  private createDeployActions(
    env: Environment,
    main: MainConfig,
    buildArtifact: codepipeline.Artifact
  ): actions.CloudFormationCreateUpdateStackAction[] {
    return env.components.map((component) => {
      const stackName = `${main.projectName}-${env.env}-${component}`;
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
