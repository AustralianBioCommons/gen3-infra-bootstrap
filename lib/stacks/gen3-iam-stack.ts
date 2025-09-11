import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";
import { readRequired, readOptional } from "../utils/ssm";

const P = (scope: Construct, p: string) =>
    ssm.StringParameter.valueForStringParameter(scope, p, 1); // simple helper

function tryParam(scope: Construct, path: string): string | undefined {
    try { return P(scope, path); } catch { return undefined; }
}

export interface Gen3IamStackProps extends cdk.StackProps {
    project: string;   // "omix3" | "acdc" | ...
    envName: string;   // "test" | "prod"
    namespace: string; // k8s namespace
    permissionBoundaryName?: string;
}

export class Gen3IamStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: Gen3IamStackProps) {
        super(scope, id, props);
        const { project, envName, namespace } = props;
        const base = `/gen3/${project}-${envName}`;

        // core (must exist)
        const issuer = readRequired(this, `${base}/oidcIssuer`);
        const providerArn = readRequired(this, `${base}/oidcProviderArn`);
        const clusterName = readRequired(this, `${base}/clusterName`);

        // optional (skip if absent)
        const uploadsBucketName = readOptional(this, `${base}/s3/uploadsBucketName`);
        const manifestBucketName = readOptional(this, `${base}/s3/manifestBucketName`);
        const sqsQueueArn = readOptional(this, `${base}/sqs/ssjdispatcherQueueArn`);
        const esDomainArn = readOptional(this, `${base}/opensearch/domainArn`);
        const kmsDataKeyArn = readOptional(this, `${base}/kms/dataKeyArn`);
        const fenceDbSecretArn = readOptional(this, `${base}/secrets/fenceDbArn`);
        const nfUserArnPrefix = readOptional(this, `${base}/iam/nfUserArnPrefix`);


        const irsa = (sa: string) =>
            new iam.FederatedPrincipal(
                providerArn,
                { StringEquals: { [`${issuer}:aud`]: "sts.amazonaws.com", [`${issuer}:sub`]: `system:serviceaccount:${namespace}:${sa}` } },
                "sts:AssumeRoleWithWebIdentity"
            );

        const roleName = (svc: string) => `gen3-${project}-${envName}-${svc}-role`;

        const boundary = props.permissionBoundaryName
            ? iam.ManagedPolicy.fromManagedPolicyName(this, "PB", props.permissionBoundaryName)
            : undefined;

        // Reusable policy blocks (created only if SSM values exist)
        const managed: Record<string, iam.ManagedPolicy | undefined> = {};

        if (uploadsBucketName) {
            managed.S3UploadsRW = new iam.ManagedPolicy(this, "S3UploadsRW", {
                managedPolicyName: `Gen3-${project}-${envName}-S3UploadsRW`,
                statements: [
                    new iam.PolicyStatement({
                        actions: ["s3:PutObject", "s3:GetObject", "s3:DeleteObject", "s3:AbortMultipartUpload"],
                        resources: [`arn:aws:s3:::${uploadsBucketName}/*`],
                        conditions: { Bool: { "aws:SecureTransport": "true" } },
                    }),
                    new iam.PolicyStatement({
                        actions: ["s3:ListBucket"],
                        resources: [`arn:aws:s3:::${uploadsBucketName}`],
                        conditions: { StringLike: { "s3:prefix": ["uploads/*", "processed/*"] } },
                    }),
                ],
            });
        }

        if (manifestBucketName) {
            managed.ManifestRW = new iam.ManagedPolicy(this, "ManifestRW", {
                managedPolicyName: `Gen3-${project}-${envName}-ManifestRW`,
                statements: [
                    new iam.PolicyStatement({ actions: ["s3:GetObject", "s3:PutObject"], resources: [`arn:aws:s3:::${manifestBucketName}/*`] }),
                    new iam.PolicyStatement({ actions: ["s3:ListBucket"], resources: [`arn:aws:s3:::${manifestBucketName}`] }),
                ],
            });
        }

        if (sqsQueueArn) {
            managed.SqsConsume = new iam.ManagedPolicy(this, "SqsConsume", {
                managedPolicyName: `Gen3-${project}-${envName}-SqsConsume`,
                statements: [
                    new iam.PolicyStatement({
                        actions: ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:GetQueueUrl", "sqs:ListQueueTags", "sqs:ListDeadLetterSourceQueues"],
                        resources: [sqsQueueArn],
                    }),
                ],
            });
        }

        if (esDomainArn) {
            managed.EsHttp = new iam.ManagedPolicy(this, "EsHttp", {
                managedPolicyName: `Gen3-${project}-${envName}-EsHttpAccess`,
                statements: [
                    new iam.PolicyStatement({ actions: ["es:ESHttpGet", "es:ESHttpHead", "es:ESHttpPost", "es:ESHttpPut", "es:ESHttpDelete", "es:ESHttpPatch"], resources: [`${esDomainArn}/*`] }),
                    new iam.PolicyStatement({ actions: ["es:DescribeDomain", "es:DescribeDomains", "es:ListDomainNames"], resources: ["*"] }),
                ],
            });
        }

        // Helper to create roles
        const mk = (svc: string, sa: string, attach: (iam.IManagedPolicy | undefined)[], inline: iam.PolicyStatementProps[] = []) => {
            const role = new iam.Role(this, `${svc}Role`, {
                roleName: roleName(svc),
                path: `/gen3/${project}/${envName}/`,
                assumedBy: irsa(sa),
                permissionsBoundary: boundary,
                description: `IRSA for ${namespace}/${sa} (${project}-${envName})`,
            });
            attach.filter(Boolean).forEach(m => role.addManagedPolicy(m!));
            inline.forEach(s => role.addToPolicy(new iam.PolicyStatement(s)));
            // minimal tags (pull clusterName from SSM)
            const clusterName = P(this, `${base}/clusterName`);
            cdk.Tags.of(role).add("Project", project);
            cdk.Tags.of(role).add("Environment", envName);
            cdk.Tags.of(role).add("KubernetesNamespace", namespace);
            cdk.Tags.of(role).add("KubernetesServiceAccount", sa);
            cdk.Tags.of(role).add("ClusterName", clusterName);
            return role;
        };

        // === Roles (auto-skip blocks if SSM value missing) ===
        if (managed.S3UploadsRW) {
            const inline: iam.PolicyStatementProps[] = [];
            if (kmsDataKeyArn) inline.push({ actions: ["kms:Decrypt"], resources: [kmsDataKeyArn] });
            if (fenceDbSecretArn) inline.push({ actions: ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"], resources: [fenceDbSecretArn] });

            mk("fence", "fence-sa", [managed.S3UploadsRW], inline);
        }

        if (managed.SqsConsume && managed.S3UploadsRW) {
            mk("ssjdispatcher", "ssjdispatcher-service-account", [managed.SqsConsume, managed.S3UploadsRW]);
            mk("ssjdispatcher-job", "ssjdispatcher-job-sa", [managed.SqsConsume, managed.S3UploadsRW]);
        }

        if (managed.ManifestRW) mk("manifest", "manifest-service", [managed.ManifestRW]);
        if (managed.EsHttp) mk("aws-es-proxy", "aws-es-proxy-sa", [managed.EsHttp]);

        // Hatchery (optional pattern-based IAM users)
        const nfPrefix = tryParam(this, `${base}/iam/nfUserArnPrefix`); // publish this if you like
        if (nfPrefix) {
            const nfList = new iam.ManagedPolicy(this, "NfListAccessKeys", {
                managedPolicyName: `Gen3-${project}-${envName}-NfListAccessKeys`,
                statements: [new iam.PolicyStatement({ actions: ["iam:ListAccessKeys"], resources: [nfPrefix] })],
            });
            mk("hatchery", "hatchery-service-account", [nfList]);
        }
    }
}
