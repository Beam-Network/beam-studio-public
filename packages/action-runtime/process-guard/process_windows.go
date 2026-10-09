//go:build windows

package main

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
	"os"
	"strconv"
	"strings"
)

type processHandle struct {
	handle windows.Handle
	value  identity
}

func processScope() (string, error) {
	key, err := registry.OpenKey(registry.LOCAL_MACHINE, `SOFTWARE\Microsoft\Cryptography`, registry.QUERY_VALUE|registry.WOW64_64KEY)
	if err != nil {
		return "", err
	}
	defer key.Close()
	value, _, err := key.GetStringValue("MachineGuid")
	return value, err
}
func processHostEvidence() (string, string, string, error) {
	scope, err := processScope()
	if err != nil {
		return "", "", "", err
	}
	digest := sha256.Sum256([]byte("beam-action-host/v1\x00" + strings.ToLower(strings.TrimSpace(scope))))
	// The trusted prior-boot operator is Linux-only. Preserve the native
	// Windows host scope here without claiming a separately attestable boot.
	return hex.EncodeToString(digest[:]), scope, scope, nil
}
func openProcess(pid int) (*processHandle, error) {
	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION|windows.PROCESS_TERMINATE|windows.SYNCHRONIZE, false, uint32(pid))
	if errors.Is(err, windows.ERROR_INVALID_PARAMETER) {
		return nil, os.ErrProcessDone
	}
	if err != nil {
		return nil, err
	}
	fail := func(err error) (*processHandle, error) { _ = windows.CloseHandle(handle); return nil, err }
	var creation, exit, kernel, user windows.Filetime
	if err = windows.GetProcessTimes(handle, &creation, &exit, &kernel, &user); err != nil {
		return fail(err)
	}
	scope, err := processScope()
	if err != nil {
		return fail(err)
	}
	birth := uint64(creation.HighDateTime)<<32 | uint64(creation.LowDateTime)
	return &processHandle{handle: handle, value: identity{PID: pid, Birth: strconv.FormatUint(birth, 10), Scope: scope}}, nil
}
func (h *processHandle) identity() identity { return h.value }
func (h *processHandle) close()             { _ = windows.CloseHandle(h.handle) }
func (h *processHandle) exited() bool {
	result, err := windows.WaitForSingleObject(h.handle, 0)
	return err == nil && result == windows.WAIT_OBJECT_0
}
func (h *processHandle) kill() error {
	if h.exited() {
		return nil
	}
	return windows.TerminateProcess(h.handle, 1)
}
func lockRecord(path string) (func(), error) {
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	var position windows.Overlapped
	if err = windows.LockFileEx(windows.Handle(file.Fd()), windows.LOCKFILE_EXCLUSIVE_LOCK, 0, 1, 0, &position); err != nil {
		_ = file.Close()
		return nil, err
	}
	return func() { _ = windows.UnlockFileEx(windows.Handle(file.Fd()), 0, 1, 0, &position); _ = file.Close() }, nil
}

// File contents are flushed before MoveFileEx atomically replaces the record.
// Windows does not support fsync on an ordinary directory handle.
func syncDirectory(string) error { return nil }
