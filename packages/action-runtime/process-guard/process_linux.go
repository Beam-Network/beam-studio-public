//go:build linux

package main

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"golang.org/x/sys/unix"
	"os"
	"strconv"
	"strings"
)

func processHostEvidence() (string, string, string, error) {
	bootBytes, err := os.ReadFile("/proc/sys/kernel/random/boot_id")
	if err != nil {
		return "", "", "", err
	}
	bootID := strings.TrimSpace(string(bootBytes))
	if bootID == "" {
		return "", "", "", errors.New("Linux boot identity is unavailable")
	}
	var stableID string
	for _, candidate := range []string{"/sys/class/dmi/id/product_uuid", "/etc/machine-id"} {
		value, readErr := os.ReadFile(candidate)
		if readErr == nil && strings.TrimSpace(string(value)) != "" {
			stableID = strings.ToLower(strings.TrimSpace(string(value)))
			break
		}
	}
	if stableID == "" {
		return "", "", "", errors.New("Stable Linux host identity is unavailable")
	}
	hostDigest := sha256.Sum256([]byte("beam-action-host/v1\x00" + stableID))
	nativeScope, err := processScope()
	if err != nil {
		return "", "", "", err
	}
	return hex.EncodeToString(hostDigest[:]), bootID, nativeScope, nil
}

type processHandle struct {
	fd    int
	value identity
}

func processScope() (string, error) {
	boot, err := os.ReadFile("/proc/sys/kernel/random/boot_id")
	if err != nil {
		return "", err
	}
	namespace, err := os.Readlink("/proc/self/ns/pid")
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(boot)) + ":" + namespace, nil
}
func openProcess(pid int) (*processHandle, error) {
	fd, err := unix.PidfdOpen(pid, 0)
	if errors.Is(err, unix.ESRCH) {
		return nil, os.ErrProcessDone
	}
	if err != nil {
		return nil, fmt.Errorf("Process identity requires Linux pidfd support: %w", err)
	}
	fail := func(err error) (*processHandle, error) { _ = unix.Close(fd); return nil, err }
	stat, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if errors.Is(err, os.ErrNotExist) {
		return fail(os.ErrProcessDone)
	}
	if err != nil {
		return fail(err)
	}
	end := strings.LastIndex(string(stat), ") ")
	if end < 0 {
		return fail(errors.New("Invalid process stat identity"))
	}
	fields := strings.Fields(string(stat)[end+2:])
	if len(fields) < 20 {
		return fail(errors.New("Incomplete process stat identity"))
	}
	scope, err := processScope()
	if err != nil {
		return fail(err)
	}
	return &processHandle{fd: fd, value: identity{PID: pid, Birth: fields[19], Scope: scope}}, nil
}
func (h *processHandle) identity() identity { return h.value }
func (h *processHandle) close()             { _ = unix.Close(h.fd) }
func (h *processHandle) exited() bool {
	descriptors := []unix.PollFd{{Fd: int32(h.fd), Events: unix.POLLIN}}
	count, err := unix.Poll(descriptors, 0)
	return err == nil && count > 0 && descriptors[0].Revents&(unix.POLLIN|unix.POLLHUP) != 0
}
func (h *processHandle) kill() error {
	err := unix.PidfdSendSignal(h.fd, unix.SIGKILL, nil, 0)
	if errors.Is(err, unix.ESRCH) {
		return nil
	}
	return err
}
func lockRecord(path string) (func(), error) {
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err = unix.Flock(int(file.Fd()), unix.LOCK_EX); err != nil {
		_ = file.Close()
		return nil, err
	}
	return func() { _ = unix.Flock(int(file.Fd()), unix.LOCK_UN); _ = file.Close() }, nil
}
func syncDirectory(path string) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	return file.Sync()
}
