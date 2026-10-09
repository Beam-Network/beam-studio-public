type Identity = {
  workflowId: string;
  organizationId: string;
  credentialId?: string;
  environment?: string;
};

export async function managedQualificationInput(
  _identity: Identity,
): Promise<Record<string, unknown>> {
  return {};
}

export async function assertWorkflowAdmissions(
  _environment: unknown,
  _steps: Array<{ actionPackage?: unknown }>,
): Promise<void> {}

export function deferredScheduleReason(_error: unknown): string | null {
  return null;
}
