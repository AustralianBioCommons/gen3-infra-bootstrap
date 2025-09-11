import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";
import { readRequired, readOptional, slug } from "../utils/ssm";

export interface Gen3IamStackProps extends cdk.StackProps {
    /** Project key, e.g. "acdc", "omix3" */
    project: string;
    /** Environment key, e.g. "prod", "test" (ignored if envKey is given) */
    envName: string;
    /** Kubernetes namespace for these services, e.g. "omix3" */
    namespace: string;
    /** Optional override: full SSM base key, e.g. "acdc-prodacdc". If set, we read from /gen3/<envKey> */
    envKey?: string;
    /** Optional: name of a permissions boundary to apply to all roles */
    permissionBoundaryName?: string;
}

export class Gen3IamStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: Gen3IamStackProps) {
        super(scope, id, props);

        const project = slug(props.project);
        const envName = slug(props.envKey ?? props.envName);
        const namespace = props.namespace;
        const base = props.envKey
            ? `/gen3/${props.envKey}`
            : `/gen3/${project}-${envName}`;

        // ---- Core SSM (required)
        const issuer = readRequired(this, `${base}/oidcIssuer`);        // hostpath only
        const providerArn = readRequired(this, `${base}/oidcProviderArn`);
        const clusterName = readRequired(this, `${base}/clusterName`);

        // ---- Optional SSM (policy inputs)
        const uploadsBucketName = readOptional(this, `${base}/s3/uploadsBucketName`);
        const manifestBucketName = readOptional(this, `${base}/s3/manifestBucketName`);
        const sqsQueueArn = readOptional(this, `${base}/sqs/ssjdispatcherQueueArn`);
        const esDomainArn = readOptional(this, `${base}/opensearch/domainArn`);
        const kmsDataKeyArn = readOptional(this, `${base}/kms/dataKeyArn`);
        const fenceDbSecretArn = readOptional(this, `${base}/secrets/fenceDbArn`);
        const nfUserArnPrefix = readOptional(this, `${base}/iam/nfUserArnPrefix`);

        // ---- Helpers
        const roleName = (svc: string) => `gen3-${project}-${envName}-${slug(svc)}-role`;
        const boundary = props.permissionBoundaryName
            ? iam.ManagedPolicy.fromManagedPolicyName(this, "Gen3PB", props.permissionBoundaryName)
            : undefined;

        // Build FederatedPrincipal with CfnJson so we can use the (token) issuer as a JSON key
        const makeIrsaPrincipal = (sa: string) => {
            const idSafe = slug(`${project}-${envName}-${namespace}-${sa}`);
            const stringEquals = new cdk.CfnJson(this, `IrsaCond-${idSafe}`, {
                value: {
                    [`${issuer}:aud`]: "sts.amazonaws.com",
                    [`${issuer}:sub`]: `system:serviceaccount:${namespace}:${sa}`,
                },
            });
            return new iam.FederatedPrincipal(
                providerArn,
                { StringEquals: stringEquals } as any,
                "sts:AssumeRoleWithWebIdentity",
            );
        };

        const tagRole = (role: iam.Role, sa: string) => {
            cdk.Tags.of(role).add("Project", project);
            cdk.Tags.of(role).add("Environment", envName);
            cdk.Tags.of(role).add("KubernetesNamespace", namespace);
            cdk.Tags.of(role).add("KubernetesServiceAccount", sa);
            cdk.Tags.of(role).add("ClusterName", clusterName);
        };

        // ---- Managed policy blocks (create only when inputs exist)
        const managed: Partial<Record<"S3UploadsRW" | "ManifestRW" | "SqsConsume" | "EsHttp", iam.ManagedPolicy>> = {};

        if (uploadsBucketName) {
            managed.S3UploadsRW = new iam.ManagedPolicy(this, "Gen3S3UploadsRW", {
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
            managed.ManifestRW = new iam.ManagedPolicy(this, "Gen3ManifestRW", {
                managedPolicyName: `Gen3-${project}-${envName}-ManifestRW`,
                statements: [
                    new iam.PolicyStatement({
                        actions: ["s3:GetObject", "s3:PutObject"],
                        resources: [`arn:aws:s3:::${manifestBucketName}/*`],
                        conditions: { Bool: { "aws:SecureTransport": "true" } },
                    }),
                    new iam.PolicyStatement({
                        actions: ["s3:ListBucket"],
                        resources: [`arn:aws:s3:::${manifestBucketName}`],
                    }),
                ],
            });
        }

        if (sqsQueueArn) {
            managed.SqsConsume = new iam.ManagedPolicy(this, "Gen3SqsConsume", {
                managedPolicyName: `Gen3-${project}-${envName}-SqsConsume`,
                statements: [
                    new iam.PolicyStatement({
                        actions: [
                            "sqs:ReceiveMessage", "sqs:DeleteMessage",
                            "sqs:GetQueueAttributes", "sqs:GetQueueUrl",
                            "sqs:ListQueueTags", "sqs:ListDeadLetterSourceQueues",
                        ],
                        resources: [sqsQueueArn],
                    }),
                ],
            });
        }

        if (esDomainArn) {
            managed.EsHttp = new iam.ManagedPolicy(this, "Gen3EsHttpAccess", {
                managedPolicyName: `Gen3-${project}-${envName}-EsHttpAccess`,
                statements: [
                    new iam.PolicyStatement({
                        actions: ["es:ESHttpGet", "es:ESHttpHead", "es:ESHttpPost", "es:ESHttpPut", "es:ESHttpDelete", "es:ESHttpPatch"],
                        resources: [`${esDomainArn}/*`],
                    }),
                    new iam.PolicyStatement({
                        actions: ["es:DescribeDomain", "es:DescribeDomains", "es:ListDomainNames"],
                        resources: ["*"],
                    }),
                ],
            });
        }

        // ---- Role factory
        const mk = (svc: string, sa: string, attach: (iam.IManagedPolicy | undefined)[], inline: iam.PolicyStatementProps[] = []) => {
            const role = new iam.Role(this, `${slug(svc)}Role`, {
                roleName: roleName(svc),
                path: `/gen3/${project}/${envName}/`,
                assumedBy: makeIrsaPrincipal(sa),
                permissionsBoundary: boundary,
                description: `IRSA for ${namespace}/${sa} (${project}-${envName})`,
            });
            attach.filter(Boolean).forEach(m => role.addManagedPolicy(m!));
            inline.forEach(s => role.addToPolicy(new iam.PolicyStatement(s)));
            tagRole(role, sa);
            return role;
        };

        // ---- Roles (created only if their policy inputs exist)

        // fence (needs uploads bucket; optional KMS/Secrets)
        if (managed.S3UploadsRW) {
            const inline: iam.PolicyStatementProps[] = [];
            if (kmsDataKeyArn) inline.push({ actions: ["kms:Decrypt"], resources: [kmsDataKeyArn] });
            if (fenceDbSecretArn) inline.push({
                actions: ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"],
                resources: [fenceDbSecretArn],
            });
            mk("fence", "fence-sa", [managed.S3UploadsRW], inline);
        }

        // ssjdispatcher (svc + job) needs SQS + uploads bucket
        if (managed.SqsConsume && managed.S3UploadsRW) {
            mk("ssjdispatcher", "ssjdispatcher-service-account", [managed.SqsConsume, managed.S3UploadsRW]);
            mk("ssjdispatcher-job", "ssjdispatcher-job-sa", [managed.SqsConsume, managed.S3UploadsRW]);
        }

        // manifest
        if (managed.ManifestRW) {
            mk("manifest", "manifest-service", [managed.ManifestRW]);
        }

        // aws-es-proxy
        if (managed.EsHttp) {
            mk("aws-es-proxy", "aws-es-proxy-sa", [managed.EsHttp]);
        }

        // hatchery (optional user pattern param)
        if (nfUserArnPrefix) {
            const nfList = new iam.ManagedPolicy(this, "Gen3NfListAccessKeys", {
                managedPolicyName: `Gen3-${project}-${envName}-NfListAccessKeys`,
                statements: [new iam.PolicyStatement({ actions: ["iam:ListAccessKeys"], resources: [nfUserArnPrefix] })],
            });
            mk("hatchery", "hatchery-service-account", [nfList]);
        }
    }
}
