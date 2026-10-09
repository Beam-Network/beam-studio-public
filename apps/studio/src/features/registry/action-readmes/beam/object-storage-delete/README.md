# Object Storage Delete

Delete exact objects from S3-compatible object storage after a workflow step no longer needs them.

This action is intended for cleanup steps that should remove generated workflow outputs without deleting source fixtures or whole prefixes. It only accepts file object keys. Directory endpoints, trailing-slash prefixes, and wildcard keys are rejected.

## Inputs

- `endpoint`: One exact file endpoint object.
- `endpoints`: An array of exact file endpoint objects.
- `provider`, `bucket`, `objectKey`, `credentialId`: Top-level endpoint fields for single-object deletes.

## Outputs

- `deletedCount`: Number of delete calls completed.
- `uris`: Deleted object URIs.
- `objects`: Deleted object metadata.

## Permissions

- `storage:delete`
