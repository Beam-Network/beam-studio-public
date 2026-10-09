package main

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestProcessFixture(t *testing.T) {
	if os.Getenv("BEAM_PROCESS_GUARD_FIXTURE") != "1" {
		return
	}
	for {
		time.Sleep(time.Second)
	}
}
func fixture(t *testing.T) *exec.Cmd {
	t.Helper()
	command := exec.Command(os.Args[0], "-test.run=^TestProcessFixture$")
	command.Env = append(os.Environ(), "BEAM_PROCESS_GUARD_FIXTURE=1")
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = command.Process.Kill(); _ = command.Wait() })
	return command
}
func prepared(t *testing.T, owner int) (string, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "ownership.json")
	result, err := execute(request{Operation: "prepare", Path: path, PID: owner})
	if err != nil {
		t.Fatal(err)
	}
	return path, result.Nonce
}
func operation(t *testing.T, path, nonce, op string, pid int) receipt {
	t.Helper()
	result, err := execute(request{Operation: op, Path: path, Nonce: nonce, PID: pid})
	if err != nil {
		t.Fatal(err)
	}
	return result
}
func TestProbeReturnsDurableHostEvidence(t *testing.T) {
	result, err := execute(request{Operation: "probe"})
	if err != nil {
		t.Fatal(err)
	}
	if result.State != "available" || result.Scope == "" || result.NativeScope != result.Scope || result.HostIdentity == "" || result.BootID == "" {
		t.Fatalf("incomplete host evidence: %+v", result)
	}
}
func TestCrashRecoveryStopsControllerAndSandbox(t *testing.T) {
	owner, controller, sandbox := fixture(t), fixture(t), fixture(t)
	path, nonce := prepared(t, owner.Process.Pid)
	operation(t, path, nonce, "controller", controller.Process.Pid)
	operation(t, path, nonce, "grant", sandbox.Process.Pid)
	if result := operation(t, path, nonce, "reconcile", 0); result.CleanupConfirmed {
		t.Fatal("live owner was reconciled")
	}
	if _, err := execute(request{Operation: "stopped", Path: path, Nonce: nonce}); err == nil {
		t.Fatal("live sandbox was reported stopped")
	}
	_ = owner.Process.Kill()
	_ = owner.Wait()
	result := operation(t, path, nonce, "reconcile", 0)
	if !result.CleanupConfirmed {
		t.Fatal("termination was not confirmed")
	}
	state, err := load(path, nonce)
	if err != nil {
		t.Fatal(err)
	}
	for _, process := range []*identity{state.Controller, state.Sandbox} {
		alive, err := matchingAlive(*process)
		if err != nil || alive {
			t.Fatalf("process survived reconciliation: %v %v", alive, err)
		}
	}
	if _, err := execute(request{Operation: "grant", Path: path, Nonce: nonce, PID: os.Getpid()}); err == nil {
		t.Fatal("fenced execution restarted")
	}
	if !operation(t, path, nonce, "reconcile", 0).CleanupConfirmed {
		t.Fatal("duplicate reconciliation lost evidence")
	}
}
func TestReusedPIDIsNeverTerminated(t *testing.T) {
	owner, sandbox := fixture(t), fixture(t)
	path, nonce := prepared(t, owner.Process.Pid)
	operation(t, path, nonce, "controller", owner.Process.Pid)
	operation(t, path, nonce, "grant", sandbox.Process.Pid)
	state, _ := load(path, nonce)
	state.Sandbox.Birth += "-previous-process"
	if err := save(path, state); err != nil {
		t.Fatal(err)
	}
	_ = owner.Process.Kill()
	_ = owner.Wait()
	if !operation(t, path, nonce, "reconcile", 0).CleanupConfirmed {
		t.Fatal("old identity remains unresolved")
	}
	current, err := capture(sandbox.Process.Pid)
	if err != nil {
		t.Fatal("reused process was killed:", err)
	}
	if alive, _ := matchingAlive(current); !alive {
		t.Fatal("new process was terminated")
	}
}
func TestCorruptMissingAndForeignScopeFailClosed(t *testing.T) {
	path, nonce := prepared(t, os.Getpid())
	if _, err := execute(request{Operation: "reconcile", Path: path, Nonce: strings.Repeat("0", 64)}); err == nil {
		t.Fatal("wrong nonce accepted")
	}
	state, _ := load(path, nonce)
	state.Owner.Scope = "another-host-or-namespace"
	if err := save(path, state); err != nil {
		t.Fatal(err)
	}
	if _, err := execute(request{Operation: "reconcile", Path: path, Nonce: nonce}); err == nil {
		t.Fatal("another namespace confirmed cleanup")
	}
	if err := os.WriteFile(path, []byte("incomplete"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := execute(request{Operation: "reconcile", Path: path, Nonce: nonce}); err == nil {
		t.Fatal("corrupt journal confirmed cleanup")
	}
	_ = os.Remove(path)
	if _, err := execute(request{Operation: "reconcile", Path: path, Nonce: nonce}); err == nil {
		t.Fatal("missing journal confirmed cleanup")
	}
}
func TestConcurrentReconciliationFencesDelayedGrant(t *testing.T) {
	owner := fixture(t)
	path, nonce := prepared(t, owner.Process.Pid)
	operation(t, path, nonce, "controller", owner.Process.Pid)
	_ = owner.Process.Kill()
	_ = owner.Wait()
	var group sync.WaitGroup
	for index := 0; index < 6; index++ {
		group.Go(func() {
			if _, err := execute(request{Operation: "reconcile", Path: path, Nonce: nonce}); err != nil {
				t.Error(err)
			}
		})
	}
	group.Wait()
	if _, err := execute(request{Operation: "grant", Path: path, Nonce: nonce, PID: os.Getpid()}); err == nil {
		t.Fatal("delayed grant accepted")
	}
	bytes, err := os.ReadFile(path)
	if err != nil || !json.Valid(bytes) {
		t.Fatal("record lost atomicity", err)
	}
}
