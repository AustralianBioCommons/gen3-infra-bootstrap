import { SecretsManagerClient, GetSecretValueCommand, CreateSecretCommand, DescribeSecretCommand, TagResourceCommand } from "@aws-sdk/client-secrets-manager";
import crypto from "crypto";

type Primitive = string | number | boolean | null;
type JSONValue = Primitive | JSONValue[] | { [key: string]: JSONValue };

const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const randomAlnum = (len: number) => {
  const b = crypto.randomBytes(len);
  let s = "";
  for (let i = 0; i < len; i++) s += ALNUM[b[i] % ALNUM.length];
  return s;
};
const randomBase64 = (lenBytes: number) => crypto.randomBytes(lenBytes).toString("base64");

const sm = new SecretsManagerClient({});

async function getSecretJson(secretId: string): Promise<Record<string, any>> {
  const res = await sm.send(new GetSecretValueCommand({ SecretId: secretId }));
  const str = res.SecretString ?? Buffer.from(res.SecretBinary ?? "", "base64").toString("utf8");
  return str ? JSON.parse(str) : {};
}

async function exists(secretId: string): Promise<boolean> {
  try {
    await sm.send(new DescribeSecretCommand({ SecretId: secretId }));
    return true;
  } catch (e: any) {
    if (e.name === "ResourceNotFoundException") return false;
    throw e;
  }
}

async function createIfMissing(
  name: string,
  payload: Record<string, JSONValue>,
  kmsKeyId?: string,
  tags?: Record<string, string>
): Promise<boolean> {
  if (await exists(name)) return false;
  const create = await sm.send(new CreateSecretCommand({
    Name: name,
    SecretString: JSON.stringify(payload),
    KmsKeyId: kmsKeyId,
  }));
  const tagList = tags ? Object.entries(tags).map(([Key, Value]) => ({ Key, Value })) : [];
  if (tagList.length) {
    await sm.send(new TagResourceCommand({ SecretId: create.ARN!, Tags: tagList }));
  }
  return true;
}

export const handler = async (event: any) => {
  const p = event.ResourceProperties || {};
  const {
    project, envName, services, masterSecretName, passwordLength, kmsKeyId, tags,
    dbHostOverride, dbPortOverride, create, g3auto
  } = p;

  if (event.RequestType === "Delete") {
    // Strictly do not delete secrets
    return { PhysicalResourceId: `gen3-secrets-${project}-${envName}` };
  }

  // Resolve DB host/port (override > master secret)
  let dbHost = dbHostOverride ?? null;
  let dbPort = dbPortOverride ?? null;
  if (!dbHost || !dbPort) {
    const master = await getSecretJson(masterSecretName);
    dbHost = dbHost ?? master.host;
    dbPort = dbPort ?? master.port;
  }
  if (!dbHost || !dbPort) throw new Error("Missing DB host/port (master secret or overrides)");

  const created: string[] = [];
  const pwLen = parseInt(passwordLength ?? "24", 10);

  // 1) Core per-service DB creds (create-if-missing only)
  for (const svc of services as string[]) {
    const name = `${project}-${envName}-${svc}`;
    const payload = {
      username: svc,
      password: randomAlnum(pwLen),
      host: String(dbHost),
      port: String(dbPort),
      database: svc,
    };
    if (await createIfMissing(name, payload, kmsKeyId, tags)) created.push(name);
  }

  // Helpers
  const hostname: string | undefined = g3auto?.hostname;
  const region: string = g3auto?.region || process.env.AWS_REGION || "ap-southeast-2";

  // 2) metadata-g3auto
  if (create?.metadataG3auto) {
    if (!hostname) throw new Error("metadata-g3auto requires g3auto.hostname");
    const name = `${project}-${envName}-metadata-g3auto`;
    const db_password = randomAlnum(pwLen);
    const adminPwd = randomAlnum(pwLen);
    const base64Authz = Buffer.from(`gateway:${adminPwd}`, "utf8").toString("base64");
    const json = {
      "dbcreds.json": {
        db_host: String(dbHost),
        db_username: "metadata",
        db_password,
        db_database: "metadata",
      },
      "metadata.env": [
        "DEBUG=false",
        `DB_HOST=${dbHost}`,
        "DB_USER=metadata",
        `DB_PASSWORD=${db_password}`,
        "DB_DATABASE=metadata",
        `ADMIN_LOGINS=gateway:${adminPwd}`,
      ],
      "base64Authz.txt": base64Authz,
    };
    if (await createIfMissing(name, json, kmsKeyId, tags)) created.push(name);
  }

  // 3) wts-g3auto (placeholders allowed)
  if (create?.wtsG3auto) {
    if (!hostname) throw new Error("wts-g3auto requires g3auto.hostname");
    const name = `${project}-${envName}-wts-g3auto`;
    const wtsBase = g3auto?.wtsBaseUrl ?? `https://${hostname}/wts/`;
    const fenceBase = g3auto?.fenceBaseUrl ?? `https://${hostname}/user/`;
    const oidcId = g3auto?.oidcClientId ?? "replace-me";
    const oidcSecret = g3auto?.oidcClientSecret ?? "replace-me";
    const json = {
      "appcreds.json": {
        wts_base_url: wtsBase,
        encryption_key: randomBase64(32),
        secret_key: randomBase64(32),
        fence_base_url: fenceBase,
        oidc_client_id: oidcId,
        oidc_client_secret: oidcSecret,
        external_oidc: [],
      },
    };
    if (await createIfMissing(name, json, kmsKeyId, tags)) created.push(name);
  }

  // 4) pelicanservice-g3auto (prefer IRSA; keys optional)
  if (create?.pelicanserviceG3auto) {
    if (!hostname || !g3auto?.pelicanBucketName) throw new Error("pelicanservice-g3auto requires hostname & bucket");
    const name = `${project}-${envName}-pelicanservice-g3auto`;
    const json: Record<string, JSONValue> = {
      manifest_bucket_name: g3auto.pelicanBucketName,
      hostname,
    };
    if (g3auto.pelicanAccessKeyId && g3auto.pelicanSecretAccessKey) {
      json["aws_access_key_id"] = g3auto.pelicanAccessKeyId;
      json["aws_secret_access_key"] = g3auto.pelicanSecretAccessKey;
    }
    if (await createIfMissing(name, json, kmsKeyId, tags)) created.push(name);
  }

  // 5) manifestservice-g3auto
  if (create?.manifestserviceG3auto) {
    if (!hostname || !g3auto?.manifestBucketName) throw new Error("manifestservice-g3auto requires hostname & bucket");
    const name = `${project}-${envName}-manifestservice-g3auto`;
    const json = {
      manifest_bucket_name: g3auto.manifestBucketName,
      hostname,
      prefix: g3auto.manifestPrefix ?? "",
    };
    if (await createIfMissing(name, json, kmsKeyId, tags)) created.push(name);
  }

  // 6) audit-gen3auto (YAML under "config.yaml")
  if (create?.auditGen3auto) {
    if (!g3auto?.auditSqsUrl) throw new Error("audit-gen3auto requires g3auto.auditSqsUrl");
    const name = `${project}-${envName}-audit-gen3auto`;
    const yaml =
`SERVER:
  DEBUG: false
  PULL_FROM_QUEUE: false
  QUEUE_CONFIG:
    type: aws_sqs
    aws_sqs_config:
      sqs_url: ${g3auto.auditSqsUrl}
      region: ${region}
  PULL_FREQUENCY_SECONDS: 300
  AWS_CREDENTIALS: {}
QUERY_TIMEBOX_MAX_DAYS: null
QUERY_PAGE_SIZE: 1000
QUERY_USERNAMES: true`;
    const json = { "config.yaml": yaml };
    if (await createIfMissing(name, json, kmsKeyId, tags)) created.push(name);
  }

  // 7) ssjdispatcher-creds
  if (create?.ssjdispatcherCreds) {
    if (!g3auto?.ssjSqsUrl) throw new Error("ssjdispatcher-creds requires g3auto.ssjSqsUrl");
    const name = `${project}-${envName}-ssjdispatcher-creds`;
    const idxUser = g3auto.ssjIndexdUser || "ssj";
    const idxPwd = g3auto.ssjIndexdPassword || randomAlnum(pwLen);
    const mdsUser = g3auto.ssjMetadataUser || "gateway";
    const mdsPwd = g3auto.ssjMetadataPassword || randomAlnum(pwLen);

    const json = {
      AWS: { region },
      SQS: { url: g3auto.ssjSqsUrl },
      JOBS: [
        {
          name: "indexing",
          pattern: g3auto.ssjDataPattern || "",
          imageConfig: {
            url: "http://indexd-service/index",
            username: idxUser,
            password: idxPwd,
            metadataService: {
              url: "http://revproxy-service/mds",
              username: mdsUser,
              password: mdsPwd,
            },
          },
          RequestCPU: "500m",
          RequestMem: "0.5Gi",
          ServiceAccount: "ssjdispatcher-service-account",
        },
      ],
    };
    if (await createIfMissing(name, json, kmsKeyId, tags)) created.push(name);
  }

  return {
    PhysicalResourceId: `gen3-secrets-${project}-${envName}`,
    Data: { created: JSON.stringify(created) },
  };
};
