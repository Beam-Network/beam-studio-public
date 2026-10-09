/**
 * Catalog of providers that are not S3-compatible.
 *
 * S3-compatible providers come from provider-profiles.json, which is generated
 * data with a single consumer path. Everything else was previously hand-copied
 * into four separate UI surfaces — the provider picker, the edit modal, the
 * credential list, and the workflow canvas — each with its own field set. A
 * provider added to some but not all of them renders as a two-letter text
 * fallback or a generic icon on the ones that were missed, which is what
 * happened when Salesforce was added. This module is the one place to add one.
 *
 * The seeded provider_profiles rows in
 * packages/db/scripts/apply-beam-studio-target.mjs must agree with the `id` and
 * `credentialType` values here: the API resolves a credential's profile by that
 * id at save time, so an entry here without a matching seeded row fails with
 * "Unsupported credential provider".
 */

export type NativeProviderField = {
  name: string;
  label: string;
  defaultChecked?: boolean;
  instruction?: string;
  pattern?: string;
  type?: string;
  required?: boolean;
};

export type NativeCredentialTypeId =
  | "beam_api_key"
  | "gcs_service_account"
  | "huggingface_token"
  | "http_bearer_token"
  | "zapier_mcp"
  | "slack_bot_token"
  | "salesforce_client_credentials"
  | "salesforce_jwt"
  | "adobe_aep_oauth_s2s"
  | "snowflake_key_pair"
  | "snowflake_pat"
  | "databricks_oauth_m2m"
  | "databricks_pat";

export type NativeProvider = {
  /** Matches secrets.provider_profiles.id and the credential's `kind`. */
  id: string;
  credentialType: NativeCredentialTypeId;
  name: string;
  logo: string;
  description: string;
  fields: NativeProviderField[];
};

/**
 * Both Snowflake credential types identify the same way and differ only in the
 * secret they carry, so the shared halves are declared once.
 */
const snowflakeIdentityFields: NativeProviderField[] = [
  {
    name: "account",
    label: "Account identifier",
    required: true,
    instruction:
      "Organization and account, for example acme-prod_wh. Snowflake rejects a JWT whose account identifier contains periods, so use hyphens.",
  },
  { name: "user", label: "User", required: true },
  {
    name: "base_url",
    label: "Account URL",
    type: "url",
    required: true,
    instruction:
      "https://<account>.snowflakecomputing.com. Beam only reaches hosts named by this credential, so this is required even though it derives from the account.",
    pattern: "https://.+",
  },
];

const snowflakeSessionFields: NativeProviderField[] = [
  {
    name: "role",
    label: "Role",
    instruction: "Session role. Defaults to the user's default role.",
  },
  { name: "warehouse", label: "Warehouse" },
  { name: "database", label: "Database" },
  { name: "schema", label: "Schema" },
];

/** Both Databricks types address the same workspace and differ only in secret. */
const databricksWorkspaceFields: NativeProviderField[] = [
  {
    name: "base_url",
    label: "Workspace URL",
    type: "url",
    required: true,
    instruction:
      "https://<instance>.cloud.databricks.com, .azuredatabricks.net, or .gcp.databricks.com. Tokens are minted and API calls made against this same host.",
    pattern: "https://.+",
  },
];

const databricksSessionFields: NativeProviderField[] = [
  {
    name: "http_path",
    label: "SQL warehouse HTTP path",
    instruction:
      "Optional, for SQL warehouse access. Looks like /sql/1.0/warehouses/abc123.",
  },
  { name: "catalog", label: "Catalog" },
  { name: "schema", label: "Schema" },
];

export const nativeProviders: NativeProvider[] = [
  {
    id: "beam",
    credentialType: "beam_api_key",
    name: "Beam",
    logo: "/beam-logo-black.svg",
    description: "Beam API key and NATS settings used by transfer actions.",
    fields: [
      { name: "api_key", label: "API key", type: "password", required: true },
      {
        name: "nats_url",
        label: "Beam NATS URL",
        instruction:
          "Optional lifecycle endpoint stored with this credential. Use nats://127.0.0.1:4222 for a local stack or tls://orch-gateway.b1m.ai:4222 for production.",
        pattern: "(nats|tls)://.+",
      },
      {
        name: "environment",
        label: "Beam environment",
        instruction: "Optional Beam SDK environment, for example dev.",
      },
    ],
  },
  {
    id: "gcs",
    credentialType: "gcs_service_account",
    name: "Google Cloud Storage",
    logo: "/provider-logos/gcs.svg",
    description: "Service account credentials for Google Cloud Storage.",
    fields: [
      { name: "project_id", label: "Project ID", required: true },
      { name: "client_email", label: "Client email", required: true },
      {
        name: "private_key",
        label: "Private key",
        type: "password",
        required: true,
      },
    ],
  },
  {
    id: "huggingface-hub",
    credentialType: "huggingface_token",
    name: "Hugging Face Hub (token)",
    logo: "/provider-logos/huggingface.png",
    description:
      "Hub token for dataset, model, and Space repositories. Storage Buckets use the Hugging Face S3 credential instead.",
    fields: [
      {
        name: "token",
        label: "Access token",
        type: "password",
        required: true,
        instruction:
          "A Hub token from huggingface.co/settings/tokens. Read scope is enough to pull; write scope is needed to upload.",
      },
      {
        name: "endpoint",
        label: "Hub endpoint",
        instruction:
          "Optional override for a self-hosted Hub. Defaults to https://huggingface.co.",
      },
    ],
  },
  {
    id: "slack-bot",
    credentialType: "slack_bot_token",
    name: "Slack (bot token)",
    logo: "/provider-logos/slack.svg",
    description:
      "Bot token used by the Slack message action to post to a channel or direct message a person.",
    fields: [
      {
        name: "token",
        label: "Bot user OAuth token",
        type: "password",
        required: true,
        instruction:
          "Starts with xoxb-. From your Slack app under OAuth & Permissions, after adding the chat:write scope and installing the app. Add users:read.email as well to address people by email address. Invite the bot to any private channel it should post in.",
        pattern: "xox[bp]-.+",
      },
    ],
  },
  {
    id: "salesforce",
    credentialType: "salesforce_client_credentials",
    name: "Salesforce",
    logo: "/provider-logos/salesforce.png",
    description: "External Client App running as an integration user.",
    fields: [
      { name: "client_id", label: "Consumer key", required: true },
      {
        name: "client_secret",
        label: "Consumer secret",
        type: "password",
        required: true,
      },
      {
        name: "instance_url",
        label: "Instance URL",
        type: "url",
        required: true,
        instruction:
          "Your org's My Domain URL, for example https://acme.my.salesforce.com. Beam only reaches hosts named by this credential.",
        pattern: "https://.+",
      },
      {
        name: "api_version",
        label: "API version",
        instruction: "Salesforce REST API version. Defaults to v62.0.",
      },
    ],
  },
  {
    id: "salesforce-jwt",
    credentialType: "salesforce_jwt",
    name: "Salesforce (JWT bearer)",
    logo: "/provider-logos/salesforce.png",
    description: "Connected App signing a JWT for a pre-authorized user.",
    fields: [
      { name: "client_id", label: "Consumer key", required: true },
      {
        name: "username",
        label: "Integration user",
        required: true,
        instruction: "The Salesforce username the JWT is issued for.",
      },
      {
        name: "private_key",
        label: "Private key",
        type: "password",
        required: true,
        instruction:
          "PEM private key matching the certificate on the Connected App.",
      },
      {
        name: "login_url",
        label: "Login URL",
        type: "url",
        instruction:
          "https://login.salesforce.com for production, https://test.salesforce.com for a sandbox.",
        pattern: "https://.+",
      },
      {
        name: "instance_url",
        label: "Instance URL",
        type: "url",
        instruction:
          "Your org's My Domain URL. Required so Beam can reach the org after the token exchange.",
        pattern: "https://.+",
      },
      {
        name: "api_version",
        label: "API version",
        instruction: "Salesforce REST API version. Defaults to v62.0.",
      },
    ],
  },
  {
    id: "adobe-aep",
    credentialType: "adobe_aep_oauth_s2s",
    name: "Adobe Experience Platform",
    logo: "/provider-logos/adobe-aep.png",
    description: "OAuth Server-to-Server credentials for Platform APIs.",
    fields: [
      {
        name: "client_id",
        label: "Client ID",
        required: true,
        instruction:
          "From Adobe Developer Console. Also sent as the x-api-key header on every Platform call.",
      },
      {
        name: "client_secret",
        label: "Client secret",
        type: "password",
        required: true,
      },
      {
        name: "org_id",
        label: "IMS organization ID",
        required: true,
        instruction: "Sent as x-gw-ims-org-id. Ends in @AdobeOrg.",
        pattern: ".+@AdobeOrg",
      },
      {
        name: "sandbox_name",
        label: "Sandbox",
        required: true,
        instruction:
          "Sent as x-sandbox-name. Platform data is partitioned by sandbox; use prod for the production sandbox.",
      },
      {
        name: "scopes",
        label: "Scopes",
        instruction:
          "Comma-separated OAuth scopes requested when minting the token.",
      },
      {
        name: "login_url",
        label: "IMS host",
        type: "url",
        instruction:
          "Region-specific token host, for example https://ims-na1.adobelogin.com.",
        pattern: "https://.+",
      },
      {
        name: "base_url",
        label: "Platform API host",
        type: "url",
        instruction: "Usually https://platform.adobe.io.",
        pattern: "https://.+",
      },
    ],
  },
  {
    id: "snowflake",
    credentialType: "snowflake_key_pair",
    name: "Snowflake",
    logo: "/provider-logos/snowflake.svg",
    description: "RSA key-pair credentials for a service user.",
    fields: [
      ...snowflakeIdentityFields,
      {
        name: "private_key",
        label: "Private key",
        type: "password",
        required: true,
        instruction:
          "PEM private key whose public half is set on the Snowflake user with ALTER USER ... SET RSA_PUBLIC_KEY.",
      },
      {
        name: "private_key_passphrase",
        label: "Private key passphrase",
        type: "password",
        instruction: "Only if the private key is encrypted.",
      },
      ...snowflakeSessionFields,
    ],
  },
  {
    id: "databricks",
    credentialType: "databricks_oauth_m2m",
    name: "Databricks",
    logo: "/provider-logos/databricks.png",
    description:
      "OAuth machine-to-machine credentials for a service principal.",
    fields: [
      ...databricksWorkspaceFields,
      {
        name: "client_id",
        label: "Client ID",
        required: true,
        instruction: "The service principal's application ID.",
      },
      {
        name: "client_secret",
        label: "OAuth secret",
        type: "password",
        required: true,
      },
      ...databricksSessionFields,
    ],
  },
  {
    id: "databricks-pat",
    credentialType: "databricks_pat",
    name: "Databricks PAT",
    logo: "/provider-logos/databricks.png",
    description: "Personal Access Token for a workspace.",
    fields: [
      ...databricksWorkspaceFields,
      {
        name: "token",
        label: "Access token",
        type: "password",
        required: true,
        instruction:
          "Workspace personal access token, beginning dapi. Inherits the permissions of the user or service principal that created it.",
      },
      ...databricksSessionFields,
    ],
  },
  {
    id: "snowflake-pat",
    credentialType: "snowflake_pat",
    name: "Snowflake PAT",
    logo: "/provider-logos/snowflake.svg",
    description: "Programmatic Access Token, scoped to a single role.",
    fields: [
      ...snowflakeIdentityFields,
      {
        name: "token",
        label: "Access token",
        type: "password",
        required: true,
        instruction:
          "Programmatic access token. It inherits the role it was issued for, so the role field below must match.",
      },
      ...snowflakeSessionFields,
    ],
  },
  {
    id: "http",
    credentialType: "http_bearer_token",
    name: "HTTP endpoint",
    logo: "/provider-logos/http.svg",
    description:
      "Bearer token for HTTP requests, with an optional signing secret for webhook callbacks.",
    fields: [
      {
        name: "token",
        label: "Bearer token",
        type: "password",
        required: true,
        instruction:
          "Sent as Authorization: Bearer by HTTP Request and Webhook actions.",
      },
      {
        name: "signing_secret",
        label: "Signing secret",
        type: "password",
        instruction:
          "Optional. Keys the X-Beam-Signature HMAC so the receiver can verify a callback really came from Beam. Defaults to the bearer token.",
      },
      {
        name: "base_url",
        label: "Endpoint host",
        type: "url",
        instruction:
          "Optional endpoint host metadata for workers that enforce a network allowlist.",
        pattern: "https?://.+",
      },
    ],
  },
  {
    id: "zapier",
    credentialType: "zapier_mcp",
    name: "Zapier",
    logo: "/provider-logos/zapier.svg",
    description:
      "Zapier MCP server, which exposes your configured Zapier actions to the Zapier action.",
    fields: [
      {
        name: "base_url",
        label: "MCP server URL",
        type: "url",
        required: true,
        instruction:
          "Copy the server URL from mcp.zapier.com. It contains a secret, so treat it as one. Beam only reaches hosts named by this credential.",
        pattern: "https://.+",
      },
      {
        name: "api_key",
        label: "API key",
        type: "password",
        instruction:
          "Optional. Sent as Authorization: Bearer. Only needed when your Zapier MCP server is configured to require one on top of the URL secret.",
      },
    ],
  },
];

const nativeProviderIndex = new Map(
  nativeProviders.map((provider) => [provider.id, provider]),
);

export function getNativeProvider(id: string) {
  return nativeProviderIndex.get(id.trim().toLowerCase());
}

/** Display metadata for a provider id, for surfaces that only render a chip. */
export function nativeProviderDisplay(id: string) {
  const provider = getNativeProvider(id);
  return provider ? { logo: provider.logo, name: provider.name } : null;
}

/** Shared field-label lookup so every form spells a field the same way. */
export const nativeProviderFieldLabels: Record<string, string> =
  Object.fromEntries(
    nativeProviders.flatMap((provider) =>
      provider.fields.map((field) => [field.name, field.label]),
    ),
  );
