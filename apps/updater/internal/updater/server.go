package updater

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/user"
	"path/filepath"
	"strconv"
	"time"
)

type Server struct {
	config     Config
	supervisor *Supervisor
	httpServer *http.Server
}

func NewServer(config Config, supervisor *Supervisor) *Server {
	server := &Server{config: config, supervisor: supervisor}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/health", server.health)
	mux.HandleFunc("GET /v1/status", server.status)
	mux.HandleFunc("GET /v1/check", server.check)
	mux.HandleFunc("POST /v1/apply", server.apply)
	mux.HandleFunc("POST /v1/rollback", server.rollback)
	server.httpServer = &http.Server{
		Handler:           limitRequestBody(mux),
		ReadHeaderTimeout: 5 * time.Second,
	}
	return server
}

func (server *Server) ListenAndServe() error {
	if err := prepareSocketPath(server.config.SocketPath); err != nil {
		return err
	}

	listener, err := net.Listen("unix", server.config.SocketPath)
	if err != nil {
		return err
	}
	defer listener.Close()
	if err := os.Chmod(server.config.SocketPath, 0660); err != nil {
		return err
	}
	if server.config.SocketGroup != "" {
		group, err := user.LookupGroup(server.config.SocketGroup)
		if err != nil {
			return fmt.Errorf("look up socket group: %w", err)
		}
		groupID, err := strconv.Atoi(group.Gid)
		if err != nil {
			return fmt.Errorf("parse socket group id: %w", err)
		}
		if err := os.Chown(server.config.SocketPath, -1, groupID); err != nil {
			return fmt.Errorf("set socket group: %w", err)
		}
	}
	fmt.Printf("Beam Studio updater listening on %s\n", server.config.SocketPath)
	err = server.httpServer.Serve(listener)
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

// prepareSocketPath clears the way for the control socket.
//
// A stale socket from a previous run is replaced. So is an EMPTY directory:
// that is what Docker leaves behind when it starts a container that
// bind-mounts the socket path (as releases before the directory mount did)
// before this service has created it, which is the normal order after a host
// reboot. Refusing it kept both the updater and the Studio down until someone
// removed it by hand. Anything else at the path (a regular file, a symlink, a
// directory with content) is not ours to delete and is still refused.
func prepareSocketPath(socketPath string) error {
	if err := os.MkdirAll(filepath.Dir(socketPath), 0770); err != nil {
		return err
	}
	info, err := os.Lstat(socketPath)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	switch {
	case info.Mode()&os.ModeSocket != 0:
		return os.Remove(socketPath)
	case info.IsDir():
		entries, err := os.ReadDir(socketPath)
		if err != nil {
			return err
		}
		if len(entries) != 0 {
			return fmt.Errorf("refusing to replace non-empty directory %s", socketPath)
		}
		// os.Remove is rmdir here, which cannot delete content that appeared
		// since the check above.
		if err := os.Remove(socketPath); err != nil {
			return fmt.Errorf("remove empty directory at socket path %s: %w", socketPath, err)
		}
		fmt.Fprintf(
			os.Stderr,
			"Beam Studio updater removed an empty directory at %s (left by Docker when a container started before the updater)\n",
			socketPath,
		)
		return nil
	default:
		return fmt.Errorf("refusing to replace non-socket path %s", socketPath)
	}
}

func (server *Server) Close() error {
	return server.httpServer.Close()
}

func (server *Server) health(response http.ResponseWriter, _ *http.Request) {
	writeJSON(response, http.StatusOK, map[string]any{"ok": true})
}

func (server *Server) status(response http.ResponseWriter, _ *http.Request) {
	state, err := server.supervisor.State()
	if err != nil {
		writeError(response, http.StatusInternalServerError, err)
		return
	}
	writeJSON(response, http.StatusOK, state)
}

func (server *Server) check(response http.ResponseWriter, request *http.Request) {
	result, err := server.supervisor.Check(request.Context())
	if err != nil {
		writeError(response, http.StatusBadGateway, err)
		return
	}
	writeJSON(response, http.StatusOK, result)
}

func (server *Server) apply(response http.ResponseWriter, request *http.Request) {
	var body struct {
		Force bool `json:"force"`
	}
	if request.ContentLength > 0 {
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			writeError(response, http.StatusBadRequest, errors.New("invalid apply request"))
			return
		}
	}
	operationID, err := server.supervisor.StartApply(body.Force)
	if err != nil {
		writeError(response, http.StatusConflict, err)
		return
	}
	writeJSON(response, http.StatusAccepted, map[string]any{
		"accepted":    true,
		"operation":   "apply",
		"operationId": operationID,
	})
}

func (server *Server) rollback(response http.ResponseWriter, _ *http.Request) {
	operationID, err := server.supervisor.StartRollback()
	if err != nil {
		writeError(response, http.StatusConflict, err)
		return
	}
	writeJSON(response, http.StatusAccepted, map[string]any{
		"accepted":    true,
		"operation":   "rollback",
		"operationId": operationID,
	})
}

func limitRequestBody(next http.Handler) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		request.Body = http.MaxBytesReader(response, request.Body, 4096)
		next.ServeHTTP(response, request)
	})
}

func writeJSON(response http.ResponseWriter, status int, value any) {
	response.Header().Set("Content-Type", "application/json")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(value)
}

func writeError(response http.ResponseWriter, status int, err error) {
	writeJSON(response, status, map[string]any{"error": err.Error()})
}
