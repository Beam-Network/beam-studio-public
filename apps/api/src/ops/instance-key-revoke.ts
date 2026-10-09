/**
 * What `instance-key-revoke-cli` does, with its I/O injected so it can be
 * tested: revoke the owner organization's instance key before the
 * installation goes away, so no key tied to a deleted Studio stays live.
 */
export type InstanceKeyRevokeOutcome = { exitCode: 0 | 1; message: string };

export async function revokeInstanceKeyForUninstall(input: {
  /** The owner organization, or null when nobody owns the installation. */
  readOwner(): Promise<string | null>;
  revoke(organizationId: string): Promise<{ revoked: boolean }>;
}): Promise<InstanceKeyRevokeOutcome> {
  let owner: string | null;
  try {
    owner = await input.readOwner();
  } catch (error) {
    return {
      exitCode: 1,
      message: `Could not read who owns this Studio: ${errorText(error)}. If it holds an instance key, revoke "Studio: <name>" under API keys in the Beam Console.\n`,
    };
  }
  if (!owner) {
    return {
      exitCode: 0,
      message: "This Studio has no owner, so it holds no instance key.\n",
    };
  }
  try {
    const result = await input.revoke(owner);
    return {
      exitCode: 0,
      message: result.revoked
        ? "Revoked this Studio's instance key.\n"
        : "This Studio holds no instance key.\n",
    };
  } catch (error) {
    return {
      exitCode: 1,
      message: `Could not revoke this Studio's instance key: ${errorText(error)}. Revoke "Studio: <name>" under API keys in the Beam Console.\n`,
    };
  }
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
