import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as s3 from "aws-cdk-lib/aws-s3";

export interface ReplicationRuleInput {
    sourceBucket: s3.Bucket;   // real L2 bucket (not imported)
    destBucketArn: string;     // arn:aws:s3:::bucket or arn:aws:s3:::bucket/prefix
    destKmsKeyArn: string;
    id?: string;
    prefix?: string;
}

export interface ReplicationStackProps extends cdk.StackProps {
    backupAccountId: string;
    rules: ReplicationRuleInput[]; // one entry per bucket (or per prefix)
    /**
     * Full ARN of the replication role created in the infra/source stack.
     * Example: arn:aws:iam::111122223333:role/gen3-acdc-prod-s3-replication-role
     */
    replicationRoleArn: string;
}

export class ReplicationStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: ReplicationStackProps) {
        super(scope, id, props);

        const replicationRoleArn = props.replicationRoleArn; // Use the provided ARN directly

        // Assign replicationConfiguration once per source bucket
        for (const r of props.rules) {
            const cfn = r.sourceBucket.node.defaultChild as s3.CfnBucket;

            const rule: s3.CfnBucket.ReplicationRuleProperty = {
                id: r.id ?? `${r.sourceBucket.bucketName}-to-backup`,
                status: "Enabled",
                priority: 1,
                filter: { prefix: r.prefix ?? "" },
                deleteMarkerReplication: { status: "Disabled" },
                sourceSelectionCriteria: {
                    sseKmsEncryptedObjects: { status: "Enabled" },
                },
                destination: {
                    bucket: r.destBucketArn,
                    account: props.backupAccountId,
                    accessControlTranslation: { owner: "Destination" },
                    encryptionConfiguration: { replicaKmsKeyId: r.destKmsKeyArn },
                    metrics: { status: "Enabled" },
                },
            };

            // Use the literal ARN here. Do NOT import the Role object or attach policies to it.
            cfn.replicationConfiguration = {
                role: replicationRoleArn,
                rules: [rule],
            } as s3.CfnBucket.ReplicationConfigurationProperty;
        }
    }
}
