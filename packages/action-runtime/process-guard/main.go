package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"
)

const protocol = "action-process-ownership/v1"

type identity struct {
	PID   int    `json:"pid"`
	Birth string `json:"birth"`
	Scope string `json:"scope"`
}
type record struct {
	Protocol    string    `json:"protocol"`
	Nonce       string    `json:"nonce"`
	Owner       identity  `json:"owner"`
	Controller  *identity `json:"controller,omitempty"`
	Sandbox     *identity `json:"sandbox,omitempty"`
	BudgetToken string    `json:"budgetToken,omitempty"`
	State       string    `json:"state"`
}
type request struct {
	Operation string `json:"operation"`
	Path      string `json:"path"`
	Nonce     string `json:"nonce"`
	PID       int    `json:"pid"`
	Token     string `json:"token"`
}
type receipt struct {
	Protocol         string `json:"protocol"`
	Nonce            string `json:"nonce,omitempty"`
	State            string `json:"state,omitempty"`
	Scope            string `json:"scope,omitempty"`
	HostIdentity     string `json:"hostIdentity,omitempty"`
	BootID           string `json:"bootId,omitempty"`
	NativeScope      string `json:"nativeScope,omitempty"`
	CleanupConfirmed bool   `json:"cleanupConfirmed"`
	Error            string `json:"error,omitempty"`
	OOMKilled        bool   `json:"oomKilled,omitempty"`
	PeakMemoryBytes  uint64 `json:"peakMemoryBytes,omitempty"`
	CPUUsedMicros    uint64 `json:"cpuUsedMicros,omitempty"`
}

func main() {
	if len(os.Args) == 3 && os.Args[1] == "--budget-launch" {
		if err := launchBudgeted(os.Args[2]); err != nil {
			fmt.Fprintln(os.Stderr, "Action resource budget setup failed:", err)
			os.Exit(1)
		}
		return
	}
	if len(os.Args) == 2 && os.Args[1] == "--budget-probe-child" {
		time.Sleep(5 * time.Second)
		return
	}
	var input request
	decoder := json.NewDecoder(io.LimitReader(os.Stdin, 16*1024))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil {
		emit(receipt{Error: "Invalid process ownership request"})
		os.Exit(1)
	}
	result, err := execute(input)
	if err != nil {
		result = receipt{Error: err.Error()}
		emit(result)
		os.Exit(1)
	}
	emit(result)
}
func emit(result receipt) { result.Protocol = protocol; _ = json.NewEncoder(os.Stdout).Encode(result) }

func execute(input request) (receipt, error) {
	switch input.Operation {
	case "budget-probe":
		return probeBudget()
	case "budget-seal":
		return sealBudget(input.Token)
	case "budget-cleanup":
		return cleanupBudget(input.Token)
	}
	if input.Operation == "probe" {
		handle, err := openProcess(os.Getpid())
		if err != nil {
			return receipt{}, err
		}
		defer handle.close()
		hostIdentity, bootID, nativeScope, err := processHostEvidence()
		if err != nil {
			return receipt{}, err
		}
		if handle.identity().Scope != nativeScope {
			return receipt{}, errors.New("Native process scope changed during probe")
		}
		return receipt{State: "available", Scope: nativeScope, HostIdentity: hostIdentity,
			BootID: bootID, NativeScope: nativeScope}, nil
	}
	if !filepath.IsAbs(input.Path) || filepath.Base(input.Path) == "." {
		return receipt{}, errors.New("Process record requires an absolute local path")
	}
	if err := os.MkdirAll(filepath.Dir(input.Path), 0700); err != nil {
		return receipt{}, err
	}
	unlock, err := lockRecord(input.Path + ".lock")
	if err != nil {
		return receipt{}, err
	}
	defer unlock()
	if input.Operation == "prepare" {
		if _, err := os.Lstat(input.Path); !errors.Is(err, os.ErrNotExist) {
			return receipt{}, errors.New("Process ownership record already exists or is inaccessible")
		}
		owner, err := capture(input.PID)
		if err != nil {
			return receipt{}, err
		}
		nonce := make([]byte, 32)
		if _, err := rand.Read(nonce); err != nil {
			return receipt{}, err
		}
		state := record{Protocol: protocol, Nonce: hex.EncodeToString(nonce), Owner: owner, State: "prepared"}
		if err := save(input.Path, state); err != nil {
			return receipt{}, err
		}
		return receipt{Nonce: state.Nonce, State: state.State}, nil
	}
	state, err := load(input.Path, input.Nonce)
	if err != nil {
		return receipt{}, err
	}
	result := func() receipt {
		return receipt{Nonce: state.Nonce, State: state.State, CleanupConfirmed: state.State == "stopped"}
	}
	if state.State == "stopped" {
		if input.Operation == "stopped" || input.Operation == "reconcile" {
			return result(), nil
		}
		return receipt{}, errors.New("Process execution was already stopped")
	}
	switch input.Operation {
	case "controller", "bind-budget", "grant":
		if state.State != "prepared" {
			return receipt{}, errors.New("Process execution has already started or been fenced")
		}
		alive, err := matchingAlive(state.Owner)
		if err != nil {
			return receipt{}, err
		}
		if !alive {
			return receipt{}, errors.New("Process owner is no longer alive")
		}
		if input.Operation == "bind-budget" {
			if state.Controller == nil || state.BudgetToken != "" {
				return receipt{}, errors.New("Action budget ownership was not ready to bind")
			}
			alive, err := matchingAlive(*state.Controller)
			if err != nil || !alive {
				return receipt{}, errors.New("Runtime controller is no longer alive")
			}
			if _, err := budgetPath(input.Token); err != nil {
				return receipt{}, err
			}
			state.BudgetToken = input.Token
			break
		}
		child, err := capture(input.PID)
		if err != nil {
			return receipt{}, err
		}
		if child.Scope != state.Owner.Scope {
			return receipt{}, errors.New("Process ownership scope differs")
		}
		if input.Operation == "controller" {
			if state.Controller != nil {
				return receipt{}, errors.New("Runtime controller is already recorded")
			}
			state.Controller = &child
		} else {
			if state.Controller == nil {
				return receipt{}, errors.New("Runtime controller is not recorded")
			}
			alive, err := matchingAlive(*state.Controller)
			if err != nil {
				return receipt{}, err
			}
			if !alive {
				return receipt{}, errors.New("Runtime controller is no longer alive")
			}
			if input.Token != state.BudgetToken {
				return receipt{}, errors.New("Action budget token differs from the prepared ownership record")
			}
			if input.Token != "" {
				if err := confirmBudgetProcess(input.Token, input.PID); err != nil {
					return receipt{}, err
				}
			}
			state.Sandbox, state.State = &child, "running"
		}
	case "stopped":
		if state.Sandbox != nil {
			alive, err := matchingAlive(*state.Sandbox)
			if err != nil {
				return receipt{}, err
			}
			if alive {
				return receipt{}, errors.New("Sandbox termination remains unconfirmed")
			}
		}
		if state.BudgetToken != "" {
			if err := cleanupRecordedBudget(state.BudgetToken); err != nil {
				return receipt{}, err
			}
		}
		state.State = "stopped"
	case "reconcile":
		alive, err := matchingAlive(state.Owner)
		if err != nil {
			return receipt{}, err
		}
		if alive {
			// A live owner may have already waited for its dedicated controller
			// to exit. The controller identity can never be registered twice.
			if state.Controller == nil || *state.Controller == state.Owner {
				return result(), nil
			}
			controllerAlive, err := matchingAlive(*state.Controller)
			if err != nil {
				return receipt{}, err
			}
			if controllerAlive {
				return result(), nil
			}
		}
		// Commit the fence before stopping an orphaned controller. A delayed grant
		// cannot overwrite this decision or start a sandbox after reconciliation.
		state.State = "fenced"
		if err := save(input.Path, state); err != nil {
			return receipt{}, err
		}
		if state.Controller != nil && *state.Controller != state.Owner {
			if err := terminateMatching(*state.Controller); err != nil {
				return receipt{}, err
			}
		}
		if state.Sandbox != nil {
			if err := terminateMatching(*state.Sandbox); err != nil {
				return receipt{}, err
			}
		}
		if state.BudgetToken != "" {
			if err := cleanupRecordedBudget(state.BudgetToken); err != nil {
				return receipt{}, err
			}
		}
		state.State = "stopped"
	default:
		return receipt{}, errors.New("Unknown process ownership operation")
	}
	if err := save(input.Path, state); err != nil {
		return receipt{}, err
	}
	return result(), nil
}

func capture(pid int) (identity, error) {
	if pid <= 0 {
		return identity{}, errors.New("Invalid process identity")
	}
	handle, err := openProcess(pid)
	if err != nil {
		return identity{}, err
	}
	defer handle.close()
	if handle.exited() {
		return identity{}, errors.New("Process already exited")
	}
	return handle.identity(), nil
}
func matchingAlive(expected identity) (bool, error) {
	scope, err := processScope()
	if err != nil {
		return false, err
	}
	if scope != expected.Scope {
		return false, errors.New("Process scope changed; original host or namespace evidence is required")
	}
	handle, err := openProcess(expected.PID)
	if errors.Is(err, os.ErrProcessDone) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	defer handle.close()
	return handle.identity() == expected && !handle.exited(), nil
}
func terminateMatching(expected identity) error {
	scope, err := processScope()
	if err != nil {
		return err
	}
	if scope != expected.Scope {
		return errors.New("Cannot terminate a process in another ownership scope")
	}
	handle, err := openProcess(expected.PID)
	if errors.Is(err, os.ErrProcessDone) {
		return nil
	}
	if err != nil {
		return err
	}
	defer handle.close()
	if handle.identity() != expected || handle.exited() {
		return nil
	}
	if err := handle.kill(); err != nil {
		return err
	}
	deadline := time.Now().Add(3 * time.Second)
	for !handle.exited() {
		if time.Now().After(deadline) {
			return errors.New("Process termination was requested but remains unconfirmed")
		}
		time.Sleep(10 * time.Millisecond)
	}
	return nil
}
func load(path, nonce string) (record, error) {
	var state record
	bytes, err := os.ReadFile(path)
	if err != nil {
		return state, errors.New("Process ownership record is unavailable")
	}
	if len(bytes) > 16*1024 || json.Unmarshal(bytes, &state) != nil || state.Protocol != protocol || len(nonce) != 64 || state.Nonce != nonce || state.Owner.PID <= 0 || state.Owner.Birth == "" || state.Owner.Scope == "" {
		return state, errors.New("Process ownership record is invalid")
	}
	if state.State != "prepared" && state.State != "running" && state.State != "fenced" && state.State != "stopped" {
		return state, errors.New("Process ownership state is invalid")
	}
	if state.State == "running" && (state.Controller == nil || state.Sandbox == nil) {
		return state, errors.New("Running process identities are missing")
	}
	if state.BudgetToken != "" {
		decoded, err := hex.DecodeString(state.BudgetToken)
		if err != nil || len(decoded) != 16 {
			return state, errors.New("Recorded action budget token is invalid")
		}
	}
	for _, process := range []*identity{state.Controller, state.Sandbox} {
		if process != nil && (process.PID <= 0 || process.Birth == "" || process.Scope != state.Owner.Scope) {
			return state, errors.New("Recorded process identity is invalid")
		}
	}
	return state, nil
}
func save(path string, state record) error {
	bytes, err := json.Marshal(state)
	if err != nil {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(path), ".ownership-*")
	if err != nil {
		return err
	}
	temporary := file.Name()
	defer os.Remove(temporary)
	if err = file.Chmod(0600); err == nil {
		_, err = file.Write(bytes)
	}
	if err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if err = os.Rename(temporary, path); err != nil {
		return fmt.Errorf("commit process record: %w", err)
	}
	return syncDirectory(filepath.Dir(path))
}
