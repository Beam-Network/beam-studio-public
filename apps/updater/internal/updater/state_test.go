package updater

import (
	"path/filepath"
	"testing"
)

func TestStateStoreRoundTrip(t *testing.T) {
	t.Parallel()
	store := NewStateStore(filepath.Join(t.TempDir(), "state.json"))
	initial, err := store.Read()
	if err != nil {
		t.Fatal(err)
	}
	if initial.Phase != "idle" {
		t.Fatalf("expected idle state, received %q", initial.Phase)
	}

	expected := State{
		Phase:              "succeeded",
		CurrentVersion:     "1.2.3",
		CurrentComposePath: "/opt/beam-studio/releases/1.2.3/compose.yml",
	}
	if err := store.Write(expected); err != nil {
		t.Fatal(err)
	}
	actual, err := store.Read()
	if err != nil {
		t.Fatal(err)
	}
	if actual.CurrentVersion != expected.CurrentVersion {
		t.Fatalf("expected version %q, received %q", expected.CurrentVersion, actual.CurrentVersion)
	}
	if actual.UpdatedAt == "" {
		t.Fatal("expected state UpdatedAt to be populated")
	}
}

func TestPathInside(t *testing.T) {
	t.Parallel()
	root := "/opt/beam-studio/releases"
	if !pathInside(root, "/opt/beam-studio/releases/1.2.3") {
		t.Fatal("expected release path to be accepted")
	}
	if pathInside(root, "/opt/beam-studio/backups") {
		t.Fatal("expected path outside releases to be rejected")
	}
}
