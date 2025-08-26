import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { Gen3Secrets } from "../constructs/gen3-secrets";
import { bucketSafeFromHostname } from "../util/names";

export interface InfraStackProps extends cdk.StackProps {
  project: string;
  envName: string;
  hostname: string;
  features: {
    metadataG3auto?: boolean;
    wtsG3auto?: boolean;
    pelicanserviceG3auto?: boolean;
    manifestserviceG3auto?: boolean;
    auditGen3auto?: boolean;
    ssjdispatcherCreds?: boolean;
  };
}

export class InfraStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: InfraStackProps) {
    super(scope, id, props);

    const { project, envName, hostname, features } = props;

    // Example infra used by secrets
    const safeHost = bucketSafeFromHostname(hostname);

    const pelicanBucket = new s3.Bucket(this, "PelicanBucket", {
      bucketName: `pelican-${safeHost}`, // e.g., pelican-commons-heartdata-baker-edu-au
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    });

    const manifestBucket = new s3.Bucket(this, "ManifestBucket", {
      bucketName: `manifest-${safeHost}`, // e.g., manifest-omix3-test-biocommons-org-au
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
    });

    const auditQueue = new sqs.Queue(this, "AuditQueue", {
      queueName: `audit-service-${project}-${envName}`,
      visibilityTimeout: cdk.Duration.seconds(60),
    });

    const dataUploadQueue = new sqs.Queue(this, "DataUploadQueue", {
      queueName: `data-upload-${project}-${envName}`,
      visibilityTimeout: cdk.Duration.seconds(60),
    });

    // Secrets bootstrap (strict create-if-missing)
    new Gen3Secrets(this, "Gen3Secrets", {
      project,
      envName,
      masterSecretName: process.env.DB_MASTER_SECRET_NAME ?? `${project}-master-${envName}-rds`,

      create: {
        metadataG3auto: !!features.metadataG3auto,
        wtsG3auto: !!features.wtsG3auto,
        pelicanserviceG3auto: !!features.pelicanserviceG3auto,
        manifestserviceG3auto: !!features.manifestserviceG3auto,
        auditGen3auto: !!features.auditGen3auto,
        ssjdispatcherCreds: !!features.ssjdispatcherCreds,
      },

      g3auto: {
        hostname,
        region: this.region,

        // Manifest service
        manifestBucketName: manifestBucket.bucketName,
        manifestPrefix: "",
        pelicanBucketName: pelicanBucket.bucketName,

        // WTS OIDC – optional (placeholders "replace-me" written if absent)
        oidcClientId: process.env.WTS_OIDC_CLIENT_ID,
        oidcClientSecret: process.env.WTS_OIDC_CLIENT_SECRET,

        // Audit
        auditSqsUrl: `https://sqs.${this.region}.amazonaws.com/${this.account}/${auditQueue.queueName}`,

        // SSJ
        ssjSqsUrl: `https://sqs.${this.region}.amazonaws.com/${this.account}/${dataUploadQueue.queueName}`,
        ssjDataPattern: `s3://dataupload-${project}-${envName}-biocommons/*`,
      },

      // Optional: kmsKeyId, dbHostOverride, dbPortOverride
      passwordLength: 24,
      tags: { app: "gen3", env: envName, project: project },
    });
  }
}
