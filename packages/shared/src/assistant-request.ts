export type AssistantRequestStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export type AssistantRequestSummary = {
  id: string;
  conversationId: string;
  status: AssistantRequestStatus;
  error: string | null;
  errorCode: string | null;
  createdAt: string;
  completedAt: string | null;
};

export function isAssistantRequestActive(
  request: Pick<AssistantRequestSummary, "status"> | null | undefined,
) {
  return request?.status === "queued" || request?.status === "running";
}
