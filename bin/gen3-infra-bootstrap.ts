#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { InfraStack } from "../lib/stacks/infra-stack";
import { Gen3IamStack } from "../lib/stacks/gen3-iam-stack";

const app = new cdk.App();

const project = process.env.PROJECT ?? app.node.tryGetContext("project");
const envName = process.env.ENV_NAME ?? app.node.tryGetContext("envName");
const hostname = process.env.HOSTNAME ?? app.node.tryGetContext("hostname");
const namespace = process.env.NAMESPACE ?? app.node.tryGetContext("namespace");
const masterSecretName = process.env.DB_MASTER_SECRET_NAME ?? app.node.tryGetContext("masterSecretName");

// Optional feature toggles: comma-separated list (e.g., "metadataG3auto,wtsG3auto")
const featuresCsv = process.env.FEATURES ?? app.node.tryGetContext("features") ?? "metadataG3auto,wtsG3auto,manifestserviceG3auto,auditGen3auto,ssjdispatcherCreds";
const features = featuresCsv.split(",").reduce((acc: Record<string, boolean>, f: string) => {
  const k = f.trim();
  if (k) acc[k] = true;
  return acc;
}, {});

if (!project || !envName || !hostname) {
  throw new Error("Missing PROJECT / ENV_NAME / HOSTNAME (env or -c).");
}

const infra = new InfraStack(app, `Gen3-Infra-${project}-${envName}`, {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
  project,
  envName,
  hostname,
  features,
});

const iamStack = new Gen3IamStack(app, `Gen3-IamRoles-${project}-${envName}`, {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
  project,
  envName,
  namespace,
  hostname,
}).addDependency(infra);
