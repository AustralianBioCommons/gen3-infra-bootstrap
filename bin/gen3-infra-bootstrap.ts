#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { InfraStack } from "../lib/stacks/infra-stack";
import { Gen3IamStack } from "../lib/stacks/gen3-iam-stack";
import { ReplicationStack } from "../lib/stacks/replication-stack";
import { bucketSafeFromHostname } from '../lib/utils/names';

const app = new cdk.App();

const project = process.env.PROJECT ?? app.node.tryGetContext("project");
const envName = process.env.ENV_NAME ?? app.node.tryGetContext("envName");
const hostname = process.env.HOSTNAME ?? app.node.tryGetContext("hostname");
const namespace = process.env.NAMESPACE ?? app.node.tryGetContext("namespace");
const replicationEnabled = (process.env.REPLICATION_ENABLED ?? app.node.tryGetContext("replicationEnabled") ?? "true").toLowerCase() === "true";
const masterSecretName = process.env.DB_MASTER_SECRET_NAME ?? app.node.tryGetContext("masterSecretName");
const backupAccountId = (process.env.BACKUP_ACCOUNT_ID ?? app.node.tryGetContext('backupAccountId') ?? '111122223333') as string;
const destKmsKeyArn = (process.env.DEST_KMS_KEY_ARN ?? app.node.tryGetContext('destKmsKeyArn') ?? 'arn:aws:kms:ap-southeast-2:111122223333:key/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx') as string;


// Optional feature toggles: comma-separated list (e.g., "metadataG3auto,wtsG3auto")
const featuresCsv = process.env.FEATURES ?? app.node.tryGetContext("features") ?? "metadataG3auto,wtsG3auto,manifestserviceG3auto,auditGen3auto,ssjdispatcherCreds,pelicanserviceG3auto,fenceJwtPrivateKey";
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
});

iamStack.addDependency(infra);




if (!replicationEnabled) {

  const safeHost = bucketSafeFromHostname(hostname);
  // Destination values from the backup account (pre-created)

  const destUploadsBucketArn = `arn:aws:s3:::biocommons-backup-prod/uploads-${safeHost}`;
  const destManifestBucketArn = `arn:aws:s3:::biocommons-backup-prod/manifest-${safeHost}`;
  const destPelicanBucketArn = `arn:aws:s3:::biocommons-backup-prod/pelican-${safeHost}`;

  const repl = new ReplicationStack(app, `${project}-${envName}-replication`, {
    env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
    backupAccountId,
    // Import the replication role ARN from the source stack
    replicationRoleArn: cdk.Fn.importValue(`${infra.stackName}-ReplicationRoleArn`),
    rules: [
      {
        sourceBucket: infra.uploadsBucket,
        destBucketArn: destUploadsBucketArn,
        destKmsKeyArn: destKmsKeyArn,
        id: `uploads-${safeHost}-to-backup`,
        prefix: '',
      },
      {
        sourceBucket: infra.manifestBucket,
        destBucketArn: destManifestBucketArn,
        destKmsKeyArn: destKmsKeyArn,
        id: `manifest-${safeHost}-to-backup`,
        prefix: '',
      },
      {
        sourceBucket: infra.pelicanBucket,
        destBucketArn: destPelicanBucketArn,
        destKmsKeyArn: destKmsKeyArn,
        id: `pelican-${safeHost}-to-backup`,
        prefix: '',
      },
    ],
  });

  repl.addDependency(infra);
}