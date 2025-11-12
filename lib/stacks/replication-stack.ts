import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as iam from "aws-cdk-lib/aws-iam";

export interface ReplicationRuleInput {
    sourceBucket: s3.Bucket;   // real L2 bucket (not imported)
    destBucketArn: string;     // arn:aws:s3:::bucket or :::bucket/prefix
    destKmsKeyArn: string;
    id?: string;
    prefix?: string;
}

export interface ReplicationStackProps extends cdk.StackProps {
    backupAccountId: string;
    rules: ReplicationRuleInput[]; // one entry per bucket (or per prefix)
    /**
     * ARN of the replication role created in the infra stack.
     * This should be imported via Fn.importValue() from the source stack's export.
     */
    replicationRoleArn: string;
}

export class ReplicationStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: ReplicationStackProps) {
        super(scope, id, props);

        // Import the replication role from the source stack
        // Use mutable: true to allow adding policies
        const replRole = iam.Role.fromRoleArn(
            this,
            "ImportedReplicationRole",
            props.replicationRoleArn,
            {
                mutable: true,
            }
        );

        // Grant destination bucket permissions for each rule
        for (const r of props.rules) {
            // Add permissions for destination bucket
            replRole.addToPrincipalPolicy(new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: [
                    "s3:ReplicateObject",
                    "s3:ReplicateDelete",
                    "s3:ReplicateTags",
                    "s3:GetObjectVersionTagging",
                    "s3:ObjectOwnerOverrideToBucketOwner",
                ],
                resources: [`${r.destBucketArn}/*`],
            }));

            // Add KMS permissions for destination encryption
            replRole.addToPrincipalPolicy(new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: [
                    "kms:Decrypt",
                    "kms:Encrypt",
                    "kms:ReEncrypt*",
                    "kms:GenerateDataKey*",
                    "kms:DescribeKey",
                ],
                resources: [r.destKmsKeyArn],
            }));
        }

        // Assign replicationConfiguration once per bucket
        for (const r of props.rules) {
            const cfn = r.sourceBucket.node.defaultChild as s3.CfnBucket;
            // IMPORTANT: ensure versioning enabled on the L2 bucket definition:
            //   new s3.Bucket(..., { versioned: true, ... })
            const rule: s3.CfnBucket.ReplicationRuleProperty = {
                id: r.id ?? `${r.sourceBucket.bucketName}-to-backup`,
                status: "Enabled",
                priority: 1,
                filter: { prefix: r.prefix ?? "" },
                deleteMarkerReplication: { status: "Disabled" },
                destination: {
                    bucket: r.destBucketArn,
                    account: props.backupAccountId,
                    accessControlTranslation: { owner: "Destination" },
                    encryptionConfiguration: { replicaKmsKeyId: r.destKmsKeyArn },
                    metrics: { status: "Enabled" },
                },
            };
            cfn.replicationConfiguration = {
                role: props.replicationRoleArn, // Use the imported role ARN
                rules: [rule],
            } as s3.CfnBucket.ReplicationConfigurationProperty;
        }
    }
}