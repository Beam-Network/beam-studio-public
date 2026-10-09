package updater

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestServerUsesPrivateUnixSocket(t *testing.T) {
	t.Parallel()
	instanceDir := t.TempDir()
	// A directory of its own (short enough for the sun_path limit), so no
	// parallel test or earlier run can own or remove this socket.
	socketPath := filepath.Join(shortTempDir(t), "updater.sock")
	config := Config{
		InstanceDir: instanceDir,
		SocketPath:  socketPath,
	}
	supervisor := NewSupervisor(config, "1.0.0")
	server := NewServer(config, supervisor)
	serverResult := make(chan error, 1)
	go func() {
		serverResult <- server.ListenAndServe()
	}()
	serverStopped := false
	t.Cleanup(func() {
		_ = server.Close()
		if serverStopped {
			return
		}
		select {
		case err := <-serverResult:
			if err != nil {
				t.Errorf("Unix server stopped with an error: %v", err)
			}
		case <-time.After(5 * time.Second):
			t.Error("Unix server did not stop")
		}
	})

	// Ready means a connection is accepted, not merely that the socket file
	// exists: the file appears at bind time, before the server serves, and a
	// dial in between is refused under load.
	deadline := time.Now().Add(10 * time.Second)
	for {
		connection, err := net.DialTimeout("unix", config.SocketPath, time.Second)
		if err == nil {
			_ = connection.Close()
			break
		}
		select {
		case serveErr := <-serverResult:
			serverStopped = true
			t.Fatalf("Unix server stopped before it was ready: %v", serveErr)
		default:
		}
		if time.Now().After(deadline) {
			t.Fatalf("Unix socket did not accept connections: %v", err)
		}
		time.Sleep(10 * time.Millisecond)
	}

	transport := &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", config.SocketPath)
		},
	}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport}
	response, err := client.Get("http://unix/v1/status")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK {
		t.Fatalf("unexpected status %d: %s", response.StatusCode, body)
	}
	if response.Header.Get("Content-Type") != "application/json" {
		t.Fatalf("unexpected content type %q", response.Header.Get("Content-Type"))
	}
}

func TestServerReturnsOperationIDForAcceptedMutation(t *testing.T) {
	t.Parallel()
	config := Config{InstanceDir: t.TempDir()}
	supervisor := NewSupervisor(config, "1.0.0")
	server := NewServer(config, supervisor)
	request := httptest.NewRequest(http.MethodPost, "/v1/rollback", nil)
	response := httptest.NewRecorder()
	server.httpServer.Handler.ServeHTTP(response, request)
	if response.Code != http.StatusAccepted {
		t.Fatalf("expected HTTP 202, received %d: %s", response.Code, response.Body.String())
	}
	var accepted struct {
		OperationID string `json:"operationId"`
		Operation   string `json:"operation"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &accepted); err != nil {
		t.Fatal(err)
	}
	if accepted.OperationID == "" || accepted.Operation != OperationRollback {
		t.Fatalf("unexpected accepted operation response: %+v", accepted)
	}
	state := waitForTerminalState(t, supervisor, accepted.OperationID)
	if state.Phase != PhaseFailed {
		t.Fatalf("accepted mutation did not reach a terminal state: %+v", state)
	}
}

func TestPrepareSocketPathReplacesDockerEmptyDirectory(t *testing.T) {
	t.Parallel()
	socketPath := filepath.Join(shortTempDir(t), "run", "updater.sock")
	// What dockerd creates when it starts a container bind-mounting a socket
	// path that does not exist yet.
	if err := os.MkdirAll(socketPath, 0755); err != nil {
		t.Fatal(err)
	}
	if err := prepareSocketPath(socketPath); err != nil {
		t.Fatalf("an empty directory at the socket path was refused: %v", err)
	}
	if _, err := os.Lstat(socketPath); !os.IsNotExist(err) {
		t.Fatalf("the empty directory was not removed: %v", err)
	}
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		t.Fatalf("socket could not be created after the repair: %v", err)
	}
	_ = listener.Close()
}

func TestPrepareSocketPathRefusesAnythingElse(t *testing.T) {
	t.Parallel()
	for name, create := range map[string]func(path string) error{
		"regular file": func(path string) error {
			return os.WriteFile(path, []byte("keep"), 0600)
		},
		"non-empty directory": func(path string) error {
			if err := os.Mkdir(path, 0755); err != nil {
				return err
			}
			return os.WriteFile(filepath.Join(path, "keep"), []byte("keep"), 0600)
		},
		"symlink to a directory": func(path string) error {
			target := path + ".target"
			if err := os.Mkdir(target, 0755); err != nil {
				return err
			}
			return os.Symlink(target, path)
		},
	} {
		name, create := name, create
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			socketPath := filepath.Join(t.TempDir(), "updater.sock")
			if err := create(socketPath); err != nil {
				t.Fatal(err)
			}
			if err := prepareSocketPath(socketPath); err == nil {
				t.Fatalf("%s at the socket path was replaced", name)
			}
			if _, err := os.Lstat(socketPath); err != nil {
				t.Fatalf("%s at the socket path was touched: %v", name, err)
			}
		})
	}
}

func TestPrepareSocketPathReplacesStaleSocket(t *testing.T) {
	t.Parallel()
	socketPath := filepath.Join(shortTempDir(t), "updater.sock")
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		t.Fatal(err)
	}
	// Leave the file behind, as a crashed updater does.
	listener.(*net.UnixListener).SetUnlinkOnClose(false)
	_ = listener.Close()
	if err := prepareSocketPath(socketPath); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(socketPath); !os.IsNotExist(err) {
		t.Fatalf("stale socket was not removed: %v", err)
	}
}

// shortTempDir keeps Unix socket paths under the 104-byte limit of macOS,
// which t.TempDir() (it embeds the test name) can exceed.
func shortTempDir(t *testing.T) string {
	t.Helper()
	directory, err := os.MkdirTemp("", "bu")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(directory) })
	return directory
}
