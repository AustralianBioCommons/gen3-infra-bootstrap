import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as cr from "aws-cdk-lib/custom-resources";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Runtime } from "aws-cdk-lib/aws-lambda";
import * as path from "path";

export interface G3autoInputs {
  hostname: string;
  region?: string;

  // Manifest
  manifestBucketName?: string;
  manifestPrefix?: string;

  // Pelican (prefer IRSA; keys optional)
  pelicanBucketName?: string;
  pelicanAccessKeyId?: string;
  pelicanSecretAccessKey?: string;

  // WTS
  wtsBaseUrl?: string;
  fenceBaseUrl?: string;
  oidcClientId?: string;       // optional (placeholder if missing)
  oidcClientSecret?: string;   // optional (placeholder if missing)

  // Audit
  auditSqsUrl?: string;

  // SSJ
  ssjSqsUrl?: string;
  ssjDataPattern?: string;
  ssjIndexdUser?: string;
  ssjIndexdPassword?: string;
  ssjMetadataUser?: string;
  ssjMetadataPassword?: string;
}

export interface Gen3SecretsProps {
  project: string;
  envName: string;

  /** Change this to force the custom resource to re-run */
  forceRunToken?: string;

  masterSecretName?: string; // defaults to <project>-master-<env>-rds
  services?: string[];       // defaults to canonical list

  create: {
    metadataG3auto?: boolean;
    wtsG3auto?: boolean;
    pelicanserviceG3auto?: boolean;
    manifestserviceG3auto?: boolean;
    auditGen3auto?: boolean;
    ssjdispatcherCreds?: boolean;
    fenceJwtPrivateKey?: boolean,
  };

  g3auto?: G3autoInputs;

  passwordLength?: number;   // default 24 (alnum)
  tags?: Record<string, string>;
  kmsKeyId?: string;

  dbHostOverride?: string;
  dbPortOverride?: number;

  indexdServiceUsers?: string[];
  indexdServiceStatic?: Record<string, string>;
}

export class Gen3Secrets extends Construct {
  constructor(scope: Construct, id: string, props: Gen3SecretsProps) {
    super(scope, id);

    const masterSecretName = props.masterSecretName ?? `${props.project}-master-${props.envName}-rds`;
    const services = props.services ?? [
      "index", "requestor", "fence", "peregrine", "wts", "audit", "manifestservice", "metadata", "arborist", "sheepdog"
    ];

    const onEvent = new NodejsFunction(this, "Gen3SecretsOnEvent", {
      entry: path.join(__dirname, "../../lambda/gen3-secrets/onEvent.ts"),
      runtime: Runtime.NODEJS_20_X,
      memorySize: 256,
      timeout: cdk.Duration.minutes(5),
      bundling: {
        // defaults already try local first when esbuild is present
        minify: true,
        target: "node20",
        externalModules: []
      }, // bundle aws-sdk v3 from package.json
    });

    // IAM: Get/Describe on master, Create/Tag/Describe for new
    onEvent.addToRolePolicy(new iam.PolicyStatement({
      actions: ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"],
      resources: ["*"], // master name unknown at synth; narrow if you have ARN
    }));
    onEvent.addToRolePolicy(new iam.PolicyStatement({
      actions: ["secretsmanager:CreateSecret", "secretsmanager:TagResource", "secretsmanager:DescribeSecret"],
      resources: ["*"],
    }));
    if (props.kmsKeyId) {
      onEvent.addToRolePolicy(new iam.PolicyStatement({
        actions: ["kms:Encrypt", "kms:DescribeKey"],
        resources: [props.kmsKeyId],
      }));
    }

    const provider = new cr.Provider(this, "Gen3SecretsProvider", {
      onEventHandler: onEvent,
    });

    new cdk.CustomResource(this, "Gen3SecretsCR", {
      serviceToken: provider.serviceToken,
      properties: {
        forceRunToken: (props.forceRunToken ?? "v1"),
        project: props.project,
        envName: props.envName,
        masterSecretName,
        services,
        create: props.create,
        g3auto: props.g3auto ?? {},
        passwordLength: props.passwordLength ?? 24,
        tags: props.tags ?? {},
        kmsKeyId: props.kmsKeyId,
        dbHostOverride: props.dbHostOverride,
        dbPortOverride: props.dbPortOverride,
        indexdServiceUsers: props.indexdServiceUsers ?? undefined,
        indexdServiceStatic: props.indexdServiceStatic ?? undefined,
      },
    });
  }
}
