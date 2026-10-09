//go:build linux

package main

import (
	"crypto/rand"
	"encoding/hex"
	"golang.org/x/sys/unix"
	"os"
	"os/exec"
	"runtime"
	"testing"
)

func TestBudgetBindingSurvivesCrashBeforeSandboxGrant(t *testing.T) {
	owner, controller := fixture(t), fixture(t)
	path, nonce := prepared(t, owner.Process.Pid)
	operation(t, path, nonce, "controller", controller.Process.Pid)
	bytes := make([]byte, 16)
	if _, err := rand.Read(bytes); err != nil {
		t.Fatal(err)
	}
	token := hex.EncodeToString(bytes)
	if _, err := execute(request{Operation: "bind-budget", Path: path, Nonce: nonce, Token: token}); err != nil {
		t.Fatal(err)
	}
	state, err := load(path, nonce)
	if err != nil || state.BudgetToken != token || state.Sandbox != nil {
		t.Fatal("prelaunch budget token was not saved")
	}
	_ = owner.Process.Kill()
	_ = owner.Wait()
	if !operation(t, path, nonce, "reconcile", 0).CleanupConfirmed {
		t.Fatal("prelaunch budget record was not reconciled")
	}
}

func TestBudgetSubprocessFilter(t *testing.T) {
	if os.Getenv("BEAM_BUDGET_FILTER_TEST") == "1" {
		runtime.LockOSThread()
		if err := prohibitSubprocesses(); err != nil {
			t.Fatal(err)
		}
		pid, _, errno := unix.RawSyscall(unix.SYS_CLONE, 0, 0, 0)
		if pid == 0 && errno == 0 {
			os.Exit(77)
		}
		if errno != unix.EPERM {
			t.Fatalf("process clone was not denied: %v", errno)
		}
		return
	}
	command := exec.Command(os.Args[0], "-test.run=^TestBudgetSubprocessFilter$")
	command.Env = append(os.Environ(), "BEAM_BUDGET_FILTER_TEST=1")
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("subprocess filter was not enforced: %v: %s", err, output)
	}
}
