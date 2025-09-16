import {
  SecretsManagerClient,
  GetSecretValueCommand,
  CreateSecretCommand,
  DescribeSecretCommand,
  TagResourceCommand,
} from "@aws-sdk/client-secrets-manager";
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

async function tryGetSecretJson(secretId: string): Promise<Record<string, any> | null> {
  try {
    return await getSecretJson(secretId);
  } catch (e: any) {
    if (e?.name === "ResourceNotFoundException") return null;
    throw e;
  }
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
  const create = await sm.send(
    new CreateSecretCommand({
      Name: name,
      SecretString: JSON.stringify(payload),
      KmsKeyId: kmsKeyId,
    })
  );
  const tagList = tags ? Object.entries(tags).map(([Key, Value]) => ({ Key, Value })) : [];
  if (tagList.length) {
    await sm.send(new TagResourceCommand({ SecretId: create.ARN!, Tags: tagList }));
  }
  return true;
}

// --- extract helpers from other secrets ---
function extractGatewayFromMetadataG3auto(meta: any): string | null {
  const envArr = meta?.["metadata.env"];
  if (Array.isArray(envArr)) {
    const line = envArr.find((s: any) => typeof s === "string" && s.startsWith("ADMIN_LOGINS="));
    if (line) {
      const val = String(line).slice("ADMIN_LOGINS=".length);
      for (const pair of val.split(",").map((s) => s.trim())) {
        const [user, pwd] = pair.split(":");
        if (user === "gateway" && pwd) return pwd;
      }
    }
  }
  const b64 = meta?.["base64Authz.txt"];
  if (typeof b64 === "string") {
    try {
      const plain = Buffer.from(b64, "base64").toString("utf8");
      const [user, pwd] = plain.split(":");
      if (user === "gateway" && pwd) return pwd;
    } catch {/* ignore */ }
  }
  return null;
}

function extractSsjFromDispatcher(ssj: any): string | null {
  const jobs = ssj?.JOBS;
  if (Array.isArray(jobs) && jobs.length) {
    const job = jobs.find((j: any) => j?.name === "indexing") ?? jobs[0];
    const pwd = job?.imageConfig?.password;
    if (typeof pwd === "string" && pwd) return pwd;
  }
  return null;
}

/** Create a plaintext secret (SecretString) if it doesn't exist */
async function createPlainIfMissing(
  name: string,
  secretString: string,
  kmsKeyId?: string,
  tags?: Record<string, string>
): Promise<boolean> {
  if (await exists(name)) return false;
  const create = await sm.send(new CreateSecretCommand({
    Name: name,
    SecretString: secretString,   // <- raw PEM string, not JSON
    KmsKeyId: kmsKeyId,           // optional CMK; Secrets Manager still encrypts at rest
  }));
  const tagList = tags ? Object.entries(tags).map(([Key, Value]) => ({ Key, Value })) : [];
  if (tagList.length) {
    await sm.send(new TagResourceCommand({ SecretId: create.ARN!, Tags: tagList }));
  }
  return true;
}

function generateRsaKeyPairPem(modulusLength = 2048) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength, // 2048 is standard for RS256 JWT
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return { privateKeyPem: privateKey, publicKeyPem: publicKey };
}

export const handler = async (event: any) => {
  const props = event.ResourceProperties || {};
  const {
    project,
    envName,
    services,
    masterSecretName,
    passwordLength,
    kmsKeyId,
    tags,
    dbHostOverride,
    dbPortOverride,
    create,
    g3auto,
    // optional customization for indexd-service
    indexdServiceUsers,
    indexdServiceStatic,
  }: {
    project: string;
    envName: string;
    services: string[];
    masterSecretName?: string;
    passwordLength?: number | string;
    kmsKeyId?: string;
    tags?: Record<string, string>;
    dbHostOverride?: string;
    dbPortOverride?: number;
    create?: Record<string, any>;
    g3auto?: Record<string, any>;
    indexdServiceUsers?: string[];
    indexdServiceStatic?: Record<string, string>;
  } = props;

  if (event.RequestType === "Delete") {
    return { PhysicalResourceId: `gen3-secrets-${project}-${envName}` };
  }

  // Cache for values generated earlier in this invocation
  let _generatedGatewayAdminPwd: string | null = null;

  // Also cache DB passwords we create, so we can reuse without re-read
  const _dbPwCreated: Record<string, string> = {};

  // Resolve DB host/port
  let dbHost = dbHostOverride ?? null;
  let dbPort = dbPortOverride ?? null;
  if (!dbHost || !dbPort) {
    const master = await getSecretJson(masterSecretName!);
    dbHost = dbHost ?? master.host;
    dbPort = dbPort ?? master.port;
  }
  if (!dbHost || !dbPort) throw new Error("Missing DB host/port (master secret or overrides)");

  const created: string[] = [];
  const pwLen = parseInt((passwordLength as any) ?? "24", 10);

  // helper to fetch per-service DB password (from created cache or existing secret)
  const getDbPassword = async (svc: string): Promise<string | null> => {
    if (_dbPwCreated[svc]) return _dbPwCreated[svc];
    const sec = await tryGetSecretJson(`${project}-${envName}-${svc}`);
    const pwd = sec?.password ?? sec?.Password ?? null;
    return typeof pwd === "string" && pwd ? pwd : null;
  };

  // 1) Per-service DB creds
  for (const svc of services as string[]) {
    const secName = `${project}-${envName}-${svc}`;
    const pwd = randomAlnum(pwLen);
    const payload = {
      username: svc,
      password: pwd,
      host: String(dbHost),
      port: String(dbPort),
      database: svc,
    };
    if (await createIfMissing(secName, payload, kmsKeyId, tags)) {
      created.push(secName);
      _dbPwCreated[svc] = pwd;
    }
  }

  // Helpers
  const hostname: string | undefined = g3auto?.hostname;
  const region: string = g3auto?.region || process.env.AWS_REGION || "ap-southeast-2";

  // 2) metadata-g3auto
  if (create?.metadataG3auto) {
    if (!hostname) throw new Error("metadata-g3auto requires g3auto.hostname");
    const secName = `${project}-${envName}-metadata-g3auto`;
    const db_password = (await getDbPassword("metadata")) ?? randomAlnum(pwLen);
    const adminPwd = randomAlnum(pwLen);
    _generatedGatewayAdminPwd = adminPwd;
    const base64Authz = Buffer.from(`gateway:${adminPwd}`, "utf8").toString("base64");
    const json = {
      "dbcreds.json": {
        db_host: String(dbHost),
        db_username: "metadata",
        db_password: db_password,
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
    if (await createIfMissing(secName, json, kmsKeyId, tags)) created.push(secName);
  }

  // 3) wts-g3auto
  if (create?.wtsG3auto) {
    if (!hostname) throw new Error("wts-g3auto requires g3auto.hostname");
    const secName = `${project}-${envName}-wts-g3auto`;
    const wtsBase = g3auto?.wtsBaseUrl ?? `https://${hostname}/wts/`;
    const fenceBase = g3auto?.fenceBaseUrl ?? `https://${hostname}/user/`;
    const oidcId = g3auto?.oidcClientId ?? "REPLACE_ME";
    const oidcSecret = g3auto?.oidcClientSecret ?? "REPLACE_ME";
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
    if (await createIfMissing(secName, json, kmsKeyId, tags)) created.push(secName);
  }

  // 4) pelicanservice-g3auto
  if (create?.pelicanserviceG3auto) {
    if (!hostname || !g3auto?.pelicanBucketName)
      throw new Error("pelicanservice-g3auto requires hostname & bucket");
    const secName = `${project}-${envName}-pelicanservice-g3auto`;
    const json: Record<string, JSONValue> = {
      manifest_bucket_name: g3auto.pelicanBucketName,
      hostname,
    };
    if (g3auto.pelicanAccessKeyId && g3auto.pelicanSecretAccessKey) {
      json["aws_access_key_id"] = g3auto.pelicanAccessKeyId;
      json["aws_secret_access_key"] = g3auto.pelicanSecretAccessKey;
    }
    if (await createIfMissing(secName, json, kmsKeyId, tags)) created.push(secName);
  }

  // 5) manifestservice-g3auto
  if (create?.manifestserviceG3auto) {
    if (!hostname || !g3auto?.manifestBucketName)
      throw new Error("manifestservice-g3auto requires hostname & bucket");
    const secName = `${project}-${envName}-manifestservice-g3auto`;
    const json = {
      manifest_bucket_name: g3auto.manifestBucketName,
      hostname,
      prefix: g3auto.manifestPrefix ?? "",
    };
    if (await createIfMissing(secName, json, kmsKeyId, tags)) created.push(secName);
  }

  // 6) audit-gen3auto
  if (create?.auditGen3auto) {
    if (!g3auto?.auditSqsUrl) throw new Error("audit-gen3auto requires g3auto.auditSqsUrl");
    const secName = `${project}-${envName}-audit-g3auto`;
    const yaml = `SERVER:
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
    if (await createIfMissing(secName, json, kmsKeyId, tags)) created.push(secName);
  }

  // 7) ssjdispatcher-creds — passwords from DB creds (index & metadata)
  const indexDbPwd = await getDbPassword("index");
  const metadataDbPwd = await getDbPassword("metadata");

  if (create?.ssjdispatcherCreds) {
    if (!g3auto?.ssjSqsUrl) throw new Error("ssjdispatcher-creds requires g3auto.ssjSqsUrl");
    const secName = `${project}-${envName}-ssjdispatcher-creds`;
    const idxUser = g3auto.ssjIndexdUser || "ssj";
    const idxPwd = g3auto.ssjIndexdPassword || indexDbPwd || "REPLACE_ME"; // <- from index DB
    const mdsUser = g3auto.ssjMetadataUser || "gateway";
    const mdsPwd = g3auto.ssjMetadataPassword || metadataDbPwd || "REPLACE_ME"; // <- from metadata DB

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
    if (await createIfMissing(secName, json, kmsKeyId, tags)) created.push(secName);
  }

  // 8) ALWAYS create-if-missing: <project>-<env>-indexd-service
  {
    const secName = `${project}-${envName}-indexd-service`;

    // Start with explicit overrides (if any)
    const tokens: Record<string, string> = {};
    if (indexdServiceStatic && typeof indexdServiceStatic === "object") {
      for (const [k, v] of Object.entries(indexdServiceStatic)) {
        if (typeof v === "string" && v) tokens[k] = v;
      }
    }

    // fence/sheepdog from their DB passwords
    if (!tokens["fence"]) {
      const f = await getDbPassword("fence");
      if (f) tokens["fence"] = f;
    }
    if (!tokens["sheepdog"]) {
      const s = await getDbPassword("sheepdog");
      if (s) tokens["sheepdog"] = s;
    }

    // ssj token: same as ssjdispatcher IndexD password (from index DB)
    if (!tokens["ssj"]) {
      tokens["ssj"] = indexDbPwd || "REPLACE_ME";
    }

    // gateway: from metadata-g3auto (admin) if available, else leave as '||'
    if (!tokens["gateway"]) {
      if (_generatedGatewayAdminPwd) {
        tokens["gateway"] = _generatedGatewayAdminPwd;
      } else {
        const meta = await tryGetSecretJson(`${project}-${envName}-metadata-g3auto`);
        const gw = meta ? extractGatewayFromMetadataG3auto(meta) : null;
        if (gw) tokens["gateway"] = gw;
      }
    }

    // required keys (allow custom list via indexdServiceUsers)
    const required =
      Array.isArray(indexdServiceUsers) && indexdServiceUsers.length
        ? indexdServiceUsers
        : ["sheepdog", "fence", "ssj", "gateway"];

    for (const u of required) {
      if (!tokens[u]) tokens[u] = "REPLACE_ME"; // no randoms
    }

    if (await createIfMissing(secName, tokens, kmsKeyId, tags)) {
      created.push(secName);
    }
  }

  // 9) fence JWT private key (PEM) — plaintext SecretString
  if (create?.fenceJwtPrivateKey) {
    const secName = `${project}-${envName}-fence-jwt-key`;
    const { privateKeyPem /*, publicKeyPem*/ } = generateRsaKeyPairPem(2048);
    if (await createPlainIfMissing(secName, privateKeyPem, kmsKeyId, tags)) {
      created.push(secName);
    }
    // If you ever want to store the public key too:
    // await createPlainIfMissing(`${project}-${envName}-fence-jwt-public-key`, publicKeyPem, kmsKeyId, tags);
  }

  return {
    PhysicalResourceId: `gen3-secrets-${project}-${envName}`,
    Data: { created: JSON.stringify(created) },
  };
};
