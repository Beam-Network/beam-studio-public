//go:build linux

package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"golang.org/x/sys/unix"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"
	"unsafe"
)

const budgetCapability = "action-resource-budgets/v1"

type budgetLaunch struct {
	Token      string   `json:"token"`
	CPUTimeMs  uint64   `json:"cpuMillis"`
	MemoryMiB  uint64   `json:"memoryMiB"`
	Executable string   `json:"executable"`
	Arguments  []string `json:"arguments"`
}

var budgetToken = regexp.MustCompile(`^[a-f0-9]{32}$`)

func budgetParent() (string, error) {
	var stat unix.Statfs_t
	if err := unix.Statfs("/sys/fs/cgroup", &stat); err != nil || stat.Type != unix.CGROUP2_SUPER_MAGIC {
		return "", errors.New("A mounted cgroup v2 hierarchy is required")
	}
	content, err := os.ReadFile("/proc/self/cgroup")
	if err != nil {
		return "", err
	}
	current := ""
	for _, line := range strings.Split(string(content), "\n") {
		if strings.HasPrefix(line, "0::/") {
			current = filepath.Join("/sys/fs/cgroup", strings.TrimPrefix(line, "0::/"))
			break
		}
	}
	if current == "" || !strings.HasPrefix(current+"/", "/sys/fs/cgroup/") {
		return "", errors.New("The current cgroup v2 membership is unavailable")
	}
	if configured := os.Getenv("BEAM_ACTION_CGROUP_PARENT"); configured != "" {
		resolved, err := filepath.EvalSymlinks(configured)
		if err != nil || !filepath.IsAbs(configured) ||
			!strings.HasPrefix(resolved+"/", "/sys/fs/cgroup/") ||
			resolved == "/sys/fs/cgroup" ||
			(current != resolved && !strings.HasPrefix(current, resolved+"/")) {
			return "", errors.New("Invalid delegated action cgroup parent")
		}
		return resolved, nil
	}
	return current, nil
}

func budgetPath(token string) (string, error) {
	if !budgetToken.MatchString(token) {
		return "", errors.New("Invalid action budget token")
	}
	parent, err := budgetParent()
	if err != nil {
		return "", err
	}
	return filepath.Join(parent, "beam-action-"+token), nil
}

func writeControl(path, value string) error {
	return os.WriteFile(path, []byte(value), 0600)
}

func prepareBudget(token string, memoryMiB uint64) (string, error) {
	if memoryMiB == 0 || memoryMiB > (1<<40)/(1<<20) {
		return "", errors.New("Invalid action memory budget")
	}
	path, err := budgetPath(token)
	if err != nil {
		return "", err
	}
	if err := os.Mkdir(path, 0700); err != nil {
		return "", fmt.Errorf("Cannot create an action cgroup: %w", err)
	}
	if err := writeControl(filepath.Join(path, "memory.max"), strconv.FormatUint(memoryMiB*1024*1024, 10)); err != nil {
		_ = os.Remove(path)
		return "", fmt.Errorf("Cannot enforce peak action memory: %w", err)
	}
	if err := writeControl(filepath.Join(path, "memory.oom.group"), "1"); err != nil {
		_ = os.Remove(path)
		return "", fmt.Errorf("Cannot configure action memory termination: %w", err)
	}
	if _, err := os.ReadFile(filepath.Join(path, "memory.peak")); err != nil {
		_ = os.Remove(path)
		return "", fmt.Errorf("Cannot inspect peak action memory: %w", err)
	}
	if _, err := os.ReadFile(filepath.Join(path, "cpu.stat")); err != nil {
		_ = os.Remove(path)
		return "", fmt.Errorf("Cannot inspect cumulative action CPU: %w", err)
	}
	return path, nil
}

func launchBudgeted(payload string) error {
	var input budgetLaunch
	if len(payload) > 16*1024 || json.Unmarshal([]byte(payload), &input) != nil ||
		input.CPUTimeMs < 1000 || input.CPUTimeMs > 1<<40 ||
		!filepath.IsAbs(input.Executable) || len(input.Arguments) > 128 {
		return errors.New("Invalid native action resource budget")
	}
	path, err := prepareBudget(input.Token, input.MemoryMiB)
	if err != nil {
		return err
	}
	if err := writeControl(filepath.Join(path, "cgroup.procs"), strconv.Itoa(os.Getpid())); err != nil {
		_ = os.Remove(path)
		return fmt.Errorf("Cannot attach sandbox to its action cgroup: %w", err)
	}
	// RLIMIT_CPU is kernel-accounted cumulative process CPU across all threads.
	// Round down so the hard limit can never be larger than the manifest budget.
	seconds := input.CPUTimeMs / 1000
	if err := unix.Setrlimit(unix.RLIMIT_CPU, &unix.Rlimit{Cur: seconds, Max: seconds}); err != nil {
		return fmt.Errorf("Cannot enforce cumulative action CPU: %w", err)
	}
	if err := prohibitSubprocesses(); err != nil {
		return fmt.Errorf("Cannot prohibit action subprocesses: %w", err)
	}
	if channel := os.Getenv("NODE_CHANNEL_FD"); channel != "" {
		fd, err := strconv.Atoi(channel)
		if err != nil || fd < 3 || fd > 64 {
			return errors.New("Invalid action IPC descriptor")
		}
		flags, err := unix.FcntlInt(uintptr(fd), unix.F_GETFD, 0)
		if err != nil {
			return fmt.Errorf("Action IPC descriptor is unavailable: %w", err)
		}
		if _, err := unix.FcntlInt(uintptr(fd), unix.F_SETFD, flags&^unix.FD_CLOEXEC); err != nil {
			return fmt.Errorf("Cannot retain action IPC descriptor: %w", err)
		}
	}
	args := append([]string{input.Executable}, input.Arguments...)
	environment := make([]string, 0, len(os.Environ()))
	for _, entry := range os.Environ() {
		if !strings.HasPrefix(entry, "BEAM_ACTION_CGROUP_PARENT=") {
			environment = append(environment, entry)
		}
	}
	return unix.Exec(input.Executable, args, environment)
}

// seccomp is inherited across exec. Node can create CLONE_THREAD threads, but
// fork, vfork, clone without CLONE_THREAD, and clone3 cannot create processes.
// Denying clone3 as ENOSYS lets libc fall back to clone for ordinary threads.
func prohibitSubprocesses() error {
	var clone, fork, vfork uint32
	var architecture uint32
	switch runtime.GOARCH {
	case "amd64":
		clone, fork, vfork = 56, 57, 58
		architecture = 0xc000003e // AUDIT_ARCH_X86_64
	case "arm64":
		clone = 220
		architecture = 0xc00000b7 // AUDIT_ARCH_AARCH64
	default:
		return errors.New("Unsupported seccomp architecture")
	}
	const clone3 = 435
	deny := uint32(unix.SECCOMP_RET_ERRNO) | uint32(unix.EPERM)
	noSys := uint32(unix.SECCOMP_RET_ERRNO) | uint32(unix.ENOSYS)
	filter := []unix.SockFilter{
		{Code: unix.BPF_LD | unix.BPF_W | unix.BPF_ABS, K: 4}, // seccomp_data.arch
		{Code: unix.BPF_JMP | unix.BPF_JEQ | unix.BPF_K, K: architecture, Jt: 1},
		{Code: unix.BPF_RET | unix.BPF_K, K: unix.SECCOMP_RET_KILL_PROCESS},
		{Code: unix.BPF_LD | unix.BPF_W | unix.BPF_ABS, K: 0}, // seccomp_data.nr
	}
	if runtime.GOARCH == "amd64" {
		filter = append(filter,
			unix.SockFilter{Code: unix.BPF_ALU | unix.BPF_AND | unix.BPF_K, K: 0x40000000}, // x32 ABI
			unix.SockFilter{Code: unix.BPF_JMP | unix.BPF_JEQ | unix.BPF_K, K: 0, Jt: 1},
			unix.SockFilter{Code: unix.BPF_RET | unix.BPF_K, K: unix.SECCOMP_RET_KILL_PROCESS},
			unix.SockFilter{Code: unix.BPF_LD | unix.BPF_W | unix.BPF_ABS, K: 0},
		)
	}
	for _, number := range []uint32{fork, vfork} {
		if number == 0 {
			continue
		}
		filter = append(filter,
			unix.SockFilter{Code: unix.BPF_JMP | unix.BPF_JEQ | unix.BPF_K, K: number, Jf: 1},
			unix.SockFilter{Code: unix.BPF_RET | unix.BPF_K, K: deny},
		)
	}
	filter = append(filter,
		unix.SockFilter{Code: unix.BPF_JMP | unix.BPF_JEQ | unix.BPF_K, K: clone3, Jf: 1},
		unix.SockFilter{Code: unix.BPF_RET | unix.BPF_K, K: noSys},
		unix.SockFilter{Code: unix.BPF_JMP | unix.BPF_JEQ | unix.BPF_K, K: clone, Jf: 4},
		unix.SockFilter{Code: unix.BPF_LD | unix.BPF_W | unix.BPF_ABS, K: 16}, // args[0] low word
		unix.SockFilter{Code: unix.BPF_ALU | unix.BPF_AND | unix.BPF_K, K: unix.CLONE_THREAD},
		unix.SockFilter{Code: unix.BPF_JMP | unix.BPF_JEQ | unix.BPF_K, K: unix.CLONE_THREAD, Jt: 1},
		unix.SockFilter{Code: unix.BPF_RET | unix.BPF_K, K: deny},
		unix.SockFilter{Code: unix.BPF_RET | unix.BPF_K, K: unix.SECCOMP_RET_ALLOW},
	)
	program := unix.SockFprog{Len: uint16(len(filter)), Filter: &filter[0]}
	if err := unix.Prctl(unix.PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0); err != nil {
		return err
	}
	if err := unix.Prctl(unix.PR_SET_SECCOMP, unix.SECCOMP_MODE_FILTER, uintptr(unsafe.Pointer(&program)), 0, 0); err != nil {
		return err
	}
	runtime.KeepAlive(filter)
	return nil
}

func probeBudget() (receipt, error) {
	var limits unix.Rlimit
	if err := unix.Getrlimit(unix.RLIMIT_CPU, &limits); err != nil {
		return receipt{}, err
	}
	parent, err := budgetParent()
	if err != nil {
		return receipt{}, err
	}
	controllers, err := os.ReadFile(filepath.Join(parent, "cgroup.controllers"))
	available := make(map[string]bool)
	for _, controller := range strings.Fields(string(controllers)) {
		available[controller] = true
	}
	if err != nil || !available["memory"] || !available["pids"] {
		return receipt{}, errors.New("Memory and process cgroup controllers must be delegated")
	}
	token := fmt.Sprintf("%032x", time.Now().UnixNano())
	path, err := prepareBudget(token, 256)
	if err != nil {
		return receipt{}, err
	}
	defer os.Remove(path)
	// Test actual membership permission without moving the probing controller.
	child := exec.Command(os.Args[0], "--budget-probe-child")
	if err := child.Start(); err != nil {
		return receipt{}, err
	}
	defer func() { _ = child.Process.Kill(); _ = child.Wait() }()
	if err := writeControl(filepath.Join(path, "cgroup.procs"), strconv.Itoa(child.Process.Pid)); err != nil {
		return receipt{}, fmt.Errorf("Cannot attach an action process to cgroup: %w", err)
	}
	if err := writeControl(filepath.Join(path, "pids.max"), "64"); err != nil {
		return receipt{}, fmt.Errorf("Cannot enforce action process count: %w", err)
	}
	_ = child.Process.Kill()
	_ = child.Wait()
	if err := prohibitSubprocesses(); err != nil {
		return receipt{}, fmt.Errorf("Cannot install action subprocess filter: %w", err)
	}
	return receipt{State: "available", Scope: budgetCapability}, nil
}

func sealBudget(token string) (receipt, error) {
	path, err := budgetPath(token)
	if err != nil {
		return receipt{}, err
	}
	current, err := os.ReadFile(filepath.Join(path, "pids.current"))
	if err != nil {
		return receipt{}, err
	}
	count, err := strconv.ParseUint(strings.TrimSpace(string(current)), 10, 64)
	if err != nil || count == 0 {
		return receipt{}, errors.New("Action process membership is missing")
	}
	// seccomp denies process creation. Keep a small thread allowance because
	// libuv initializes its worker threads lazily after the ready handshake.
	if err := writeControl(filepath.Join(path, "pids.max"), "64"); err != nil {
		return receipt{}, err
	}
	return receipt{State: "sealed", Scope: budgetCapability}, nil
}

func cleanupBudget(token string) (receipt, error) {
	path, err := budgetPath(token)
	if err != nil {
		return receipt{}, err
	}
	if _, err := os.Stat(path); errors.Is(err, os.ErrNotExist) {
		return receipt{State: "stopped", CleanupConfirmed: true}, nil
	} else if err != nil {
		return receipt{}, err
	}
	events, err := os.ReadFile(filepath.Join(path, "memory.events"))
	if err != nil {
		return receipt{}, err
	}
	peak, err := os.ReadFile(filepath.Join(path, "memory.peak"))
	if err != nil {
		return receipt{}, err
	}
	cpu, err := os.ReadFile(filepath.Join(path, "cpu.stat"))
	if err != nil {
		return receipt{}, err
	}
	result := receipt{State: "stopped", CleanupConfirmed: true}
	for _, line := range strings.Split(string(events), "\n") {
		fields := strings.Fields(line)
		if len(fields) == 2 && fields[0] == "oom_kill" {
			result.OOMKilled = fields[1] != "0"
		}
	}
	result.PeakMemoryBytes, err = strconv.ParseUint(strings.TrimSpace(string(peak)), 10, 64)
	if err != nil {
		return receipt{}, err
	}
	for _, line := range strings.Split(string(cpu), "\n") {
		fields := strings.Fields(line)
		if len(fields) == 2 && fields[0] == "usage_usec" {
			result.CPUUsedMicros, err = strconv.ParseUint(fields[1], 10, 64)
			if err != nil {
				return receipt{}, err
			}
		}
	}
	if result.CPUUsedMicros == 0 {
		return receipt{}, errors.New("Cumulative action CPU evidence is unavailable")
	}
	if err := writeControl(filepath.Join(path, "cgroup.kill"), "1"); err != nil {
		return receipt{}, err
	}
	deadline := time.Now().Add(3 * time.Second)
	for {
		current, err := os.ReadFile(filepath.Join(path, "pids.current"))
		if err != nil {
			return receipt{}, err
		}
		if strings.TrimSpace(string(current)) == "0" {
			break
		}
		if time.Now().After(deadline) {
			return receipt{}, errors.New("Action process group termination remains unconfirmed")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err := os.Remove(path); err != nil {
		return receipt{}, err
	}
	return result, nil
}

func confirmBudgetProcess(token string, pid int) error {
	path, err := budgetPath(token)
	if err != nil {
		return err
	}
	content, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/cgroup")
	if err != nil {
		return err
	}
	for _, line := range strings.Split(string(content), "\n") {
		if strings.HasPrefix(line, "0::/") &&
			filepath.Join("/sys/fs/cgroup", strings.TrimPrefix(line, "0::/")) == path {
			return nil
		}
	}
	return errors.New("Sandbox is outside its enforced action cgroup")
}

func cleanupRecordedBudget(token string) error {
	path, err := budgetPath(token)
	if err != nil {
		return err
	}
	if _, err := os.Stat(path); errors.Is(err, os.ErrNotExist) {
		return nil
	} else if err != nil {
		return err
	}
	_, err = cleanupBudget(token)
	return err
}
