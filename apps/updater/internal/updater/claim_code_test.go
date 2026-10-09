package updater

import (
	"errors"
	"reflect"
	"testing"
)

func TestClaimCodeCommandRunsTheProductCodeInTheCurrentApiContainer(t *testing.T) {
	t.Parallel()
	config := Config{
		ComposeProject: "beam-studio",
		EnvFile:        "/opt/beam-studio/.env",
		DockerBinary:   "docker",
	}
	state := State{CurrentComposePath: "/opt/beam-studio/releases/1.2.3/compose.yml"}

	name, args, err := ClaimCodeCommand(config, state, false)
	if err != nil {
		t.Fatal(err)
	}
	expected := []string{
		"compose", "--project-name", "beam-studio",
		"--env-file", "/opt/beam-studio/.env",
		"--file", "/opt/beam-studio/releases/1.2.3/compose.yml",
		"exec", "-T", "api", "node", ClaimCodeScript,
	}
	if name != "docker" || !reflect.DeepEqual(args, expected) {
		t.Fatalf("unexpected command %s %v", name, args)
	}

	_, args, err = ClaimCodeCommand(config, state, true)
	if err != nil {
		t.Fatal(err)
	}
	if args[len(args)-1] != "--unclaimed-only" {
		t.Fatalf("expected --unclaimed-only to reach the script, received %v", args)
	}
}

func TestClaimCodeCommandNeedsAnInstalledRelease(t *testing.T) {
	t.Parallel()
	_, _, err := ClaimCodeCommand(Config{DockerBinary: "docker"}, State{}, false)
	if !errors.Is(err, ErrNotInstalled) {
		t.Fatalf("expected ErrNotInstalled, received %v", err)
	}
}
