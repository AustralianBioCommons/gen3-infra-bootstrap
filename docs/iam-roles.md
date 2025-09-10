# Gen3 IAM & IRSA --- SSM Contract

This repo uses **AWS Systems Manager Parameter Store** as the contract between stacks:

- **Producers** (EKS, S3, SQS, OpenSearch, KMS, Secrets) **write** their identifiers to SSM **at creation time**.

- The **IAM (IRSA) stack** **reads** those parameters and creates **one IAM role per Kubernetes ServiceAccount** with tight OIDC trust and least-privilege policies.

- No ARNs or names are passed manually between stacks.

---

## SSM Registry (per project + env)

All keys live under:

`/gen3/<project>-<env>/*`

| Key                             | Example                                                 | Written by       | Read by | Notes                             |
| ------------------------------- | ------------------------------------------------------- | ---------------- | ------- | --------------------------------- |
| `clusterName`                   | `omix3-test`                                            | EKS/OIDC add-on  | IAM     | Tagging/audit                     |
| `oidcIssuer`                    | `oidc.eks.ap-southeast-2.amazonaws.com/id/XXXX`         | EKS/OIDC add-on  | IAM     | **Hostpath only** (no `https://`) |
| `oidcProviderArn`               | `arn:aws:iam::<acct>:oidc-provider/oidc.eks.../id/XXXX` | EKS/OIDC add-on  | IAM     | Used as `Principal.Federated`     |
| `s3/uploadsBucketName`          | `gen3-data-upload-...`                                  | S3 stack         | IAM     | Uploads/data bucket               |
| `s3/manifestBucketName`         | `manifest-...`                                          | S3 stack         | IAM     | Manifest service                  |
| `sqs/ssjdispatcherQueueArn`     | `arn:aws:sqs:...:ssj-dispatcher-queue-...`              | SQS stack        | IAM     | ssjdispatcher consumer            |
| `opensearch/domainArn`          | `arn:aws:es:...:domain/...`                             | OpenSearch stack | IAM     | aws-es-proxy HTTP access          |
| `kms/dataKeyArn` (optional)     | `arn:aws:kms:...:key/...`                               | KMS stack        | IAM     | Fence decrypt                     |
| `secrets/fenceDbArn` (optional) | `arn:aws:secretsmanager:...:secret:...`                 | Secrets stack    | IAM     | Database creds, etc.              |

> Add additional keys in the same prefix when new services are introduced.

---

## Naming & Tagging

- **Role name:** `gen3-<project>-<env>-<service>-role`\
  _e.g._ `gen3-omix3-test-ssjdispatcher-role`

- **IAM path:** `/gen3/<project>/<env>/`

- **Tags (every role):**\
  `Project`, `Environment`, `KubernetesNamespace`, `KubernetesServiceAccount`, `ClusterName` (read from SSM)

---

## IRSA Trust (per ServiceAccount)

For each ServiceAccount `<namespace>/<sa>`:

- `Principal.Federated` → `/gen3/<project>-<env>/oidcProviderArn`

- `Condition.StringEquals`:

  - `"<issuer>:aud" = "sts.amazonaws.com"`

  - `"<issuer>:sub" = "system:serviceaccount:<namespace>:<sa>"`

- `<issuer>` is `/gen3/<project>-<env>/oidcIssuer` (hostpath, no scheme)

---

## Managed Policy Blocks

Create small, reusable policies **per project/env** and attach them to roles:

- `Gen3-<project>-<env>-S3UploadsRW` -- RW on `arn:aws:s3:::<uploadsBucket>/*` + scoped `ListBucket`

- `Gen3-<project>-<env>-SqsConsume` -- SQS consume on the ssjdispatcher queue ARN

- `Gen3-<project>-<env>-ManifestRW` -- RW on the manifest bucket (no deletes by default)

- `Gen3-<project>-<env>-EsHttpAccess` -- `es:ESHttp*` on `<domainArn>/*`

Use **inline** statements for one-offs (e.g., a specific KMS key or Secret ARN).

---

## Deployment Flow (greenfield)

1.  **Cluster & OIDC**

    - Create EKS.

    - OIDC add-on writes:

      - `/gen3/<project>-<env>/clusterName`

      - `/gen3/<project>-<env>/oidcIssuer` (no `https://`)

      - `/gen3/<project>-<env>/oidcProviderArn`

2.  **Foundation resources**

    - Create S3, SQS, OpenSearch, KMS, Secrets.

    - Each stack writes its SSM entry (see below).

3.  **IAM (IRSA) stack**

    - Reads `/gen3/<project>-<env>/*`, creates roles, and attaches policy blocks.

4.  **Workloads**

    - Annotate ServiceAccounts with role ARNs and roll deployments:

      `metadata:
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::<acct>:role/gen3-<project>-<env>-<service>-role`

---

## Producers: write to SSM at resource creation (CDK examples)

`import \* as ssm from "aws-cdk-lib/aws-ssm";

// S3
new ssm.StringParameter(this, "UploadsBucketName", {
parameterName: `/gen3/${project}-${env}/s3/uploadsBucketName`,
stringValue: uploadsBucket.bucketName,
});
new ssm.StringParameter(this, "ManifestBucketName", {
parameterName: `/gen3/${project}-${env}/s3/manifestBucketName`,
stringValue: manifestBucket.bucketName,
});

// SQS
new ssm.StringParameter(this, "SsjQueueArn", {
parameterName: `/gen3/${project}-${env}/sqs/ssjdispatcherQueueArn`,
stringValue: ssjQueue.queueArn,
});

// OpenSearch
new ssm.StringParameter(this, "OsDomainArn", {
parameterName: `/gen3/${project}-${env}/opensearch/domainArn`,
stringValue: osDomain.domainArn,
});

// KMS (optional)
new ssm.StringParameter(this, "DataKeyArn", {
parameterName: `/gen3/${project}-${env}/kms/dataKeyArn`,
stringValue: dataKey.keyArn,
});

// (EKS/OIDC add-on already writes clusterName, oidcIssuer, oidcProviderArn)`

---

## IAM Stack (auto-discovery, CDK sketch)

`import _ as iam from "aws-cdk-lib/aws-iam";
import _ as ssm from "aws-cdk-lib/aws-ssm";
import { Stack } from "aws-cdk-lib";

const base = `/gen3/${project}-${env}`;
const issuer = ssm.StringParameter.valueForStringParameter(this, `${base}/oidcIssuer`);
const providerArn = ssm.StringParameter.valueForStringParameter(this, `${base}/oidcProviderArn`);

const uploadsBucket = ssm.StringParameter.valueForStringParameter(this, `${base}/s3/uploadsBucketName`);
const sqsQueueArn = ssm.StringParameter.valueForStringParameter(this, `${base}/sqs/ssjdispatcherQueueArn`);

const irsa = (ns: string, sa: string) =>
new iam.FederatedPrincipal(
providerArn,
{ StringEquals: { [`${issuer}:aud`]: "sts.amazonaws.com", [`${issuer}:sub`]: `system:serviceaccount:${ns}:${sa}` } },
"sts:AssumeRoleWithWebIdentity"
);

// Example managed policy blocks
const s3Uploads = new iam.ManagedPolicy(this, "Gen3ProjEnvS3UploadsRW", {
managedPolicyName: `Gen3-${project}-${env}-S3UploadsRW`,
statements: [
new iam.PolicyStatement({
actions: ["s3:PutObject","s3:GetObject","s3:DeleteObject","s3:AbortMultipartUpload"],
resources: [`arn:aws:s3:::${uploadsBucket}/*`],
conditions: { Bool: { "aws:SecureTransport": "true" } },
}),
new iam.PolicyStatement({
actions: ["s3:ListBucket"],
resources: [`arn:aws:s3:::${uploadsBucket}`],
conditions: { StringLike: { "s3:prefix": ["uploads/*","processed/*"] } },
}),
],
});

const sqsConsume = new iam.ManagedPolicy(this, "Gen3ProjEnvSqsConsume", {
managedPolicyName: `Gen3-${project}-${env}-SqsConsume`,
statements: [
new iam.PolicyStatement({
actions: ["sqs:ReceiveMessage","sqs:DeleteMessage","sqs:GetQueueAttributes","sqs:GetQueueUrl","sqs:ListQueueTags","sqs:ListDeadLetterSourceQueues"],
resources: [sqsQueueArn],
}),
],
});

// Example role (ssjdispatcher)
const role = new iam.Role(this, "SsjdispatcherRole", {
roleName: `gen3-${project}-${env}-ssjdispatcher-role`,
path: `/gen3/${project}/${env}/`,
assumedBy: irsa("omix3", "ssjdispatcher-service-account"),
description: "IRSA role for ssjdispatcher",
});
role.addManagedPolicy(s3Uploads);
role.addManagedPolicy(sqsConsume);`

---

## Security Baselines

- **One role per ServiceAccount** (no shared trust lists).

- **S3:** object actions on `arn:aws:s3:::bucket/*`; `ListBucket` separately on the bucket ARN with `s3:prefix` conditions; enforce TLS via `aws:SecureTransport`.

- **OpenSearch:** prefer `es:ESHttp*` (HTTP API) over `es:*`.

- **Secrets/KMS:** scope to specific ARNs; avoid wildcards.

- **Permission Boundary** (recommended): apply a boundary policy to all Gen3 roles to prevent privilege escalation.

---

## Troubleshooting

- **Missing SSM key:** the IAM stack will skip policy blocks that depend on absent keys. Ensure the producer writes the key, then re-deploy IAM.

- **IRSA trust errors:** confirm `oidcIssuer` (hostpath only) and `oidcProviderArn` are present under the correct prefix.
