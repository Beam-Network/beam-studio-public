import {
  WorkflowAuthorityUnavailableError,
  WorkflowAuthorizationError,
} from "@beam-studio/db";

type Row = Record<string, any>;

export type RegistryArtifactSigner = (input: {
  organizationId: string;
  step: Row;
}) => Promise<string | null>;

const signWithOrganizationKey: RegistryArtifactSigner = async (input) =>
  (await import("./store.js")).signedRegistryArtifactUrlForStep(input);

/**
 * The signed Registry URL to freeze into one dispatch of a step, or null to
 * keep the step's own URL. Executors hold no Registry credential: a private
 * artifact reaches them only through this short-lived URL, bound to the
 * artifact's sha256 and verified against the run's frozen checksum on
 * download. It belongs to the dispatch, never to the run or the catalog.
 *
 * - no signed URL issued, or signing fails for a non-private package: null;
 * - signing fails for a private package: retryable dispatch error;
 * - the Registry reports another sha256: dispatch refused.
 */
export async function freezeRegistryArtifactUrl(
  run: Row,
  step: Row,
  sign: RegistryArtifactSigner = signWithOrganizationKey,
): Promise<string | null> {
  if (step.sourceRegistry !== "public-registry") return null;
  try {
    return await sign({ organizationId: String(run.organization_id), step });
  } catch (error) {
    if (
      (error as { code?: unknown })?.code ===
      "registry_artifact_checksum_mismatch"
    )
      throw new WorkflowAuthorizationError(
        "executor_artifact_integrity_changed",
        "The Registry no longer serves this step's frozen artifact.",
      );
    // A public or unlisted artifact stays readable at its plain Registry URL;
    // only a private one depends on the signed URL.
    if (step.provenance?.registryVisibility !== "private") return null;
    throw new WorkflowAuthorityUnavailableError(
      "executor_artifact_url_unavailable",
      "A signed download URL for the private action could not be issued.",
    );
  }
}
