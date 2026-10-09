package updater

import (
	"bytes"
	"context"
	"errors"
	"io"
	"reflect"
	"strings"
	"testing"
)

type recordedRun struct {
	name string
	args []string
}

type scriptedRunner struct {
	runs []recordedRun
	fail map[int]error
}

func (runner *scriptedRunner) Run(_ context.Context, _ io.Writer, name string, args ...string) error {
	runner.runs = append(runner.runs, recordedRun{name: name, args: args})
	return runner.fail[len(runner.runs)-1]
}

func uninstallFixture() (Config, State) {
	return Config{
		ComposeProject: "beam-studio",
		EnvFile:        "/opt/beam-studio/.env",
		DockerBinary:   "docker",
	}, State{
		CurrentComposePath: "/opt/beam-studio/releases/1.2.3/compose.yml",
	}
}

func TestUninstallRevokesTheInstanceKeyBeforeStoppingStudio(t *testing.T) {
	t.Parallel()
	config, state := uninstallFixture()
	runner := &scriptedRunner{}
	var stdout bytes.Buffer
	if err := Uninstall(context.Background(), runner, &stdout, io.Discard, config, state, false); err != nil {
		t.Fatal(err)
	}
	compose := []string{
		"compose", "--project-name", "beam-studio",
		"--env-file", "/opt/beam-studio/.env",
		"--file", "/opt/beam-studio/releases/1.2.3/compose.yml",
	}
	expected := []recordedRun{
		{name: "docker", args: append(append([]string{}, compose...), "exec", "-T", "api", "node", InstanceKeyRevokeScript)},
		{name: "docker", args: append(append([]string{}, compose...), "down")},
	}
	if !reflect.DeepEqual(runner.runs, expected) {
		t.Fatalf("unexpected commands %v", runner.runs)
	}
	if !strings.Contains(stdout.String(), "data volumes") {
		t.Fatalf("expected the kept data to be named, received %q", stdout.String())
	}
}

func TestUninstallStopsWhenTheKeyCannotBeRevoked(t *testing.T) {
	t.Parallel()
	config, state := uninstallFixture()
	runner := &scriptedRunner{fail: map[int]error{0: errors.New("exit status 1")}}
	err := Uninstall(context.Background(), runner, io.Discard, io.Discard, config, state, false)
	if err == nil || !strings.Contains(err.Error(), "Beam Console") {
		t.Fatalf("expected a refusal naming the Console, received %v", err)
	}
	if len(runner.runs) != 1 {
		t.Fatalf("Studio must keep running when its key may still be live, ran %v", runner.runs)
	}
}

func TestUninstallWithForceContinuesAndWarns(t *testing.T) {
	t.Parallel()
	config, state := uninstallFixture()
	runner := &scriptedRunner{fail: map[int]error{0: errors.New("exit status 1")}}
	var stderr bytes.Buffer
	if err := Uninstall(context.Background(), runner, io.Discard, &stderr, config, state, true); err != nil {
		t.Fatal(err)
	}
	if len(runner.runs) != 2 || !strings.Contains(stderr.String(), "Beam Console") {
		t.Fatalf("expected the stack to stop with a warning, ran %v, warned %q", runner.runs, stderr.String())
	}
}

func TestUninstallNeedsAnInstalledRelease(t *testing.T) {
	t.Parallel()
	err := Uninstall(context.Background(), &scriptedRunner{}, io.Discard, io.Discard, Config{DockerBinary: "docker"}, State{}, false)
	if !errors.Is(err, ErrNotInstalled) {
		t.Fatalf("expected ErrNotInstalled, received %v", err)
	}
}
