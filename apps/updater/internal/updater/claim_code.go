package updater

import "errors"

// ClaimCodeScript prints the instance claim code. It ships in the api image
// and runs inside the api container, which holds the BEAM_STUDIO_SECRET_KEY the
// claim route checks against, so the code is derived by the product code
// rather than re-implemented here.
const ClaimCodeScript = "/app/apps/api/dist/ops/instance-claim-code-cli.js"

// ErrNotInstalled is returned when no release has been applied yet, so there
// is no running api container to ask.
var ErrNotInstalled = errors.New("Beam Studio is not installed yet; run the installer first")

func composeArguments(config Config, composePath string, arguments ...string) []string {
	args := []string{
		"compose",
		"--project-name",
		config.ComposeProject,
		"--env-file",
		config.EnvFile,
		"--file",
		composePath,
	}
	return append(args, arguments...)
}

// ClaimCodeCommand is the docker invocation that prints the claim code from
// the running api container of the current release. The code is written to
// stdout only; the updater never logs it.
func ClaimCodeCommand(config Config, state State, unclaimedOnly bool) (string, []string, error) {
	if state.CurrentComposePath == "" {
		return "", nil, ErrNotInstalled
	}
	arguments := []string{"exec", "-T", "api", "node", ClaimCodeScript}
	if unclaimedOnly {
		arguments = append(arguments, "--unclaimed-only")
	}
	return config.DockerBinary, composeArguments(config, state.CurrentComposePath, arguments...), nil
}
