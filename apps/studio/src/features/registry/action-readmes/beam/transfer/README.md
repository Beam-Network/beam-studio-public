# Beam Transfer

Copies objects from source storage to destination storage with a Beam transfer,
waits for the transfer to finish, and records it on the workflow run.

## Credentials

- A Beam API key credential (Studio can use its instance key). The key must be
  active and have the `transfers:create` permission. Transfers are billed to the
  key's organization.
- A storage credential for each source, with read access, and for each
  destination, with write access. They must not be IP- or network-restricted:
  Beam transfers data from many networks.

## Inputs

- `sourceEndpoints`: the objects to copy, usually from a previous storage endpoint step.
- `destinationEndpoints`: where to write them, usually from a previous storage endpoint step.

Each endpoint has a `provider` (`s3`, `r2`, `hippius` or another S3-compatible
provider), a `bucket`, an `objectKey` and the `credentialId` of its storage
credential. It can also set a `region`, an `endpointUrl` and a `storageLocation`,
the physical location of the data. Omit `storageLocation` when it is unknown.

Hippius endpoints default to `https://s3.hippius.com` and region `decentralized`.

## Configuration

- `credentialId`: the Beam API key credential.
- `name`: the transfer name shown in the Console. Without a name, the transfer is
  named `Workflow run <run ID>` after the run's ID in Studio.
- `distribute`: start delivery as soon as the transfer is created. Defaults to `true`.
- `maxDurationSeconds`: how long to wait for the transfer, up to 3,600 seconds
  (the default). A transfer still running after that is cancelled.
- `idempotencyKey`: a stable key for creating the transfer. Defaults to the
  workflow step run, so a retried step continues the same transfer.

## Outputs

- `beamTransferId`: the Beam transfer ID, as shown in the Console.
- `beamStatus`: the final transfer status.
- `chunksCompleted`: the number of completed deliveries.
- `destinationsCompleted`: the number of completed destinations.

## Behavior

- A retried or restarted step continues its existing transfer instead of
  starting a second one. If that transfer already completed, the step succeeds;
  if it failed or was cancelled, the step fails without retrying.
- Before a transfer completes, Beam checks the integrity of the delivered data.
  The step stays running during the check, and any warning from it is recorded
  in the step metadata.
- Cancelling the run cancels the transfer. The step can run for up to 65
  minutes: 60 minutes of transfer time plus time to cancel and clean up.
- Beam estimates a transfer's cost before it starts. If the organization's
  balance does not cover it, the step fails with "This transfer needs about N
  credits; your organization has M. Add credits in the Console."
- When the balance runs low, the step logs a warning and records the remaining
  credits in its metadata.
- If Beam refuses the API key, the step fails with "This Beam API key can't
  create transfers. Check that the key is active and has the transfers:create
  permission."
- Refused keys and missing credits are not retried; temporary connection
  problems are.

## Permissions

- `beam:transfer-create`
- `beam:transfer-read`
- `beam:transfer-cancel`
- `secrets:read`
- `network:nats`
