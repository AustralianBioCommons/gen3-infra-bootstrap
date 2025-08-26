gen3-infra-bootstrap
====================

Bootstrap shared **Gen3** infrastructure (S3/SQS/etc.) and seed **AWS Secrets Manager** entries consumed by **External Secrets Operator (ESO)** --- with a **strict create-if-missing** contract (no overwrites, no deletes).

-   **Open-source friendly:** no account/region or secrets stored in the repo.

-   **Env-driven:** `PROJECT`, `ENV_NAME`, `HOSTNAME` drive naming and outputs.

-   **Infra-aware:** secrets can embed the *actual* bucket names and SQS URLs you create here.

-   **Safe by default:** passwords are random **alphanumeric** (script-friendly). OIDC creds can be placeholders (`||`) until you supply real values.

* * * * *

Table of contents
-----------------

-   [What this repo creates](#what-this-repo-creates)

-   [Strict create-if-missing](#strict-create-if-missing)

-   [Requirements](#requirements)

-   [Quick start](#quick-start)

-   [Configuration (environment variables)](#configuration-environment-variables)

-   [Resources & naming](#resources--naming)

-   [Secrets produced (schema)](#secrets-produced-schema)

-   [g3auto bundles](#g3auto-bundles)

-   [External Secrets Operator (ESO) wiring](#external-secrets-operator-eso-wiring)

-   [Network & WAF (kept in a separate foundation repo)](#network--waf-kept-in-a-separate-foundation-repo)

-   [GitHub Actions (optional)](#github-actions-optional)

-   [Security notes](#security-notes)

-   [Rotation & deletion](#rotation--deletion)

-   [Repo layout](#repo-layout)

-   [License](#license)

* * * * *

What this repo creates
----------------------

**Infrastructure (examples; adjust as needed):**

-   An **S3** bucket for manifests (name derived from `HOSTNAME`, sanitized).

-   One or more **SQS** queues (e.g., audit queue, data-upload queue).

**Secrets in AWS Secrets Manager:**

-   Per-service DB credential secrets for:\
    `index, requestor, fence, peregrine, wts, audit, manifestservice, metadata, arborist, sheepdog`\
    using the name pattern:

    `<project>-<env>-<service>`

-   Optional **g3auto** secrets (toggle per environment):

    -   `<project>-<env>-metadata-g3auto`

    -   `<project>-<env>-wts-g3auto`

    -   `<project>-<env>-manifestservice-g3auto`

    -   `<project>-<env>-pelicanservice-g3auto` *(prefer IRSA; access keys optional)*

    -   `<project>-<env>-audit-gen3auto` *(YAML stored under `config.yaml`)*

    -   `<project>-<env>-ssjdispatcher-creds`

> DB `host`/`port` are read from the existing master DB secret:\
> **`<project>-master-<env>-rds`** (must contain JSON keys `host`, `port`).

* * * * *

Strict create-if-missing
------------------------

-   On each `cdk deploy`, a Lambda **custom resource** runs.

-   For every secret:

    -   If it **exists** → **left as-is** (no overwrite).

    -   If it's **missing** → created with generated or supplied content.

-   On `cdk destroy`, **secrets are not deleted**.

> To rotate a secret, **manually delete** it in Secrets Manager, then re-deploy.

* * * * *

Requirements
------------

-   **Node.js** 18+ (or 20+)

-   **AWS CDK v2**

-   AWS credentials (locally or via CI OIDC) with permissions to:

    -   create S3, SQS as needed

    -   read the master DB secret (`<project>-master-<env>-rds`)

    -   create new Secrets Manager secrets

* * * * *

Quick start
-----------
```
`# 1) Configure AWS credentials (locally) or use CI OIDC
export AWS_REGION=ap-southeast-2

# 2) Provide minimal env inputs (no account/region in code)
export PROJECT=omix3
export ENV_NAME=test
export HOSTNAME=omix3.test.biocommons.org.au

# Optional: feature toggles (CSV); optional OIDC creds (placeholders written if absent)
export FEATURES=metadataG3auto,wtsG3auto,manifestserviceG3auto,auditGen3auto,ssjdispatcherCreds
# export WTS_OIDC_CLIENT_ID=...
# export WTS_OIDC_CLIENT_SECRET=...

npm ci
npm run synth
npm run deploy`
```
> Ensure the master DB secret exists and has `{"host": "...", "port": 5432}` under the name **`<project>-master-<env>-rds`**.

* * * * *

Configuration (environment variables)
-------------------------------------

| Var | Required | Example | Notes |
| --- | --- | --- | --- |
| `PROJECT` | ✅ | `omix3` | Used in names: `<project>-<env>-...` |
| `ENV_NAME` | ✅ | `test` | Environment suffix in names |
| `HOSTNAME` | ✅ | `omix3.test.biocommons.org.au` | Used in g3auto and bucket naming |
| `FEATURES` | ➖ | `*metadata*G3auto...,ssjdispatcherCreds` | Enables optional g3auto bundles |
| `WTS_OIDC_CLIENT_ID` | ➖ | `abc123` | If absent, `wts-g3auto` writes placeholder ` |
| `WTS_OIDC_CLIENT_SECRET` | ➖ | `supersecret` | If absent, `wts-g3auto` writes placeholder ` |
| `CDK_DEFAULT_ACCOUNT`/
`CDK_DEFAULT_REGION` | ➖ | set by AWS creds | CDK picks these up automatically |

* * * * *

Resources & naming
------------------

-   **Secrets:** `<project>-<env>-<service>` (e.g., `omix3-test-metadata`)

-   **g3auto:** `<project>-<env>-<name>` (e.g., `omix3-test-manifestservice-g3auto`)

-   **S3 bucket:** `manifest-<hostname-sanitized>`\
    (e.g., `manifest-omix3-test-biocommons-org-au`)

    -   Hostnames are sanitized (dots → hyphens) to avoid TLS/VH quirkiness.

-   **SQS queues:** example names `audit-service-<project>-<env>`, `data-upload-<project>-<env>`

* * * * *

Secrets produced (schema)
-------------------------

### Per-service DB credentials

Name: `<project>-<env>-<service>`, payload:

`{
  "username": "<service>",
  "password": "<random-alnum>",
  "host": "<from master rds secret>",
  "port": "<from master rds secret>",
  "database": "<service>"
}`

Services covered (loop):

`index, requestor, fence, peregrine, wts, audit, manifestservice, metadata, arborist, sheepdog`

> Passwords are **alphanumeric** for bash/URL compatibility.

* * * * *

g3auto bundles
--------------

All are **create-if-missing**. Enable via `FEATURES` CSV.

-   **`metadata-g3auto`**

    -   Creates:

        -   `dbcreds.json` (metadata DB creds, generated password)

        -   `metadata.env` (includes `ADMIN_LOGINS=gateway:<generated>`)

        -   `base64Authz.txt` (base64 of `gateway:<generated>`)

-   **`wts-g3auto`**

    -   `appcreds.json` with:

        -   `wts_base_url` → default `https://<HOSTNAME>/wts/`

        -   `fence_base_url` → default `https://<HOSTNAME>/user/`

        -   `encryption_key` & `secret_key` → random base64

        -   `oidc_client_id` / `oidc_client_secret` → **placeholders `||`** if not provided

-   **`manifestservice-g3auto`**

    -   `{ "manifest_bucket_name": "<bucket>", "hostname": "<HOSTNAME>", "prefix": "" }`

-   **`pelicanservice-g3auto`**

    -   Same shape as manifestservice; optional *access keys* only if explicitly supplied (prefer **IRSA**).

-   **`audit-gen3auto`**

    -   Stores YAML under `"config.yaml"` with your SQS URL/region.

-   **`ssjdispatcher-creds`**

    -   Includes `AWS.region`, `SQS.url`, jobs array with Indexd/Metadata creds (generated if not supplied), and `pattern` (S3 prefix).