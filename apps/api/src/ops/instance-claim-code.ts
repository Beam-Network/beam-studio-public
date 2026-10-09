import { instanceClaimCode } from "@beam-studio/shared/instance-claim";
import type { InstanceState } from "@beam-studio/db";

/**
 * What `instance-claim-code-cli` prints, decided without any I/O so it can be
 * tested.
 *
 * stdout carries the code and nothing else, so the installer and
 * `beam-updater claim-code` can capture it; every explanation goes to stderr.
 * The code is the one the claim route accepts because it comes from the same
 * derivation (`instanceClaimCode`) over the same `BEAM_STUDIO_SECRET_KEY`.
 */
export type ClaimCodeOutput = { stdout: string; stderr: string };

export function claimCodeOutput(input: {
  /** The instance state, or null when it could not be read. */
  state: InstanceState | null;
  /** Print nothing once the instance is claimed (the installer's mode). */
  unclaimedOnly: boolean;
  secret?: string;
}): ClaimCodeOutput {
  const code = instanceClaimCode(input.secret);
  if (input.state === "claimed") {
    const note =
      "This Studio is already claimed; the claim code is no longer accepted.\n";
    return input.unclaimedOnly
      ? { stdout: "", stderr: note }
      : { stdout: `${code}\n`, stderr: note };
  }
  if (input.state === null) {
    // Showing the code costs nothing when it turns out to be unneeded, while
    // hiding it could leave an operator unable to claim their own install.
    return {
      stdout: `${code}\n`,
      stderr:
        "Could not read whether this Studio is claimed; printing the claim code anyway.\n",
    };
  }
  return { stdout: `${code}\n`, stderr: "" };
}
