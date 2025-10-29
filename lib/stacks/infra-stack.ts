import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { Gen3Secrets } from "../constructs/gen3-secrets";
import { bucketSafeFromHostname } from "../utils/names";
import * as ssm from "aws-cdk-lib/aws-ssm";
import * as sns from "aws-cdk-lib/aws-sns";
import { SqsSubscription } from "aws-cdk-lib/aws-sns-subscriptions";
import * as s3n from "aws-cdk-lib/aws-s3-notifications";
import * as kms from "aws-cdk-lib/aws-kms";


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
    fenceJwtPrivateKey?: boolean,
  };
}

export class InfraStack extends cdk.Stack {

  public readonly uploadsBucket: s3.Bucket;
  public readonly manifestBucket: s3.Bucket;
  public readonly pelicanBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: InfraStackProps) {
    super(scope, id, props);

    const { project, envName, hostname, features } = props;

    // --- KMS keys for Gen3 app buckets ---
    const uploadsKey = new kms.Key(this, "UploadsKmsKey", {
      alias: `alias/${project}-${envName}-uploads-s3`,
      enableKeyRotation: true,
      description: `KMS key for uploads bucket (${project}/${envName})`,
    });

    const manifestKey = new kms.Key(this, "ManifestKmsKey", {
      alias: `alias/${project}-${envName}-manifest-s3`,
      enableKeyRotation: true,
      description: `KMS key for manifest bucket (${project}/${envName})`,
    });

    const pelicanKey = new kms.Key(this, "PelicanKmsKey", {
      alias: `alias/${project}-${envName}-pelican-s3`,
      enableKeyRotation: true,
      description: `KMS key for pelican bucket (${project}/${envName})`,
    });

    const safeHost = bucketSafeFromHostname(hostname);

    const pelicanBucket = new s3.Bucket(this, "PelicanBucket", {
      bucketName: `pelican-${safeHost}`, // e.g., pelican-commons-heartdata-baker-edu-au
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: pelicanKey,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: true,
    });

    this.pelicanBucket = pelicanBucket;

    const manifestBucket = new s3.Bucket(this, "ManifestBucket", {
      bucketName: `manifest-${safeHost}`, // e.g., manifest-omix3-test-biocommons-org-au
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: manifestKey,
      versioned: true,
    });

    this.manifestBucket = manifestBucket;

    const uploadsBucket = new s3.Bucket(this, "UploadsBucket", {
      bucketName: `uploads-${safeHost}`, // e.g., uploads-omix3-test-biocommons-org-au
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: uploadsKey,
      versioned: true,
      eventBridgeEnabled: true,
    });

    this.uploadsBucket = uploadsBucket;

    // --- SNS topic for upload notifications ---
    const uploadTopic = new sns.Topic(this, "DataUploadTopic", {
      topicName: `dataupload-${project}-${envName}-uploads`,
    });

    const schemaBucket = new s3.Bucket(this, "schemaBucket", {
      bucketName: `schema-${safeHost}`, // e.g., schema-omix3-test-biocommons-org-au
      publicReadAccess: true,
      blockPublicAccess: new s3.BlockPublicAccess({
        blockPublicAcls: false,
        blockPublicPolicy: false,
        ignorePublicAcls: false,
        restrictPublicBuckets: false,
      }),
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

    uploadTopic.addSubscription(new SqsSubscription(dataUploadQueue));

    uploadsBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.SnsDestination(uploadTopic)
    );


    // Secrets bootstrap (strict create-if-missing)
    new Gen3Secrets(this, "Gen3Secrets", {
      project,
      envName,
      forceRunToken: process.env.FORCE_RUN_TOKEN ?? undefined,
      masterSecretName: process.env.DB_MASTER_SECRET_NAME ?? `${project}-master-${envName}-rds`,

      create: {
        metadataG3auto: !!features.metadataG3auto,
        wtsG3auto: !!features.wtsG3auto,
        pelicanserviceG3auto: !!features.pelicanserviceG3auto,
        manifestserviceG3auto: !!features.manifestserviceG3auto,
        auditGen3auto: !!features.auditGen3auto,
        ssjdispatcherCreds: !!features.ssjdispatcherCreds,
        fenceJwtPrivateKey: !!features.fenceJwtPrivateKey,
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
        ssjDataPattern: `s3://${uploadsBucket.bucketName}/*`,
      },

      // Optional: kmsKeyId, dbHostOverride, dbPortOverride
      passwordLength: 24,
      tags: { app: "gen3", env: envName, project: project },
    });

    // S3 buckets SSM parameters
    new ssm.StringParameter(this, "UploadsBucketNameParam", {
      parameterName: `/gen3/${project}-${envName}/s3/uploadsBucketName`,
      stringValue: uploadsBucket.bucketName,
    });

    new ssm.StringParameter(this, "ManifestBucketNameParam", {
      parameterName: `/gen3/${project}-${envName}/s3/manifestBucketName`,
      stringValue: manifestBucket.bucketName,
    });

    new ssm.StringParameter(this, "PelicanBucketNameParam", {
      parameterName: `/gen3/${project}-${envName}/s3/pelicanBucketName`,
      stringValue: pelicanBucket.bucketName,
    });

    // SQS queue SSM parameters
    new ssm.StringParameter(this, "SsjDispatcherQueueArnParam", {
      parameterName: `/gen3/${project}-${envName}/sqs/ssjdispatcherQueueArn`,
      stringValue: dataUploadQueue.queueArn,
    });

    // KMS Key ARNs SSM parameters
    new ssm.StringParameter(this, "UploadsKeyArnParam", {
      parameterName: `/gen3/${project}-${envName}/kms/uploadsKeyArn`,
      stringValue: uploadsKey.keyArn,
    });
    new ssm.StringParameter(this, "ManifestKeyArnParam", {
      parameterName: `/gen3/${project}-${envName}/kms/manifestKeyArn`,
      stringValue: manifestKey.keyArn,
    });
    new ssm.StringParameter(this, "PelicanKeyArnParam", {
      parameterName: `/gen3/${project}-${envName}/kms/pelicanKeyArn`,
      stringValue: pelicanKey.keyArn,
    });

  }
}
