package updater

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
)

type CommandRunner interface {
	Run(ctx context.Context, stdout io.Writer, name string, args ...string) error
}

type HostCommandRunner struct{}

func (HostCommandRunner) Run(
	ctx context.Context,
	stdout io.Writer,
	name string,
	args ...string,
) error {
	command := exec.CommandContext(ctx, name, args...)
	command.Stdin = nil
	command.Stdout = stdout
	command.Stderr = os.Stderr
	if err := command.Run(); err != nil {
		return fmt.Errorf("%s failed: %w", name, err)
	}
	return nil
}
