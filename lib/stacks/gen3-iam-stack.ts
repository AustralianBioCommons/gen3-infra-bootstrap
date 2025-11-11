import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import { readRequired, readOptional, slug } from "../utils/ssm";
import { bucketSafeFromHostname } from "../utils/names";

export interface Gen3IamStackProps extends cdk.StackProps {
    /** Project key, e.g. "acdc", "omix3" */
    project: string;
    /** Environment key, e.g. "prod", "test" (ignored if envKey is given) */
    envName: string;
    /** Kubernetes namespace for these services, e.g. "omix3" */
    namespace: string;
    /** Optional override: full SSM base key. If set, we read from /gen3/<envKey> */
    envKey?: string;
    /** Optional: name of a permissions boundary to apply to all roles */
    permissionBoundaryName?: string;
    /** Hostname to derive user pattern for hatchery role (required) */
    hostname: string;
}

export class Gen3IamStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: Gen3IamStackProps) {
        super(scope, id, props);

        const project = slug(props.project);
        const envName = slug(props.envKey ?? props.envName);
        const namespace = props.namespace;
        const hostname = props.hostname;
        if (!hostname) {
            throw new Error("Gen3IamStack: hostname is required");
        }
        const base = props.envKey ? `/gen3/${props.envKey}` : `/gen3/${project}-${envName}`;

        // ---- Core SSM (required)
        const issuer = readRequired(this, `${base}/oidcIssuer`);        // hostpath only
        const providerArn = readRequired(this, `${base}/oidcProviderArn`);
        const clusterName = readRequired(this, `${base}/clusterName`);

        // ---- Optional SSM (policy inputs)
        const uploadsBucketName = readOptional(this, `${base}/s3/uploadsBucketName`);
        const manifestBucketName = readOptional(this, `${base}/s3/manifestBucketName`);
        const sqsQueueArn = readOptional(this, `${base}/sqs/ssjdispatcherQueueArn`);
        const esDomainArn = readOptional(this, `${base}/opensearch/domainArn`);

        // KMS key ARNs written by InfraStack (optional but recommended)
        const uploadsKmsKeyArn = readOptional(this, `${base}/kms/uploadsKeyArn`);
        const manifestKmsKeyArn = readOptional(this, `${base}/kms/manifestKeyArn`);
        // If you later add pelican S3/KMS access for Gen3 roles, read:
        // const pelicanKmsKeyArn = readOptional(this, `${base}/kms/pelicanKeyArn`);

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

        // KMS helper: tight allow bound to S3 service + this bucket via encryption context
        const kmsViaS3Stmt = (actions: string[], kmsArn: string, bucketName: string): iam.PolicyStatement =>
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions,
                resources: [kmsArn],
                conditions: {
                    StringEquals: { "kms:ViaService": `s3.${cdk.Stack.of(this).region}.amazonaws.com` },
                    StringLike: { "kms:EncryptionContext:aws:s3:arn": `arn:${cdk.Stack.of(this).partition}:s3:::${bucketName}/*` },
                },
            });

        // ---- Managed policy blocks (create only when inputs exist)
        const managed: Partial<Record<
            "S3UploadsRW" | "ManifestRW" | "SqsConsume" | "EsHttp" | "ExternalSecretsRead",
            iam.ManagedPolicy
        >> = {};

        managed.ExternalSecretsRead = new iam.ManagedPolicy(this, "Gen3ExternalSecretsRead", {
            managedPolicyName: `Gen3-${project}-${envName}-ExternalSecretsRead`,
            statements: [
                new iam.PolicyStatement({
                    effect: iam.Effect.ALLOW,
                    actions: [
                        "kms:Decrypt",
                        "secretsmanager:DescribeSecret",
                        "secretsmanager:GetResourcePolicy",
                        "secretsmanager:GetSecretValue",
                        "secretsmanager:ListSecretVersionIds",
                        "secretsmanager:ListSecrets",
                        "ssm:DescribeParameters",
                        "ssm:GetParameter",
                        "ssm:GetParameterHistory",
                        "ssm:GetParameters",
                        "ssm:GetParametersByPath",
                    ],
                    resources: ["*"],
                }),
            ],
        });

        if (uploadsBucketName) {
            managed.S3UploadsRW = new iam.ManagedPolicy(this, "Gen3S3UploadsRW", {
                managedPolicyName: `Gen3-${project}-${envName}-S3UploadsRW`,
                statements: [
                    new iam.PolicyStatement({
                        actions: ["s3:PutObject", "s3:GetObject", "s3:DeleteObject", "s3:AbortMultipartUpload"],
                        resources: [`arn:${cdk.Stack.of(this).partition}:s3:::${uploadsBucketName}/*`],
                        conditions: { Bool: { "aws:SecureTransport": "true" } },
                    }),
                    new iam.PolicyStatement({
                        actions: ["s3:ListBucket"],
                        resources: [`arn:${cdk.Stack.of(this).partition}:s3:::${uploadsBucketName}`],
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
                        resources: [`arn:${cdk.Stack.of(this).partition}:s3:::${manifestBucketName}/*`],
                        conditions: { Bool: { "aws:SecureTransport": "true" } },
                    }),
                    new iam.PolicyStatement({
                        actions: ["s3:ListBucket"],
                        resources: [`arn:${cdk.Stack.of(this).partition}:s3:::${manifestBucketName}`],
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

        // ---- Role factory (inline accepts ready PolicyStatements)
        const mk = (svc: string, sa: string, attach: (iam.IManagedPolicy | undefined)[], inline: iam.PolicyStatement[] = []) => {
            const role = new iam.Role(this, `${slug(svc)}Role`, {
                roleName: roleName(svc),
                path: `/gen3/${project}/${envName}/`,
                assumedBy: makeIrsaPrincipal(sa),
                permissionsBoundary: boundary,
                description: `IRSA for ${namespace}/${sa} (${project}-${envName})`,
            });
            attach.filter(Boolean).forEach(m => role.addManagedPolicy(m!));
            inline.forEach(stmt => role.addToPolicy(stmt));
            tagRole(role, sa);
            return role;
        };

        // ---- Roles (created only if their policy inputs exist)

        // fence (needs uploads bucket; KMS Encrypt+Decrypt+DataKey via S3 on uploads key)
        if (managed.S3UploadsRW && uploadsBucketName) {
            const inline: iam.PolicyStatement[] = [];
            if (uploadsKmsKeyArn) {
                inline.push(
                    kmsViaS3Stmt(
                        ["kms:Encrypt", "kms:Decrypt", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:DescribeKey"],
                        uploadsKmsKeyArn,
                        uploadsBucketName
                    )
                );
            }
            const fenceRole = mk("fence", "fence-sa", [managed.S3UploadsRW], inline);

            // Literal self-assume (no token reference) - keeps it cycle-safe
            const rolePath = `/gen3/${project}/${envName}/`;
            const selfArnLiteral =
                `arn:${cdk.Stack.of(this).partition}:iam::${this.account}:role${rolePath}${roleName("fence")}`;
            fenceRole.assumeRolePolicy!.addStatements(
                new iam.PolicyStatement({
                    effect: iam.Effect.ALLOW,
                    principals: [new iam.ArnPrincipal(selfArnLiteral)],
                    actions: ["sts:AssumeRole"],
                })
            );
        }

        // ssjdispatcher (svc + job): SQS consume + uploads read; needs KMS Decrypt on uploads key
        if (managed.SqsConsume && managed.S3UploadsRW && uploadsBucketName) {
            const ssjInline: iam.PolicyStatement[] = [];
            if (uploadsKmsKeyArn) {
                ssjInline.push(
                    kmsViaS3Stmt(["kms:Decrypt", "kms:DescribeKey"], uploadsKmsKeyArn, uploadsBucketName)
                );
            }
            mk("ssjdispatcher", "ssjdispatcher-service-account", [managed.SqsConsume, managed.S3UploadsRW], ssjInline);
            mk("ssjdispatcher-job", "ssjdispatcher-job-sa", [managed.SqsConsume, managed.S3UploadsRW], ssjInline);
        }

        // manifest: writes manifest objects; needs KMS Encrypt + DataKey on manifest key
        if (managed.ManifestRW && manifestBucketName) {
            const manifestInline: iam.PolicyStatement[] = [];
            if (manifestKmsKeyArn) {
                manifestInline.push(
                    kmsViaS3Stmt(["kms:Encrypt", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:DescribeKey"],
                        manifestKmsKeyArn, manifestBucketName)
                );
            }
            mk("manifest", "manifest-service", [managed.ManifestRW], manifestInline);
        }

        // aws-es-proxy (unchanged)
        if (managed.EsHttp) {
            mk("aws-es-proxy", "aws-es-proxy-sa", [managed.EsHttp]);
        }

        // hatchery (example IAM read on specific users)
        const nfUser = bucketSafeFromHostname(hostname);
        const nfList = new iam.ManagedPolicy(this, "Gen3NfListAccessKeys", {
            managedPolicyName: `Gen3-${project}-${envName}-NfListAccessKeys`,
            statements: [
                new iam.PolicyStatement({
                    actions: ["iam:ListAccessKeys"],
                    resources: [`arn:${cdk.Stack.of(this).partition}:iam::${this.account}:user/${nfUser}-nf-*`],
                }),
            ],
        });
        mk("hatchery", "hatchery-service-account", [nfList]);

        // external-secrets (broad read per requirements)
        mk("external-secrets", "external-secrets-sa", [managed.ExternalSecretsRead]);
    }
}
