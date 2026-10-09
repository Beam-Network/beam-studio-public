import type { TransferPrepareResponse } from "@beam-network/sdk";

/** Bind metadata to the prepared Runtime plan; never persist the ownership key. */
export function standardRoomBindingInput(
  prepared: TransferPrepareResponse,
  targets: Array<{
    memberId: string;
    resourceId: string;
    destinationId: string;
  }>,
) {
  const source = prepared.plan_descriptor.sources[0];
  if (
    !prepared.transfer_key ||
    prepared.plan_descriptor.sources.length !== 1 ||
    !source ||
    targets.length !== prepared.plan_descriptor.destinations.length
  )
    throw new Error("room_standard_binding_invalid");
  const seen = new Set<string>();
  const destinations = targets.map((target) => {
    const destination = prepared.plan_descriptor.destinations.find(
      (value) => value.destination_id === target.destinationId,
    );
    const objectKey = destination?.final_object_keys[source.source_id];
    if (
      !destination ||
      !objectKey ||
      !target.memberId ||
      !target.resourceId ||
      seen.has(target.destinationId)
    ) {
      throw new Error("room_storage_destination_identity_unavailable");
    }
    seen.add(target.destinationId);
    return {
      member_id: target.memberId,
      resource_id: target.resourceId,
      destination_id: target.destinationId,
      destination_index: destination.destination_index,
      object_key: objectKey,
    };
  });
  return {
    transfer_key: prepared.transfer_key,
    standard_transfer: {
      transfer_id: prepared.transfer_id,
      plan_fingerprint: prepared.plan_fingerprint,
      source_id: source.source_id,
      destinations,
    },
  };
}
