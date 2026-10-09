type Row = Record<string, any>;

function object(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Row)
    : {};
}

/** Core's terminal lifecycle alone does not prove every frozen recipient received the file. */
export function verifiedRoomDeliveryStatus(status: Row): Row {
  if (!status || typeof status !== "object" || Array.isArray(status))
    return status;
  const publisher = object(status.publisher);
  const container = Object.hasOwn(publisher, "room_transfer")
    ? publisher
    : status;
  const transfer = object(container.room_transfer);
  if (
    transfer.status !== "completed" ||
    transfer.full_delivery_verified === true
  )
    return status;
  const projected = {
    ...container,
    ...(container === publisher ? { state: "failed" } : {}),
    room_transfer: {
      ...transfer,
      status: "failed",
      error_code: "room_transfer_delivery_unverified",
      error_message:
        "Core has not verified delivery to every frozen recipient.",
    },
  };
  return container === publisher
    ? { ...status, publisher: projected }
    : projected;
}

export function fullRoomDeliveryVerified(value: unknown) {
  const publication = object(value);
  const transfer = object(
    publication.room_transfer ?? object(publication.publisher).room_transfer,
  );
  return (
    transfer.status === "completed" && transfer.full_delivery_verified === true
  );
}
