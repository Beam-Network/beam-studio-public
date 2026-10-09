package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/Beam-Network/beam-studio-public/apps/updater/internal/updater"
)

var version = "dev"

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(arguments []string) error {
	if len(arguments) == 0 {
		return usageError()
	}
	command := arguments[0]
	if command == "version" || command == "--version" {
		fmt.Println(version)
		return nil
	}

	flags := flag.NewFlagSet(command, flag.ContinueOnError)
	configPath := flags.String("config", "/etc/beam-studio/updater.json", "updater config path")
	wait := flags.Bool("wait", false, "wait for the operation to complete")
	force := flags.Bool("force", false, "apply: install even when the version is not newer; uninstall: continue when the instance key cannot be revoked")
	unclaimedOnly := flags.Bool("unclaimed-only", false, "claim-code: print nothing once the instance is claimed")
	if err := flags.Parse(arguments[1:]); err != nil {
		return err
	}
	config, err := updater.LoadConfig(*configPath)
	if err != nil {
		return err
	}

	switch command {
	case "serve":
		return serve(config)
	case "health", "status", "check":
		_, err := requestAndPrint(config.SocketPath, http.MethodGet, "/v1/"+command, nil)
		return err
	case "apply":
		body, _ := json.Marshal(map[string]bool{"force": *force})
		response, err := requestOperation(config.SocketPath, "/v1/apply", body, *wait)
		if err != nil {
			return err
		}
		if *wait {
			operationID, err := acceptedOperationID(response)
			if err != nil {
				return err
			}
			return waitForOperation(
				config.SocketPath,
				operationID,
				2*config.UpdateTimeout()+30*time.Second,
			)
		}
		return nil
	case "claim-code":
		return printClaimCode(config, *unclaimedOnly)
	case "uninstall":
		return uninstall(config, *force)
	case "rollback":
		response, err := requestOperation(config.SocketPath, "/v1/rollback", nil, *wait)
		if err != nil {
			return err
		}
		if *wait {
			operationID, err := acceptedOperationID(response)
			if err != nil {
				return err
			}
			return waitForOperation(
				config.SocketPath,
				operationID,
				2*config.UpdateTimeout()+30*time.Second,
			)
		}
		return nil
	default:
		return usageError()
	}
}

func serve(config updater.Config) error {
	supervisor := updater.NewSupervisor(config, version)
	reconcileContext, cancelReconcile := context.WithTimeout(
		context.Background(),
		config.UpdateTimeout(),
	)
	if err := supervisor.Reconcile(reconcileContext); err != nil {
		fmt.Fprintf(os.Stderr, "Beam Studio startup recovery failed: %v\n", err)
	}
	cancelReconcile()
	server := updater.NewServer(config, supervisor)
	signalContext, stop := signal.NotifyContext(
		context.Background(),
		syscall.SIGINT,
		syscall.SIGTERM,
	)
	defer stop()
	serverResult := make(chan error, 1)
	go func() {
		serverResult <- server.ListenAndServe()
	}()
	select {
	case err := <-serverResult:
		return err
	case <-signalContext.Done():
	}
	closeErr := server.Close()
	shutdownContext, cancel := context.WithTimeout(
		context.Background(),
		2*config.UpdateTimeout()+30*time.Second,
	)
	defer cancel()
	shutdownErr := supervisor.Shutdown(shutdownContext)
	serverErr := <-serverResult
	return errors.Join(closeErr, shutdownErr, serverErr)
}

// printClaimCode writes the instance claim code to stdout, for the operator
// to enter once in Settings -> Access. It asks the running api container, so
// the code always matches the key the API checks against.
func printClaimCode(config updater.Config, unclaimedOnly bool) error {
	state, err := updater.NewStateStore(config.StatePath()).Read()
	if err != nil {
		return err
	}
	name, args, err := updater.ClaimCodeCommand(config, state, unclaimedOnly)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	return updater.HostCommandRunner{}.Run(ctx, os.Stdout, name, args...)
}

func uninstall(config updater.Config, force bool) error {
	state, err := updater.NewStateStore(config.StatePath()).Read()
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	return updater.Uninstall(ctx, updater.HostCommandRunner{}, os.Stdout, os.Stderr, config, state, force)
}

func requestAndPrint(socketPath, method, path string, body []byte) ([]byte, error) {
	status, response, err := unixRequest(socketPath, method, path, body)
	if err != nil {
		return nil, err
	}
	fmt.Println(strings.TrimSpace(string(response)))
	if status < 200 || status >= 300 {
		return response, fmt.Errorf("updater returned HTTP %d", status)
	}
	return response, nil
}

func requestOperation(socketPath, path string, body []byte, wait bool) ([]byte, error) {
	if !wait {
		return requestAndPrint(socketPath, http.MethodPost, path, body)
	}
	status, response, err := unixRequest(socketPath, http.MethodPost, path, body)
	if err != nil {
		return nil, err
	}
	if status < 200 || status >= 300 {
		return response, fmt.Errorf("updater returned HTTP %d: %s", status, strings.TrimSpace(string(response)))
	}
	return response, nil
}

func acceptedOperationID(response []byte) (string, error) {
	var accepted struct {
		OperationID string `json:"operationId"`
	}
	if err := json.Unmarshal(response, &accepted); err != nil {
		return "", fmt.Errorf("parse accepted updater operation: %w", err)
	}
	if accepted.OperationID == "" {
		return "", errors.New("updater did not return an operation ID")
	}
	return accepted.OperationID, nil
}

func waitForOperation(socketPath string, operationID string, timeout time.Duration) error {
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	terminal, err := os.Stdout.Stat()
	progress := operationProgress{
		output:      os.Stdout,
		interactive: err == nil && terminal.Mode()&os.ModeCharDevice != 0 && os.Getenv("TERM") != "dumb",
	}
	defer progress.finish()
	lastPhase := updater.PhaseQueued
	lastMessage := "operation accepted"
	for {
		select {
		case <-deadline.C:
			return fmt.Errorf(
				"updater operation %s timed out after %s in phase %s: %s",
				operationID,
				timeout,
				lastPhase,
				lastMessage,
			)
		case <-ticker.C:
		}
		status, response, err := unixRequest(socketPath, http.MethodGet, "/v1/status", nil)
		if err != nil {
			return err
		}
		if status != http.StatusOK {
			return fmt.Errorf("updater status returned HTTP %d: %s", status, response)
		}
		var state updater.State
		if err := json.Unmarshal(response, &state); err != nil {
			return err
		}
		if state.OperationID != operationID {
			return fmt.Errorf(
				"updater operation %s was replaced by operation %s",
				operationID,
				state.OperationID,
			)
		}
		lastPhase = state.Phase
		lastMessage = state.Message
		progress.update(state)
		switch state.Phase {
		case updater.PhaseSucceeded:
			return nil
		case updater.PhaseFailed:
			if state.Error == "" {
				state.Error = "updater operation failed"
			}
			return errors.New(state.Error)
		}
	}
}

type operationProgress struct {
	output      io.Writer
	interactive bool
	lastPhase   string
	lastMessage string
	activePull  string
	completed   int
	frame       int
	lineOpen    bool
}

func (progress *operationProgress) update(state updater.State) {
	for progress.completed < len(state.CompletedImagePulls) {
		message := state.CompletedImagePulls[progress.completed]
		if progress.activePull == message {
			progress.completePull(true)
		} else {
			fmt.Fprintf(progress.output, "  [OK] %s\n", message)
		}
		progress.completed++
	}
	if state.Phase == updater.PhasePulling {
		if progress.completed > 0 &&
			state.CompletedImagePulls[progress.completed-1] == state.Message {
			return
		}
		if progress.activePull != "" && progress.activePull != state.Message {
			progress.completePull(true)
		}
		if progress.activePull == "" {
			progress.activePull = state.Message
			if !progress.interactive {
				fmt.Fprintln(progress.output, state.Message)
			}
		}
		if progress.interactive {
			frames := []string{"|", "/", "-", "\\"}
			fmt.Fprintf(progress.output, "\r\033[2K  %s %s", frames[progress.frame%len(frames)], state.Message)
			progress.frame++
			progress.lineOpen = true
		}
		return
	}
	if progress.activePull != "" {
		progress.completePull(state.Phase != updater.PhaseFailed)
	}
	if state.Phase != progress.lastPhase || state.Message != progress.lastMessage {
		fmt.Fprintf(progress.output, "%s: %s\n", state.Phase, state.Message)
		progress.lastPhase = state.Phase
		progress.lastMessage = state.Message
	}
}

func (progress *operationProgress) completePull(succeeded bool) {
	if progress.lineOpen {
		fmt.Fprint(progress.output, "\r\033[2K")
		progress.lineOpen = false
	}
	mark := "OK"
	if !succeeded {
		mark = "FAILED"
	}
	fmt.Fprintf(progress.output, "  [%s] %s\n", mark, progress.activePull)
	progress.activePull = ""
}

func (progress *operationProgress) finish() {
	if progress.lineOpen {
		fmt.Fprint(progress.output, "\r\033[2K")
		fmt.Fprintf(progress.output, "  ... %s\n", progress.activePull)
		progress.lineOpen = false
	}
}

func unixRequest(
	socketPath string,
	method string,
	path string,
	body []byte,
) (int, []byte, error) {
	transport := &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			dialer := net.Dialer{Timeout: 5 * time.Second}
			return dialer.DialContext(ctx, "unix", socketPath)
		},
	}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 30 * time.Second}
	request, err := http.NewRequest(method, "http://unix"+path, bytes.NewReader(body))
	if err != nil {
		return 0, nil, err
	}
	if len(body) > 0 {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := client.Do(request)
	if err != nil {
		return 0, nil, fmt.Errorf("connect to updater socket: %w", err)
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, 2<<20))
	return response.StatusCode, data, err
}

func usageError() error {
	return errors.New(
		"usage: beam-updater <serve|health|status|check|apply|rollback|claim-code|uninstall|version> [--config path] [--wait] [--force] [--unclaimed-only]",
	)
}
