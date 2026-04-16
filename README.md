# aws-cd-pipeline

A config-driven AWS CodePipeline built with AWS CDK (TypeScript) that automates infrastructure deployments across multiple environments.

## Overview

This pipeline automates the deployment of AWS infrastructure modules from the `aws-infra-cdk` repository. It supports multiple environments (dev, prod) with manual approval gates, parallel and sequential component deployments, and automatic GitHub triggers.

## Architecture

```
GitHub push (main/dev branch)
        ↓
CodePipeline auto-trigger
        ↓
┌─────────────┐
│   Source    │ ← Checkout aws-infra-cdk (dev + main branches)
└──────┬──────┘
       ↓
┌─────────────┐
│  Packages   │ ← CodeBuild: cdk synth → CloudFormation templates
└──────┬──────┘
       ↓
┌─────────────┐
│  Approval   │ ← Manual gate (SNS email notification)
└──────┬──────┘
       ↓
┌─────────────────────────────────────┐
│              Deploy                 │
│  KMS(1) → IAM(2) → S3+Secrets(3) │
└─────────────────────────────────────┘
```

## Repository Structure

```
aws-cd-pipeline/
  bin/
    aws-cd-pipeline.ts    ← CDK app entry point
  lib/
    pipeline-stack.ts     ← Pipeline definition (stages, actions, triggers)
    helpers.ts            ← TypeScript interfaces and utilities
  cdk.context.json        ← Environment configuration
```

## Pipeline Features

- **Multi-environment** — separate pipelines for non-prod (`dev`) and prod (`main`)
- **Dual source** — pulls from both `dev` and `main` branches simultaneously
- **Config-driven** — all environments and components defined in `cdk.context.json`
- **Sequential + parallel deploys** — `runOrder` controls deployment sequence
- **Manual approval gate** — SNS email notification before any deployment
- **Auto-trigger** — GitHub push to `main` branch triggers pipeline automatically

## Configuration

```json
{
  "main": {
    "teamName": "kv",
    "projectName": "cdk-platform",
    "pipelineName": "core-cdk-platform",
    "sourceRepoOrg": "karmanyav-123",
    "sourceRepo": "aws-infra-cdk",
    "sourceBranch": "main",
    "notificationEmail": "kv@gmail.com",
    "codestarArn": "arn:aws:codeconnections:us-east-....",
    "environments": [
      {"env": "dev", "account": "acct-id", "disabled": false, "components": ["s3"]},
      {"env": "pv",  "account": "acct-id", "disabled": true,  "components": ["kms", "iam", "s3"]}
    ]
  },
  "prod": {
    "teamName": "kv",
    "projectName": "cdk-platform",
    "pipelineName": "core-cdk-platform",
    "sourceRepoOrg": "karmanyav-123",
    "sourceRepo": "aws-infra-cdk",
    "sourceBranch": "main",
    "notificationEmail": "kv@gmail.com",
    "codestarArn": "arn:aws:codeconnections:us-east-.....",
    "environments": [
      {"env": "prod", "account": "acct-id", "disabled": true, "components": ["kms", "iam", "s3"]}
    ]
  }
}
```

## Component Deployment Order

```
   kms (seq 1)
    ↓
   iam (seq 2)
    ↓
  secrets (seq 3)
    ↓
   s3 (seq 4)
```

## Tech Stack

- **Language**: TypeScript
- **IaC**: AWS CDK v2
- **CI/CD**: AWS CodePipeline v2, CodeBuild
- **Source**: GitHub via AWS CodeStar Connections
- **Notifications**: AWS SNS

## Deployment

```bash
npm install
npm run build
cdk deploy -c InstanceId=main   # non-prod pipeline
cdk deploy -c InstanceId=prod   # prod pipeline
```
