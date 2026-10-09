import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { applyTargetSchema } from "../src/target-schema-application.mjs";

const { Client } = pg;

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const workspaceRoot = dirname(dirname(packageRoot));
const schemaPath = join(packageRoot, "src", "beam-studio-target-schema.sql");
const providerProfilesPath = join(
  workspaceRoot,
  "packages",
  "shared",
  "src",
  "provider-profiles.json",
);

loadEnvFile(join(workspaceRoot, ".env.local"));
loadEnvFile(join(workspaceRoot, ".env"));

const targetUrl = beamStudioDatabaseUrl();
const maintenanceUrl = databaseUrlForName(targetUrl, "postgres");

await ensureDatabase(targetUrl, maintenanceUrl);
await applySchema(targetUrl);
await seedCatalogs(targetUrl);

console.log(
  `Beam Studio PostgreSQL target schema is ready: ${redactUrl(targetUrl)}`,
);

function beamStudioDatabaseUrl() {
  const baseUrl =
    process.env.DATABASE_URL ??
    "postgres://beam:beam@127.0.0.1:5432/beam_studio";

  return databaseUrlForName(baseUrl, "beam_studio");
}

function databaseUrlForName(connectionString, databaseName) {
  const url = new URL(connectionString);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

async function ensureDatabase(databaseUrl, postgresUrl) {
  const targetName = new URL(databaseUrl).pathname.slice(1);
  const client = new Client({ connectionString: postgresUrl });
  await client.connect();
  try {
    const existing = await client.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [targetName],
    );
    if (existing.rowCount === 0) {
      await client.query(`CREATE DATABASE ${quoteIdentifier(targetName)}`);
      console.log(`Created PostgreSQL database ${targetName}.`);
    }
  } finally {
    await client.end();
  }
}

async function applySchema(databaseUrl) {
  const schemaSql = readTargetSchema(schemaPath);
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await applyTargetSchema(client, schemaSql, {
      onRetry: ({ code, attempt }) =>
        console.warn(
          `Schema startup contention (${code}); retrying after attempt ${attempt}.`,
        ),
    });
  } finally {
    await client.end();
  }
}

async function seedCatalogs(databaseUrl) {
  const providerProfiles = JSON.parse(
    readFileSync(providerProfilesPath, "utf8"),
  );
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("BEGIN");
    await seedCredentialCatalog(client, providerProfiles.profiles);
    await seedActionCatalog(client);
    await client.query(
      `
        INSERT INTO meta.schema_migrations (id, description)
        VALUES ($1, $2)
        ON CONFLICT (id) DO UPDATE
        SET applied_at = now(),
            description = EXCLUDED.description
      `,
      ["0001_static_catalog_seed", "Seed Beam Studio static catalogs"],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}

async function seedCredentialCatalog(client, providerProfiles) {
  const credentialTypes = [
    {
      id: "credential_type:beam_api_key",
      slug: "beam_api_key",
      displayName: "Beam API key",
      description: "Beam API key used to create and monitor Beam transfers.",
      secretSchema: {
        type: "object",
        required: ["api_key"],
        properties: {
          api_key: { type: "string" },
          nats_url: {
            type: "string",
            pattern: "^(nats|tls)://",
          },
          environment: { type: "string" },
        },
      },
    },
    {
      id: "credential_type:s3_compatible_access_key",
      slug: "s3_compatible_access_key",
      displayName: "S3-compatible access key",
      description: "Access key credentials for S3-compatible object storage.",
      secretSchema: {
        type: "object",
        required: ["access_key_id", "secret_access_key"],
        properties: {
          access_key_id: { type: "string" },
          secret_access_key: { type: "string" },
          session_token: { type: "string" },
          endpoint_url: { type: "string" },
          region: { type: "string", default: "us-east-1" },
          force_path_style: { type: "boolean" },
        },
      },
    },
    {
      id: "credential_type:huggingface_token",
      slug: "huggingface_token",
      displayName: "Hugging Face token",
      description: "Hugging Face Hub access token.",
      secretSchema: {
        type: "object",
        required: ["token"],
        properties: {
          token: { type: "string" },
          endpoint: { type: "string", default: "https://huggingface.co" },
        },
      },
    },
    {
      id: "credential_type:gcs_service_account",
      slug: "gcs_service_account",
      displayName: "Google Cloud service account",
      description: "Google Cloud service account JSON credentials.",
      secretSchema: {
        type: "object",
        required: ["service_account_json"],
        properties: { service_account_json: { type: "object" } },
      },
    },
    {
      id: "credential_type:http_bearer_token",
      slug: "http_bearer_token",
      displayName: "HTTP bearer token",
      description:
        "Bearer token, and optionally a signing secret, for authenticated HTTP callbacks.",
      secretSchema: {
        type: "object",
        required: ["token"],
        properties: {
          token: { type: "string" },
          // Keys the X-Beam-Signature HMAC. Separate from the bearer token so a
          // receiver can rotate one without losing the ability to verify the
          // other; the webhook action falls back to the token when it is absent.
          signing_secret: { type: "string" },
          // Projected into credential metadata, which is what lets a worker
          // build its network allowlist without decrypting the payload.
          base_url: { type: "string", format: "uri" },
        },
      },
    },
    {
      id: "credential_type:zapier_mcp",
      slug: "zapier_mcp",
      displayName: "Zapier MCP server",
      description:
        "Zapier MCP endpoint exposing the Zapier actions a Beam workflow may invoke.",
      secretSchema: {
        type: "object",
        required: ["base_url"],
        properties: {
          // The whole endpoint URL, not a host: Zapier embeds a per-server
          // secret in the path, and the shape has changed more than once, so
          // storing what the user copied beats deriving it from an account id.
          base_url: { type: "string", format: "uri" },
          api_key: { type: "string" },
        },
      },
    },
    {
      id: "credential_type:slack_webhook",
      slug: "slack_webhook",
      displayName: "Slack webhook",
      description: "Slack incoming webhook URL.",
      secretSchema: {
        type: "object",
        required: ["webhook_url"],
        properties: { webhook_url: { type: "string" } },
      },
    },
    {
      id: "credential_type:slack_bot_token",
      slug: "slack_bot_token",
      displayName: "Slack bot token",
      description:
        "Slack bot user OAuth token. Posts to any channel the bot belongs to and can direct message a person.",
      secretSchema: {
        type: "object",
        required: ["token"],
        properties: { token: { type: "string" } },
      },
    },
    {
      id: "credential_type:salesforce_client_credentials",
      slug: "salesforce_client_credentials",
      displayName: "Salesforce client credentials",
      description:
        "Salesforce External Client App credentials that mint access tokens as a named integration user.",
      secretSchema: {
        type: "object",
        required: ["client_id", "client_secret", "instance_url"],
        properties: {
          client_id: { type: "string" },
          client_secret: { type: "string" },
          // Token minting and every subsequent API call go to the org's own
          // instance host, so this doubles as the sandbox network allowlist
          // source once it is projected into credential metadata.
          instance_url: { type: "string", format: "uri" },
          api_version: { type: "string", default: "v62.0" },
        },
      },
    },
    {
      id: "credential_type:salesforce_jwt",
      slug: "salesforce_jwt",
      displayName: "Salesforce JWT bearer",
      description:
        "Salesforce Connected App credentials that sign a JWT assertion for a pre-authorized user.",
      secretSchema: {
        type: "object",
        required: ["client_id", "username", "private_key"],
        properties: {
          client_id: { type: "string" },
          username: { type: "string" },
          private_key: { type: "string" },
          // JWT bearer authenticates against the login host, which differs from
          // the instance host the API calls then use. Both need allowlisting.
          login_url: {
            type: "string",
            format: "uri",
            default: "https://login.salesforce.com",
          },
          instance_url: { type: "string", format: "uri" },
          api_version: { type: "string", default: "v62.0" },
        },
      },
    },
    {
      id: "credential_type:adobe_aep_oauth_s2s",
      slug: "adobe_aep_oauth_s2s",
      displayName: "Adobe Experience Platform",
      description:
        "Adobe OAuth Server-to-Server credentials for Experience Platform APIs.",
      secretSchema: {
        type: "object",
        required: ["client_id", "client_secret", "org_id", "sandbox_name"],
        properties: {
          // client_id doubles as the x-api-key header on every Platform call.
          client_id: { type: "string" },
          client_secret: { type: "string" },
          // IMS org, sent as x-gw-ims-org-id. Always ends in @AdobeOrg.
          org_id: { type: "string" },
          // Sent as x-sandbox-name. Platform data is partitioned by sandbox, so
          // this is not optional in practice even where the API tolerates it.
          sandbox_name: { type: "string", default: "prod" },
          scopes: {
            type: "string",
            default:
              "openid,AdobeID,read_organizations,additional_info.projectedProductContext,session",
          },
          // Token host is region-specific (ims-na1 / ims-eu1 / ...) and differs
          // from the API host, so both are stored and both reach the sandbox
          // network allowlist via the login_url/base_url metadata projection.
          login_url: {
            type: "string",
            format: "uri",
            default: "https://ims-na1.adobelogin.com",
          },
          base_url: {
            type: "string",
            format: "uri",
            default: "https://platform.adobe.io",
          },
        },
      },
    },
    {
      id: "credential_type:snowflake_key_pair",
      slug: "snowflake_key_pair",
      displayName: "Snowflake key pair",
      description:
        "Snowflake RSA key-pair credentials for a service user on the SQL API.",
      secretSchema: {
        type: "object",
        required: ["account", "user", "private_key", "base_url"],
        properties: {
          account: { type: "string" },
          user: { type: "string" },
          private_key: { type: "string" },
          private_key_passphrase: { type: "string" },
          base_url: { type: "string", format: "uri" },
          role: { type: "string" },
          warehouse: { type: "string" },
          database: { type: "string" },
          schema: { type: "string" },
        },
      },
    },
    {
      id: "credential_type:databricks_oauth_m2m",
      slug: "databricks_oauth_m2m",
      displayName: "Databricks service principal",
      description:
        "Databricks OAuth machine-to-machine credentials for a service principal.",
      secretSchema: {
        type: "object",
        required: ["base_url", "client_id", "client_secret"],
        properties: {
          // Workspace URL. Token minting and every API call share this host, so
          // one entry covers the sandbox network allowlist.
          base_url: { type: "string", format: "uri" },
          client_id: { type: "string" },
          client_secret: { type: "string" },
          http_path: { type: "string" },
          catalog: { type: "string" },
          schema: { type: "string" },
        },
      },
    },
    {
      id: "credential_type:databricks_pat",
      slug: "databricks_pat",
      displayName: "Databricks personal access token",
      description:
        "Databricks personal access token for a user or service principal.",
      secretSchema: {
        type: "object",
        required: ["base_url", "token"],
        properties: {
          base_url: { type: "string", format: "uri" },
          token: { type: "string" },
          http_path: { type: "string" },
          catalog: { type: "string" },
          schema: { type: "string" },
        },
      },
    },
    {
      id: "credential_type:snowflake_pat",
      slug: "snowflake_pat",
      displayName: "Snowflake PAT",
      description:
        "Snowflake programmatic access token scoped to a single role.",
      secretSchema: {
        type: "object",
        required: ["account", "user", "token", "base_url"],
        properties: {
          account: { type: "string" },
          user: { type: "string" },
          token: { type: "string" },
          base_url: { type: "string", format: "uri" },
          role: { type: "string" },
          warehouse: { type: "string" },
          database: { type: "string" },
          schema: { type: "string" },
        },
      },
    },
  ];

  for (const type of credentialTypes) {
    await client.query(
      `
        INSERT INTO secrets.credential_types (
          id, slug, display_name, description, secret_schema_json
        )
        VALUES ($1, $2, $3, $4, $5::jsonb)
        ON CONFLICT (slug) DO UPDATE
        SET display_name = EXCLUDED.display_name,
            description = EXCLUDED.description,
            secret_schema_json = EXCLUDED.secret_schema_json,
            updated_at = now()
      `,
      [
        type.id,
        type.slug,
        type.displayName,
        type.description,
        JSON.stringify(type.secretSchema),
      ],
    );
  }

  const capabilities = [
    [
      "capability:object_storage.read",
      "object_storage.read",
      "Object storage read",
    ],
    [
      "capability:object_storage.write",
      "object_storage.write",
      "Object storage write",
    ],
    [
      "capability:object_storage.list",
      "object_storage.list",
      "Object storage list",
    ],
    ["capability:beam.transfer", "beam.transfer", "Beam transfer"],
    ["capability:webhook.send", "webhook.send", "Webhook send"],
    ["capability:http.request", "http.request", "HTTP request"],
    ["capability:crm.read", "crm.read", "CRM read"],
    ["capability:crm.write", "crm.write", "CRM write"],
    ["capability:cdp.read", "cdp.read", "Customer data platform read"],
    ["capability:cdp.write", "cdp.write", "Customer data platform write"],
    ["capability:warehouse.read", "warehouse.read", "Data warehouse read"],
    ["capability:warehouse.write", "warehouse.write", "Data warehouse write"],
  ];

  for (const [id, slug, displayName] of capabilities) {
    await client.query(
      `
        INSERT INTO secrets.credential_capabilities (id, slug, display_name)
        VALUES ($1, $2, $3)
        ON CONFLICT (slug) DO UPDATE
        SET display_name = EXCLUDED.display_name,
            updated_at = now()
      `,
      [id, slug, displayName],
    );
  }

  const typeCapabilities = [
    ["beam_api_key", "beam.transfer"],
    ["s3_compatible_access_key", "object_storage.read"],
    ["s3_compatible_access_key", "object_storage.write"],
    ["s3_compatible_access_key", "object_storage.list"],
    ["gcs_service_account", "object_storage.read"],
    ["gcs_service_account", "object_storage.write"],
    ["gcs_service_account", "object_storage.list"],
    ["huggingface_token", "object_storage.read"],
    ["huggingface_token", "object_storage.write"],
    ["huggingface_token", "object_storage.list"],
    ["http_bearer_token", "http.request"],
    ["http_bearer_token", "webhook.send"],
    ["zapier_mcp", "http.request"],
    ["slack_webhook", "webhook.send"],
    ["salesforce_client_credentials", "crm.read"],
    ["salesforce_client_credentials", "crm.write"],
    ["salesforce_jwt", "crm.read"],
    ["salesforce_jwt", "crm.write"],
    ["adobe_aep_oauth_s2s", "cdp.read"],
    ["adobe_aep_oauth_s2s", "cdp.write"],
    ["snowflake_key_pair", "warehouse.read"],
    ["snowflake_key_pair", "warehouse.write"],
    ["snowflake_pat", "warehouse.read"],
    ["snowflake_pat", "warehouse.write"],
    ["databricks_oauth_m2m", "warehouse.read"],
    ["databricks_oauth_m2m", "warehouse.write"],
    ["databricks_pat", "warehouse.read"],
    ["databricks_pat", "warehouse.write"],
  ];

  for (const [typeSlug, capabilitySlug] of typeCapabilities) {
    const id = `type_capability:${typeSlug}:${capabilitySlug}`;
    await client.query(
      `
        INSERT INTO secrets.credential_type_capabilities (
          id, credential_type_id, credential_capability_id
        )
        SELECT $1, ct.id, cc.id
        FROM secrets.credential_types ct
        JOIN secrets.credential_capabilities cc ON cc.slug = $3
        WHERE ct.slug = $2
        ON CONFLICT (credential_type_id, credential_capability_id) DO NOTHING
      `,
      [id, typeSlug, capabilitySlug],
    );
  }

  for (const profile of providerProfiles) {
    const endpoint = profile.endpoint ?? {};
    const region = profile.region ?? {};
    const credentialFields = profile.credential_fields ?? {};
    const defaults = {
      ...(region.default ? { region: region.default } : {}),
      ...(endpoint.force_path_style === undefined
        ? {}
        : { force_path_style: endpoint.force_path_style }),
    };
    await client.query(
      `
        INSERT INTO secrets.provider_profiles (
          id,
          credential_type_id,
          driver,
          display_name,
          description,
          logo_url,
          website_url,
          docs_url,
          endpoint_template,
          default_region,
          default_endpoint_url,
          required_fields_json,
          optional_fields_json,
          field_defaults_json,
          metadata_json,
          enabled
        )
        SELECT
          $1, ct.id, $2, $3, $4, $5, $6, $7, $8, $9, $10,
          $11::jsonb, $12::jsonb, $13::jsonb, $14::jsonb, $15
        FROM secrets.credential_types ct
        WHERE ct.slug = 's3_compatible_access_key'
        ON CONFLICT (id) DO UPDATE
        SET credential_type_id = EXCLUDED.credential_type_id,
            driver = EXCLUDED.driver,
            display_name = EXCLUDED.display_name,
            description = EXCLUDED.description,
            logo_url = EXCLUDED.logo_url,
            website_url = EXCLUDED.website_url,
            docs_url = EXCLUDED.docs_url,
            endpoint_template = EXCLUDED.endpoint_template,
            default_region = EXCLUDED.default_region,
            default_endpoint_url = EXCLUDED.default_endpoint_url,
            required_fields_json = EXCLUDED.required_fields_json,
            optional_fields_json = EXCLUDED.optional_fields_json,
            field_defaults_json = EXCLUDED.field_defaults_json,
            metadata_json = EXCLUDED.metadata_json,
            enabled = EXCLUDED.enabled,
            updated_at = now()
      `,
      [
        profile.id,
        profile.driver,
        profile.name,
        (profile.notes ?? []).join(" ") || null,
        profile.logo ?? null,
        profile.website_url ?? null,
        profile.docs_url ?? null,
        endpoint.template ?? null,
        region.default ?? null,
        endpoint.default_url ?? null,
        JSON.stringify(credentialFields.required ?? []),
        JSON.stringify(credentialFields.optional ?? []),
        JSON.stringify(defaults),
        JSON.stringify(profile),
        profile.status !== "disabled",
      ],
    );
  }

  const nativeProfiles = [
    {
      id: "beam",
      credentialType: "beam_api_key",
      driver: "beam",
      displayName: "Beam",
      description: "Beam API key and NATS lifecycle credentials.",
      requiredFields: ["api_key"],
      optionalFields: ["nats_url", "environment"],
      defaults: {},
      metadata: { native: true },
    },
    {
      id: "huggingface-hub",
      credentialType: "huggingface_token",
      driver: "huggingface",
      displayName: "Hugging Face Hub (token)",
      description:
        "Hugging Face Hub access token for dataset, model, and Space repositories.",
      logoUrl: "/provider-logos/huggingface.png",
      requiredFields: ["token"],
      optionalFields: ["endpoint"],
      defaults: { endpoint: "https://huggingface.co" },
      metadata: { native: true },
    },
    {
      id: "gcs",
      credentialType: "gcs_service_account",
      driver: "gcs",
      displayName: "Google Cloud Storage",
      description: "Google Cloud service account credentials.",
      logoUrl: "/provider-logos/gcs.svg",
      requiredFields: ["project_id", "client_email", "private_key"],
      optionalFields: [],
      defaults: {},
      metadata: { native: true },
    },
    {
      id: "http",
      credentialType: "http_bearer_token",
      driver: "http",
      displayName: "HTTP endpoint",
      description:
        "Bearer token and signing secret used by the webhook action's completion callbacks.",
      logoUrl: "/provider-logos/http.svg",
      requiredFields: ["token"],
      optionalFields: ["signing_secret", "base_url"],
      defaults: {},
      metadata: { native: true },
    },
    {
      id: "zapier",
      credentialType: "zapier_mcp",
      driver: "zapier",
      displayName: "Zapier",
      description:
        "Zapier MCP server exposing the Zapier actions a workflow may invoke.",
      logoUrl: "/provider-logos/zapier.svg",
      docsUrl: "https://mcp.zapier.com",
      requiredFields: ["base_url"],
      optionalFields: ["api_key"],
      defaults: {},
      metadata: { native: true },
    },
    {
      id: "slack",
      credentialType: "slack_webhook",
      driver: "slack",
      displayName: "Slack webhook",
      description: "Slack incoming webhook credentials.",
      requiredFields: ["webhook_url"],
      optionalFields: [],
      defaults: {},
      metadata: { native: true },
    },
    {
      id: "slack-bot",
      credentialType: "slack_bot_token",
      driver: "slack",
      displayName: "Slack (bot token)",
      description:
        "Slack bot user OAuth token used by the Slack message action to post to a channel or direct message a person.",
      logoUrl: "/provider-logos/slack.svg",
      docsUrl: "https://api.slack.com/authentication/token-types#bot",
      requiredFields: ["token"],
      optionalFields: [],
      defaults: {},
      metadata: { native: true },
    },
    {
      id: "salesforce",
      credentialType: "salesforce_client_credentials",
      driver: "salesforce",
      displayName: "Salesforce",
      description:
        "Salesforce External Client App running as an integration user.",
      logoUrl: "/provider-logos/salesforce.png",
      docsUrl:
        "https://help.salesforce.com/s/articleView?id=xcloud.connected_app_client_credentials_setup.htm",
      requiredFields: ["client_id", "client_secret", "instance_url"],
      optionalFields: ["api_version"],
      defaults: { api_version: "v62.0" },
      metadata: { native: true },
    },
    {
      id: "salesforce-jwt",
      credentialType: "salesforce_jwt",
      driver: "salesforce",
      displayName: "Salesforce (JWT bearer)",
      description:
        "Salesforce Connected App using a signed JWT assertion for a pre-authorized user.",
      logoUrl: "/provider-logos/salesforce.png",
      docsUrl:
        "https://help.salesforce.com/s/articleView?id=xcloud.remoteaccess_oauth_jwt_flow.htm",
      requiredFields: ["client_id", "username", "private_key"],
      optionalFields: ["login_url", "instance_url", "api_version"],
      defaults: {
        login_url: "https://login.salesforce.com",
        api_version: "v62.0",
      },
      metadata: { native: true },
    },
    {
      id: "adobe-aep",
      credentialType: "adobe_aep_oauth_s2s",
      driver: "adobe-aep",
      displayName: "Adobe Experience Platform",
      description:
        "Adobe OAuth Server-to-Server credentials for Experience Platform APIs.",
      logoUrl: "/provider-logos/adobe-aep.png",
      docsUrl:
        "https://experienceleague.adobe.com/en/docs/experience-platform/landing/platform-apis/api-authentication",
      requiredFields: ["client_id", "client_secret", "org_id", "sandbox_name"],
      optionalFields: ["scopes", "login_url", "base_url"],
      defaults: {
        sandbox_name: "prod",
        scopes:
          "openid,AdobeID,read_organizations,additional_info.projectedProductContext,session",
        login_url: "https://ims-na1.adobelogin.com",
        base_url: "https://platform.adobe.io",
      },
      metadata: { native: true },
    },
    {
      id: "snowflake",
      credentialType: "snowflake_key_pair",
      driver: "snowflake",
      displayName: "Snowflake",
      description: "RSA key-pair credentials for a Snowflake service user.",
      logoUrl: "/provider-logos/snowflake.svg",
      docsUrl: "https://docs.snowflake.com/en/user-guide/key-pair-auth",
      requiredFields: ["account", "user", "private_key", "base_url"],
      optionalFields: [
        "private_key_passphrase",
        "role",
        "warehouse",
        "database",
        "schema",
      ],
      defaults: {},
      metadata: { native: true },
    },
    {
      id: "snowflake-pat",
      credentialType: "snowflake_pat",
      driver: "snowflake",
      displayName: "Snowflake PAT",
      description:
        "Programmatic Access Token, scoped to a single Snowflake role.",
      logoUrl: "/provider-logos/snowflake.svg",
      docsUrl:
        "https://docs.snowflake.com/en/user-guide/programmatic-access-tokens",
      requiredFields: ["account", "user", "token", "base_url"],
      optionalFields: ["role", "warehouse", "database", "schema"],
      defaults: {},
      metadata: { native: true },
    },
    {
      id: "databricks",
      credentialType: "databricks_oauth_m2m",
      driver: "databricks",
      displayName: "Databricks",
      description:
        "OAuth machine-to-machine credentials for a service principal.",
      logoUrl: "/provider-logos/databricks.png",
      docsUrl: "https://docs.databricks.com/aws/en/dev-tools/auth/oauth-m2m",
      requiredFields: ["base_url", "client_id", "client_secret"],
      optionalFields: ["http_path", "catalog", "schema"],
      defaults: {},
      metadata: { native: true },
    },
    {
      id: "databricks-pat",
      credentialType: "databricks_pat",
      driver: "databricks",
      displayName: "Databricks PAT",
      description: "Personal access token for a Databricks workspace.",
      logoUrl: "/provider-logos/databricks.png",
      docsUrl: "https://docs.databricks.com/aws/en/dev-tools/auth/pat",
      requiredFields: ["base_url", "token"],
      optionalFields: ["http_path", "catalog", "schema"],
      defaults: {},
      metadata: { native: true },
    },
  ];

  for (const profile of nativeProfiles) {
    await client.query(
      `
        INSERT INTO secrets.provider_profiles (
          id,
          credential_type_id,
          driver,
          display_name,
          description,
          logo_url,
          docs_url,
          required_fields_json,
          optional_fields_json,
          field_defaults_json,
          metadata_json,
          enabled
        )
        SELECT
          $1, ct.id, $2, $3, $4, $5, $6,
          $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, true
        FROM secrets.credential_types ct
        WHERE ct.slug = $11
        ON CONFLICT (id) DO UPDATE
        SET credential_type_id = EXCLUDED.credential_type_id,
            driver = EXCLUDED.driver,
            display_name = EXCLUDED.display_name,
            description = EXCLUDED.description,
            logo_url = EXCLUDED.logo_url,
            docs_url = EXCLUDED.docs_url,
            required_fields_json = EXCLUDED.required_fields_json,
            optional_fields_json = EXCLUDED.optional_fields_json,
            field_defaults_json = EXCLUDED.field_defaults_json,
            metadata_json = EXCLUDED.metadata_json,
            enabled = EXCLUDED.enabled,
            updated_at = now()
      `,
      [
        profile.id,
        profile.driver,
        profile.displayName,
        profile.description,
        profile.logoUrl ?? null,
        profile.docsUrl ?? null,
        JSON.stringify(profile.requiredFields),
        JSON.stringify(profile.optionalFields),
        JSON.stringify(profile.defaults),
        JSON.stringify(profile.metadata),
        profile.credentialType,
      ],
    );
  }
}

async function seedActionCatalog(client) {
  const categories = [
    ["category:transfer", "transfer", "Transfer", 10],
    ["category:object-storage", "object-storage", "Object storage", 20],
    ["category:data", "data", "Data", 30],
    ["category:integration", "integration", "Integration", 40],
  ];

  for (const [id, slug, name, sortOrder] of categories) {
    await client.query(
      `
        INSERT INTO actions.categories (id, slug, name, sort_order)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (slug) DO UPDATE
        SET name = EXCLUDED.name,
            sort_order = EXCLUDED.sort_order,
            updated_at = now()
      `,
      [id, slug, name, sortOrder],
    );
  }

  await client.query(
    `
      INSERT INTO actions.scopes (id, name, status, metadata_json)
      VALUES ($1, $2, 'active', $3::jsonb)
      ON CONFLICT (name) DO UPDATE
      SET status = EXCLUDED.status,
          metadata_json = EXCLUDED.metadata_json,
          updated_at = now()
    `,
    ["scope:@beam", "@beam", JSON.stringify({ builtin: true })],
  );

  const packages = [
    {
      packageName: "@beam/object-storage-endpoint",
      displayName: "Object Storage Endpoint",
      category: "object-storage",
      description: "Resolve object storage endpoint settings.",
      requirements: [
        {
          key: "storage",
          displayName: "Object storage credential",
          capability: "object_storage.list",
        },
      ],
    },
    {
      packageName: "@beam/download",
      displayName: "Download",
      category: "object-storage",
      description: "Download content from object storage.",
      requirements: [
        {
          key: "source",
          displayName: "Source credential",
          capability: "object_storage.read",
        },
      ],
    },
    {
      packageName: "@beam/upload",
      displayName: "Upload",
      category: "object-storage",
      description: "Upload content to object storage.",
      requirements: [
        {
          key: "destination",
          displayName: "Destination credential",
          capability: "object_storage.write",
        },
      ],
    },
    {
      packageName: "@beam/webhook",
      displayName: "Webhook",
      category: "integration",
      description: "Send workflow notifications to a webhook.",
      requirements: [
        {
          key: "webhook",
          displayName: "Webhook credential",
          capability: "webhook.send",
        },
      ],
    },
  ];

  for (const actionPackage of packages) {
    const [, name] = actionPackage.packageName.split("/");
    const packageId = `package:${actionPackage.packageName}`;
    const versionId = `${packageId}:1.0.0`;
    const manifest = {
      name: actionPackage.packageName,
      version: "1.0.0",
      apiVersion: "workflow-actions/v1",
      trustLevel: "builtin",
      catalog: {
        displayName: actionPackage.displayName,
        description: actionPackage.description,
        category: actionPackage.category,
        maturity: "stable",
      },
      runtime: {
        placements: ["local-workers"],
        defaultPlacement: "local-workers",
      },
      permissions: actionPackage.requirements.map(
        (requirement) => requirement.capability,
      ),
      inputs: {},
      outputs: {},
    };
    const checksum = checksumJson(manifest);

    const packageResult = await client.query(
      `
        INSERT INTO actions.packages (
          id, scope_id, category_id, name, package_name, display_name,
          description, visibility, status, trust_level, latest_version, metadata_json
        )
        SELECT
          $1, s.id, c.id, $2, $3, $4, $5,
          'public', 'active', 'builtin', '1.0.0', $6::jsonb
        FROM actions.scopes s
        JOIN actions.categories c ON c.slug = $7
        WHERE s.name = '@beam'
        ON CONFLICT (package_name) DO UPDATE
        SET category_id = EXCLUDED.category_id,
            display_name = EXCLUDED.display_name,
            description = EXCLUDED.description,
            visibility = EXCLUDED.visibility,
            status = EXCLUDED.status,
            trust_level = EXCLUDED.trust_level,
            latest_version = EXCLUDED.latest_version,
            metadata_json = EXCLUDED.metadata_json,
            updated_at = now()
        RETURNING id
      `,
      [
        packageId,
        name,
        actionPackage.packageName,
        actionPackage.displayName,
        actionPackage.description,
        JSON.stringify({ builtin: true }),
        actionPackage.category,
      ],
    );
    const resolvedPackageId = packageResult.rows[0]?.id;
    if (!resolvedPackageId) {
      throw new Error(
        `Could not seed action package ${actionPackage.packageName}.`,
      );
    }

    const versionResult = await client.query(
      `
        INSERT INTO actions.package_versions (
          id, package_id, version, manifest_json, manifest_checksum,
          artifact_checksum, validation_status, status, provenance_json
        )
        VALUES ($1, $2, '1.0.0', $3::jsonb, $4, $4, 'verified', 'active', $5::jsonb)
        ON CONFLICT (package_id, version) DO UPDATE
        SET manifest_json = EXCLUDED.manifest_json,
            manifest_checksum = EXCLUDED.manifest_checksum,
            artifact_checksum = EXCLUDED.artifact_checksum,
            validation_status = EXCLUDED.validation_status,
            status = EXCLUDED.status,
            provenance_json = EXCLUDED.provenance_json,
            updated_at = now()
        RETURNING id
      `,
      [
        versionId,
        resolvedPackageId,
        JSON.stringify(manifest),
        checksum,
        JSON.stringify({ source: "builtin-seed" }),
      ],
    );
    const resolvedVersionId = versionResult.rows[0]?.id;
    if (!resolvedVersionId) {
      throw new Error(
        `Could not seed action package version ${actionPackage.packageName}@1.0.0.`,
      );
    }

    await client.query(
      `
        INSERT INTO actions.dist_tags (id, package_id, tag, version_id, updated_by)
        VALUES ($1, $2, 'latest', $3, 'beam-studio-target-seed')
        ON CONFLICT (package_id, tag) DO UPDATE
        SET version_id = EXCLUDED.version_id,
            updated_by = EXCLUDED.updated_by,
            updated_at = now()
      `,
      [
        `dist-tag:${actionPackage.packageName}:latest`,
        resolvedPackageId,
        resolvedVersionId,
      ],
    );

    for (const requirement of actionPackage.requirements) {
      await client.query(
        `
          INSERT INTO actions.credential_requirements (
            id,
            package_version_id,
            requirement_key,
            display_name,
            description,
            accepted_capability_id,
            purpose,
            permissions_json
          )
          SELECT
            $1, $2, $3, $4, $5, cc.id, $6, $7::jsonb
          FROM secrets.credential_capabilities cc
          WHERE cc.slug = $8
          ON CONFLICT (package_version_id, requirement_key) DO UPDATE
          SET display_name = EXCLUDED.display_name,
              description = EXCLUDED.description,
              accepted_capability_id = EXCLUDED.accepted_capability_id,
              purpose = EXCLUDED.purpose,
              permissions_json = EXCLUDED.permissions_json,
              updated_at = now()
        `,
        [
          `credential-requirement:${actionPackage.packageName}:${requirement.key}`,
          resolvedVersionId,
          requirement.key,
          requirement.displayName,
          `Credential required by ${actionPackage.displayName}.`,
          requirement.capability,
          JSON.stringify([requirement.capability]),
          requirement.capability,
        ],
      );
    }
  }
}

function checksumJson(value) {
  return createHash("sha256")
    .update(JSON.stringify(stable(value)))
    .digest("hex");
}

function stable(value) {
  if (Array.isArray(value)) {
    return value.map(stable);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, stable(nested)]),
    );
  }
  return value;
}

function quoteIdentifier(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function loadEnvFile(path) {
  if (!existsSync(path)) {
    return;
  }

  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separator = trimmed.indexOf("=");
    if (separator === -1) {
      continue;
    }

    const key = trimmed.slice(0, separator).trim();
    const value = unquote(trimmed.slice(separator + 1).trim());
    process.env[key] ??= value;
  }
}

function unquote(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

function redactUrl(connectionString) {
  const url = new URL(connectionString);
  if (url.password) {
    url.password = "****";
  }
  return url.toString();
}

function readTargetSchema(path) {
  const parts = [readFileSync(path, "utf8").trim()];
  const extensionDir = path.replace(/\.sql$/, ".d");
  if (existsSync(extensionDir)) {
    for (const name of readdirSync(extensionDir).sort()) {
      if (!name.endsWith(".sql")) continue;
      const text = readFileSync(join(extensionDir, name), "utf8").trim();
      if (text) parts.push(text);
    }
  }
  return parts.join("\n\n");
}
