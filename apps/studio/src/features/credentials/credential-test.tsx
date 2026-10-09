import { apiSend } from "@/lib/api-client";
import { cn } from "@/lib/utils";

/**
 * Shared connection-test client and result banner.
 *
 * Both credential forms — the modal and the create page — run the same test
 * against the same endpoint, so the request shape and the way an outcome is
 * presented live here rather than being kept in step by hand.
 */

export type CredentialTestResult = {
  status: "valid" | "invalid" | "error" | "skipped";
  errorCode?: string;
  errorMessage?: string;
};

export async function testCredential(input: {
  kind: string;
  payload: Record<string, unknown>;
  /**
   * Set when editing. Blank password fields mean "keep the stored value", so
   * the server merges the saved payload underneath before probing.
   */
  credentialId: string | null;
}) {
  const response = await apiSend<{ result: CredentialTestResult }>(
    "POST",
    "/studio/credentials/test",
    input,
  );
  return response.result;
}

/**
 * A rejection and an unreachable host are different problems and warrant
 * different responses, so each outcome gets its own treatment rather than
 * collapsing into one error style.
 */
export function TestResultBanner({ result }: { result: CredentialTestResult }) {
  if (result.status === "valid") {
    return (
      <p className="rounded-control border border-success/40 bg-success/10 p-3 text-sm text-success">
        Connection succeeded. These credentials authenticate.
      </p>
    );
  }

  if (result.status === "skipped") {
    return (
      <p className="rounded-control border border-muted-foreground/30 bg-muted/40 p-3 text-sm text-muted-foreground">
        {result.errorMessage ??
          "No connection test is available for this provider."}
      </p>
    );
  }

  const unreachable = result.status === "error";
  return (
    <p
      className={cn(
        "rounded-control border p-3 text-sm",
        unreachable
          ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400"
          : "border-destructive/40 bg-destructive/10 text-destructive",
      )}
    >
      {unreachable
        ? "Could not reach the provider: "
        : "The provider rejected these credentials: "}
      {result.errorMessage ?? "unknown error"}
    </p>
  );
}
