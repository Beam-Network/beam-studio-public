package updater

import (
	"context"
	"fmt"
	"io"
)

// InstanceKeyRevokeScript revokes the Studio instance key at Beam and in the
// Studio database. It ships in the api image and runs inside the api
// container, which holds the vault key that decrypts the instance key.
const InstanceKeyRevokeScript = "/app/apps/api/dist/ops/instance-key-revoke-cli.js"

// InstanceKeyRevokeCommand is the docker invocation that revokes the instance
// key from the running api container of the current release.
func InstanceKeyRevokeCommand(config Config, state State) (string, []string, error) {
	if state.CurrentComposePath == "" {
		return "", nil, ErrNotInstalled
	}
	return config.DockerBinary, composeArguments(
		config,
		state.CurrentComposePath,
		"exec", "-T", "api", "node", InstanceKeyRevokeScript,
	), nil
}

// ComposeDownCommand stops and removes the Studio containers and networks of
// the current release. Volumes are kept: removing data is a separate,
// explicit step for the operator.
func ComposeDownCommand(config Config, state State) (string, []string, error) {
	if state.CurrentComposePath == "" {
		return "", nil, ErrNotInstalled
	}
	return config.DockerBinary, composeArguments(
		config,
		state.CurrentComposePath,
		"down",
	), nil
}

// Uninstall revokes the instance key, then stops and removes the Studio
// stack. The key is revoked first, while the api container that can decrypt
// it still runs: a key left live would keep acting for a Studio that no
// longer exists. When it cannot be revoked, Uninstall stops unless force is
// set, and tells the operator to revoke it in the Beam Console.
func Uninstall(
	ctx context.Context,
	runner CommandRunner,
	stdout io.Writer,
	stderr io.Writer,
	config Config,
	state State,
	force bool,
) error {
	name, args, err := InstanceKeyRevokeCommand(config, state)
	if err != nil {
		return err
	}
	if err := runner.Run(ctx, stdout, name, args...); err != nil {
		if !force {
			return fmt.Errorf(
				"the instance key was not revoked (%w); fix the cause and retry, or revoke \"Studio: <name>\" under API keys in the Beam Console and rerun with --force",
				err,
			)
		}
		fmt.Fprintln(stderr, "Warning: the instance key was not revoked. Revoke \"Studio: <name>\" under API keys in the Beam Console.")
	}
	name, args, err = ComposeDownCommand(config, state)
	if err != nil {
		return err
	}
	if err := runner.Run(ctx, stdout, name, args...); err != nil {
		return err
	}
	fmt.Fprintf(
		stdout,
		"Beam Studio is stopped and its containers are removed. Its data volumes and %s are kept.\n",
		config.EnvFile,
	)
	return nil
}
