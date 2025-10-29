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
}

export class ReplicationStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: ReplicationStackProps) {
        super(scope, id, props);

        // One role used by all replication rules
        const replRole = new iam.Role(this, "S3ReplicationRole", {
            assumedBy: new iam.ServicePrincipal("s3.amazonaws.com"),
            description: "Allows S3 to replicate objects to backup account buckets",
        });

        // Grant S3 perms for each source bucket
        for (const r of props.rules) {
            replRole.addToPolicy(new iam.PolicyStatement({
                actions: ["s3:GetReplicationConfiguration", "s3:ListBucket"],
                resources: [r.sourceBucket.bucketArn],
            }));
            replRole.addToPolicy(new iam.PolicyStatement({
                actions: [
                    "s3:GetObjectVersion",
                    "s3:GetObjectVersionAcl",
                    "s3:GetObjectVersionTagging",
                    "s3:ReplicateObject",
                    "s3:ReplicateDelete",
                    "s3:ReplicateTags",
                    "s3:ObjectOwnerOverrideToBucketOwner",
                ],
                resources: [`${r.sourceBucket.bucketArn}/*`],
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
                role: replRole.roleArn,
                rules: [rule],
            } as s3.CfnBucket.ReplicationConfigurationProperty;
        }
    }
}
