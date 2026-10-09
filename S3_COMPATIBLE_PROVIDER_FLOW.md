# S3-compatible provider flow

Date: 2026-05-31

This document captures the next provider flow for `beam-transfer-cli` and the
later Studio UI implementation. The current source of truth lives in:

- `../beam-studio/packages/shared/src/provider-profiles.json`
- `../beam-studio/apps/studio/public/provider-logos/`

The autonomous `@beam/transfer` Registry action bundles
`@beam-network/sdk@0.5.0` and its `S3CompatibleProviderConfig` model. Studio
only supplies normalized endpoint and credential inputs. Provider profiles are
data, not one class per provider. Each profile selects the shared
`s3-compatible` driver and supplies the defaults needed by the action.

## A second driver: Hugging Face

The `s3-compatible` driver is no longer the only one. `huggingface` is a second
driver whose credential is a single Hub token and whose locations are
`repo_id` + `path` rather than `bucket` + `key`, so it deliberately sits outside
`provider-profiles.json` and outside `providerBaseSchema`.

Studio can now store a `huggingface_token` credential, validate a
`huggingFaceProviderConfigSchema` transfer config, browse a repo or bucket, and
read a source object's size.

What Studio cannot yet do is *run* such a transfer. The path is
`@beam/object-storage-endpoint` → `@beam/transfer`, and both are Registry action
packages outside this repository: the endpoint action emits an S3-shaped endpoint
(`bucket`, `objectKey`, `region`, `endpointUrl`), and `@beam/transfer` bundles a
pinned `@beam-network/sdk`. Ending that gap needs two Registry changes:

1. an endpoint action that can emit a Hugging Face location, and
2. a `@beam/transfer` build bundling a Beam SDK version that carries the
   `huggingface` provider.

## Goal

Expose many S3-compatible providers without adding custom signing code for each
one.

The BeamCore and worker contract remains unchanged:

1. Studio or CLI reads source/destination provider credentials.
2. Studio or CLI resolves the provider profile.
3. Studio or CLI builds `S3CompatibleProviderConfig`.
4. the Beam SDK signs HTTP GET, Range GET, PUT, multipart upload part, complete,
   and abort URLs.
5. BeamCore receives only signed HTTP routes.
6. Beam workers move bytes with HTTP URLs, not provider credentials.

## Profile JSON

Each profile has:

- `id`: stable provider id stored on endpoints, for example `wasabi`.
- `aliases`: accepted input aliases, for example `b2` -> `backblaze-b2`.
- `driver`: currently always `s3-compatible` for this catalog.
- `logo`: public Studio path, for example `/provider-logos/wasabi.svg`.
- `endpoint`: optional template or a hard requirement for `endpoint_url`.
- `region.default`: optional signing region default.
- `credential_fields`: fields the UI/CLI should request.
- `docs_url`: provider documentation to verify live behavior.

Endpoint templates use credential/profile values by name:

```json
{
  "id": "r2",
  "endpoint": {
    "template": "https://{account_id}.r2.cloudflarestorage.com",
    "template_variables": ["account_id"]
  }
}
```

If a profile cannot render its endpoint, the CLI should ask for `endpoint_url`.

## CLI implementation plan

1. Load the shared JSON catalog or keep a generated copy in the CLI package until
   the repos share a distributable package.
2. Normalize provider ids through `id` and `aliases`.
3. Store the endpoint provider id, bucket, key, credential id, optional region,
   optional endpoint URL, and optional `force_path_style`.
4. Store credentials as the same JSON payload shape used by Studio:
   `access_key_id`, `secret_access_key`, `session_token`, `region`,
   `endpoint_url`, provider-specific fields such as `account_id` or `namespace`.
5. Build SDK configs with:

```python
# conceptual shape; implementation can stay in Python.
S3CompatibleProviderConfig.create({
    "provider": profile["id"],
    "bucket": bucket,
    "key": key,
    "region": resolved_region,
    "endpoint_url": resolved_endpoint_url,
    "access_key_id": access_key_id,
    "secret_access_key": secret_access_key,
    "session_token": session_token,
    "force_path_style": resolved_force_path_style,
})
```

6. Keep native Hippius and GCS flows separate. They are not just S3 profile
   entries.

## Interface follow-up

The UI should consume the profile catalog instead of hardcoding provider cards.
Expected screens:

- provider picker grouped by hosted S3, cloud S3, and self-hosted S3;
- credential form generated from `credential_fields`;
- endpoint form that shows required template variables before falling back to
  `endpoint_url`;
- logo loaded from the `logo` field;
- validation checklist for HeadObject, Range GET, PutObject, multipart upload,
  complete, and abort.

## Current profile coverage

Studio currently has 34 S3-compatible profiles in JSON, including AWS S3,
Cloudflare R2, MinIO, Wasabi, Backblaze B2, DigitalOcean Spaces, Scaleway,
Akamai/Linode, Vultr, IBM COS, OVHcloud, Oracle OCI, Ceph RGW, Cloudian,
Garage, SeaweedFS, Storj, IDrive e2, Exoscale, Yandex, Tencent COS, Alibaba
OSS, Huawei OBS, Baidu BOS, Contabo, Hetzner, UpCloud, IONOS, Seagate Lyve
Cloud, NetApp StorageGRID, Dell ECS, and Pure Storage FlashBlade.
