package updater

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

const (
	PhaseIdle        = "idle"
	PhaseQueued      = "queued"
	PhaseChecking    = "checking"
	PhaseDownloading = "downloading"
	PhaseValidating  = "validating"
	PhasePulling     = "pulling"
	PhaseBackingUp   = "backing_up"
	PhaseDeploying   = "deploying"
	PhaseVerifying   = "verifying"
	PhaseRollingBack = "rolling_back"
	PhaseRecovering  = "recovering"
	PhaseSucceeded   = "succeeded"
	PhaseFailed      = "failed"
)

const (
	OperationApply    = "apply"
	OperationRollback = "rollback"
)

func terminalPhase(phase string) bool {
	return phase == PhaseSucceeded || phase == PhaseFailed
}

type State struct {
	OperationID         string            `json:"operationId,omitempty"`
	Operation           string            `json:"operation,omitempty"`
	Phase               string            `json:"phase"`
	CurrentVersion      string            `json:"currentVersion,omitempty"`
	CurrentSequence     uint64            `json:"currentSequence,omitempty"`
	CurrentComposePath  string            `json:"currentComposePath,omitempty"`
	CurrentImages       map[string]string `json:"currentImages,omitempty"`
	PreviousVersion     string            `json:"previousVersion,omitempty"`
	PreviousSequence    uint64            `json:"previousSequence,omitempty"`
	PreviousComposePath string            `json:"previousComposePath,omitempty"`
	PreviousImages      map[string]string `json:"previousImages,omitempty"`
	TargetVersion       string            `json:"targetVersion,omitempty"`
	TargetSequence      uint64            `json:"targetSequence,omitempty"`
	TargetComposePath   string            `json:"targetComposePath,omitempty"`
	TargetImages        map[string]string `json:"targetImages,omitempty"`
	CompletedImagePulls []string          `json:"completedImagePulls,omitempty"`
	AcceptedSequences   map[string]uint64 `json:"acceptedSequences,omitempty"`
	PreviousRestored    bool              `json:"previousRestored,omitempty"`
	Message             string            `json:"message,omitempty"`
	Error               string            `json:"error,omitempty"`
	StartedAt           string            `json:"startedAt,omitempty"`
	CompletedAt         string            `json:"completedAt,omitempty"`
	UpdatedAt           string            `json:"updatedAt"`
}

type StateStore struct {
	path string
	mu   sync.Mutex
}

func NewStateStore(path string) *StateStore {
	return &StateStore{path: path}
}

func (store *StateStore) Read() (State, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	return store.readUnlocked()
}

func (store *StateStore) Write(state State) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	return store.writeUnlocked(state)
}

func (store *StateStore) Update(update func(*State)) (State, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	state, err := store.readUnlocked()
	if err != nil {
		return State{}, err
	}
	update(&state)
	if err := store.writeUnlocked(state); err != nil {
		return State{}, err
	}
	return state, nil
}

func (store *StateStore) readUnlocked() (State, error) {
	data, err := os.ReadFile(store.path)
	if os.IsNotExist(err) {
		return State{Phase: PhaseIdle, UpdatedAt: time.Now().UTC().Format(time.RFC3339)}, nil
	}
	if err != nil {
		return State{}, fmt.Errorf("read updater state: %w", err)
	}
	var state State
	if err := json.Unmarshal(data, &state); err != nil {
		return State{}, fmt.Errorf("parse updater state: %w", err)
	}
	if state.Phase == "" {
		state.Phase = PhaseIdle
	}
	return state, nil
}

func (store *StateStore) writeUnlocked(state State) error {
	state.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	data, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return fmt.Errorf("encode updater state: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(store.path), 0750); err != nil {
		return fmt.Errorf("create updater state directory: %w", err)
	}
	temporary, err := os.CreateTemp(filepath.Dir(store.path), ".state-*.json")
	if err != nil {
		return fmt.Errorf("create updater state file: %w", err)
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0640); err != nil {
		temporary.Close()
		return err
	}
	if _, err := temporary.Write(append(data, '\n')); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := os.Rename(temporaryPath, store.path); err != nil {
		return fmt.Errorf("replace updater state: %w", err)
	}
	if err := syncParentDirectory(store.path); err != nil {
		return fmt.Errorf("sync updater state directory: %w", err)
	}
	return nil
}

func syncParentDirectory(path string) error {
	directory, err := os.Open(filepath.Dir(path))
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}
