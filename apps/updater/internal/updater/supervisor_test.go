package updater

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type recordingRunner struct {
	mu           sync.Mutex
	commands     [][]string
	err          error
	errorsByCall map[int]error
	// template is what `docker cp` extracts from the release updater image.
	template []byte
	// composeConfig answers `docker compose config --format json`; empty is {}.
	composeConfig string
}

func (runner *recordingRunner) Run(
	_ context.Context,
	stdout io.Writer,
	name string,
	args ...string,
) error {
	runner.mu.Lock()
	defer runner.mu.Unlock()
	callIndex := len(runner.commands)
	command := append([]string{name}, args...)
	runner.commands = append(runner.commands, command)
	if err := runner.errorsByCall[callIndex]; err != nil {
		return err
	}
	if runner.err != nil {
		return runner.err
	}
	switch {
	case len(args) >= 3 && strings.Join(args[len(args)-3:], " ") == "config --format json":
		config := runner.composeConfig
		if config == "" {
			config = "{}"
		}
		_, _ = io.WriteString(stdout, config)
	case len(args) == 2 && args[0] == "create":
		_, _ = io.WriteString(stdout, "updater-container\n")
	case len(args) == 3 && args[0] == "cp":
		return os.WriteFile(args[2], runner.template, 0600)
	}
	return nil
}

func TestSupervisorAppliesVerifiedRelease(t *testing.T) {
	t.Parallel()
	instanceDir := t.TempDir()
	envPath := filepath.Join(instanceDir, ".env")
	if err := os.WriteFile(envPath, []byte("BEAM_STUDIO_SECRET_KEY=test\n"), 0600); err != nil {
		t.Fatal(err)
	}
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	publicKeyPath := writeTestPublicKey(t, publicKey)
	templatePath := filepath.Join(instanceDir, "compose.template.yml")
	template := []byte(`services:
  api:
    image: "@IMAGE_API@"
    labels: ["studio.version=@BEAM_STUDIO_VERSION@"]
  studio:
    image: "@IMAGE_STUDIO@"
  mcp:
    image: "@IMAGE_MCP@"
  orchestrator:
    image: "@IMAGE_ORCHESTRATOR@"
  worker-1:
    image: "@IMAGE_WORKER@"
  worker-2:
    image: "@IMAGE_WORKER@"
  postgres:
    image: "@IMAGE_POSTGRES@"
  nats:
    image: "@IMAGE_NATS@"
`)
	if err := os.WriteFile(templatePath, template, 0600); err != nil {
		t.Fatal(err)
	}

	healthServer := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.WriteHeader(http.StatusOK)
	}))
	defer healthServer.Close()

	document := testControlPlane()
	manifestData := signTestControlPlane(t, document, privateKey)
	releaseServer := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		_, _ = response.Write(manifestData)
	}))
	defer releaseServer.Close()

	config := Config{
		InstanceDir:          instanceDir,
		ComposeProject:       "beam-studio-test",
		ControlPlaneURL:      releaseServer.URL + "/latest.json",
		PublicKeyPath:        publicKeyPath,
		ComposeTemplatePath:  templatePath,
		Channel:              "stable",
		SocketPath:           filepath.Join(instanceDir, "updater.sock"),
		EnvFile:              envPath,
		HealthURL:            healthServer.URL,
		StudioHealthURL:      healthServer.URL,
		DockerBinary:         "docker",
		BackupEnabled:        false,
		BackupRetention:      2,
		UpdateTimeoutSeconds: 60,
		HealthTimeoutSeconds: 10,
		AllowInsecureHTTP:    true,
	}
	// The release ships its own template; the installed one must not be rendered.
	runner := &recordingRunner{template: append(append([]byte{}, template...), "x-shipped-with-release: true\n"...)}
	supervisor := NewSupervisor(config, "1.0.0")
	supervisor.manifests = &ManifestClient{HTTPClient: releaseServer.Client()}
	supervisor.runner = runner

	operationID, err := supervisor.StartApply(false)
	if err != nil {
		t.Fatal(err)
	}
	state := waitForTerminalState(t, supervisor, operationID)
	if state.Phase != PhaseSucceeded || state.CurrentVersion != "v1.2.3" ||
		state.CurrentSequence != 7 || state.OperationID != operationID ||
		state.Operation != OperationApply {
		t.Fatalf("unexpected final state: %+v", state)
	}
	rendered, err := os.ReadFile(state.CurrentComposePath)
	if err != nil {
		t.Fatalf("expected verified compose file: %v", err)
	}
	if !strings.Contains(string(rendered), "x-shipped-with-release: true") {
		t.Fatalf("expected the release's own Compose template to be rendered:\n%s", rendered)
	}
	target, err := os.Readlink(filepath.Join(instanceDir, "current"))
	if err != nil {
		t.Fatal(err)
	}
	if target != filepath.Join("releases", "00000000000000000007-1.2.3") {
		t.Fatalf("unexpected current symlink target %q", target)
	}
	if state.CurrentImages["worker"] != document.Channels["stable"].Images["worker"] {
		t.Fatalf("expected complete image map to be persisted: %+v", state)
	}
	if len(state.CompletedImagePulls) != 7 ||
		state.CompletedImagePulls[0] != "Pulling image 1/7: api" ||
		state.CompletedImagePulls[6] != "Pulling image 7/7: worker" {
		t.Fatalf("expected per-image pull progress: %+v", state.CompletedImagePulls)
	}
	republished := document.Channels["stable"]
	republished.Images = cloneImages(republished.Images)
	republished.Images["worker"] = testImage(
		"ghcr.io/beam-network/beam-studio-runtime-action-runner",
		"c",
	)
	document.Channels["stable"] = republished
	manifestData = signTestControlPlane(t, document, privateKey)
	republishOperationID, err := supervisor.StartApply(true)
	if err != nil {
		t.Fatal(err)
	}
	republishedState := waitForTerminalState(t, supervisor, republishOperationID)
	if republishedState.Phase != PhaseFailed ||
		!strings.Contains(republishedState.Error, "republished") {
		t.Fatalf("expected equal-sequence republish rejection: %+v", republishedState)
	}

	runner.mu.Lock()
	defer runner.mu.Unlock()
	joined := make([]string, len(runner.commands))
	for index, command := range runner.commands {
		joined[index] = strings.Join(command, " ")
	}
	if len(joined) != 14 {
		t.Fatalf("expected template extraction, config, seven pulls, inspection and up commands, received %v", joined)
	}
	updater := document.Channels["stable"].Updater
	if joined[0] != "docker pull --quiet "+updater ||
		joined[1] != "docker create "+updater ||
		!strings.HasPrefix(joined[2], "docker cp updater-container:/compose.release.template.yml ") ||
		joined[3] != "docker rm --force updater-container" ||
		!strings.Contains(joined[4], "config --quiet") ||
		joined[5] != "docker pull --quiet "+state.CurrentImages["api"] ||
		joined[10] != "docker pull --quiet "+state.CurrentImages["studio"] ||
		joined[11] != "docker pull --quiet "+state.CurrentImages["worker"] ||
		!strings.Contains(joined[12], "config --format json") ||
		!strings.Contains(joined[13], "up -d --remove-orphans --wait") {
		t.Fatalf("unexpected Docker Compose commands: %v", joined)
	}
}

func TestSupervisorUpdatesRenamedRepositoriesAndRollsBackExactImageMap(t *testing.T) {
	t.Parallel()
	instanceDir := t.TempDir()
	envPath := filepath.Join(instanceDir, ".env")
	if err := os.WriteFile(envPath, []byte("BEAM_STUDIO_SECRET_KEY=test\n"), 0600); err != nil {
		t.Fatal(err)
	}
	templatePath := filepath.Join(instanceDir, "compose.template.yml")
	template := []byte(`services:
  api: { image: "@IMAGE_API@" }
  studio: { image: "@IMAGE_STUDIO@" }
  mcp: { image: "@IMAGE_MCP@" }
  orchestrator: { image: "@IMAGE_ORCHESTRATOR@" }
  worker: { image: "@IMAGE_WORKER@" }
  postgres: { image: "@IMAGE_POSTGRES@" }
  nats: { image: "@IMAGE_NATS@" }
x-version: "@BEAM_STUDIO_VERSION@"
`)
	if err := os.WriteFile(templatePath, template, 0600); err != nil {
		t.Fatal(err)
	}
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	publicKeyPath := writeTestPublicKey(t, publicKey)
	healthServer := healthyTestServer(t)

	document := testControlPlane()
	document.Channels["stable"] = testRelease("v1.0.0", 1)
	manifestData := signTestControlPlane(t, document, privateKey)
	releaseServer := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		_, _ = response.Write(manifestData)
	}))
	defer releaseServer.Close()

	config := Config{
		InstanceDir:          instanceDir,
		ComposeProject:       "beam-studio-test",
		ControlPlaneURL:      releaseServer.URL + "/latest.json",
		PublicKeyPath:        publicKeyPath,
		ComposeTemplatePath:  templatePath,
		Channel:              "stable",
		SocketPath:           filepath.Join(instanceDir, "updater.sock"),
		EnvFile:              envPath,
		HealthURL:            healthServer.URL,
		StudioHealthURL:      healthServer.URL,
		DockerBinary:         "docker",
		BackupEnabled:        false,
		UpdateTimeoutSeconds: 60,
		HealthTimeoutSeconds: 10,
		AllowInsecureHTTP:    true,
	}
	supervisor := NewSupervisor(config, "v1.0.0")
	supervisor.manifests = &ManifestClient{HTTPClient: releaseServer.Client()}
	supervisor.runner = &recordingRunner{template: template}
	if err := supervisor.Apply(context.Background(), false); err != nil {
		t.Fatal(err)
	}
	oldImages := cloneImages(document.Channels["stable"].Images)

	renamed := testRelease("v1.1.0", 2)
	renamed.Images["worker"] = testImage(
		"ghcr.io/beam-network/beam-studio-runtime-action-runner",
		"c",
	)
	renamed.Images["orchestrator"] = testImage(
		"ghcr.io/beam-network/beam-studio-runtime-action-dispatcher",
		"d",
	)
	document.Channels["stable"] = renamed
	manifestData = signTestControlPlane(t, document, privateKey)
	if err := supervisor.Apply(context.Background(), false); err != nil {
		t.Fatal(err)
	}
	updated, err := supervisor.State()
	if err != nil {
		t.Fatal(err)
	}
	if updated.CurrentImages["worker"] != renamed.Images["worker"] ||
		updated.PreviousImages["worker"] != oldImages["worker"] {
		t.Fatalf("expected old and renamed image maps to be persisted: %+v", updated)
	}

	rollbackOperationID, err := supervisor.StartRollback()
	if err != nil {
		t.Fatal(err)
	}
	rolledBack := waitForTerminalState(t, supervisor, rollbackOperationID)
	if rolledBack.CurrentVersion != "v1.0.0" ||
		rolledBack.CurrentImages["worker"] != oldImages["worker"] ||
		rolledBack.PreviousImages["worker"] != renamed.Images["worker"] ||
		rolledBack.OperationID != rollbackOperationID ||
		rolledBack.Operation != OperationRollback {
		t.Fatalf("expected exact old image map after rollback: %+v", rolledBack)
	}
	compose, err := os.ReadFile(rolledBack.CurrentComposePath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(compose), oldImages["worker"]) ||
		strings.Contains(string(compose), "beam-studio-runtime-action-runner") {
		t.Fatalf("rollback Compose does not contain exact old images:\n%s", compose)
	}
}

func TestStudioReadinessFailureTriggersAutomaticRollback(t *testing.T) {
	instanceDir := t.TempDir()
	envPath := filepath.Join(instanceDir, ".env")
	if err := os.WriteFile(envPath, []byte("BEAM_STUDIO_SECRET_KEY=test\n"), 0600); err != nil {
		t.Fatal(err)
	}
	templatePath := filepath.Join(instanceDir, "compose.template.yml")
	template := []byte(`services:
  api: { image: "@IMAGE_API@" }
  studio: { image: "@IMAGE_STUDIO@" }
  mcp: { image: "@IMAGE_MCP@" }
  orchestrator: { image: "@IMAGE_ORCHESTRATOR@" }
  worker: { image: "@IMAGE_WORKER@" }
  postgres: { image: "@IMAGE_POSTGRES@" }
  nats: { image: "@IMAGE_NATS@" }
x-version: "@BEAM_STUDIO_VERSION@"
`)
	if err := os.WriteFile(templatePath, template, 0600); err != nil {
		t.Fatal(err)
	}
	previousCompose := writeTestCompose(t, instanceDir, "1.0.0")
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	publicKeyPath := writeTestPublicKey(t, publicKey)
	apiHealth := healthyTestServer(t)
	var studioChecks atomic.Int32
	studioHealth := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		if studioChecks.Add(1) == 1 {
			response.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		response.WriteHeader(http.StatusOK)
	}))
	defer studioHealth.Close()
	document := testControlPlane()
	document.Channels["stable"] = testRelease("v1.1.0", 2)
	manifestData := signTestControlPlane(t, document, privateKey)
	releaseServer := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		_, _ = response.Write(manifestData)
	}))
	defer releaseServer.Close()

	config := Config{
		InstanceDir:          instanceDir,
		ComposeProject:       "beam-studio-test",
		ControlPlaneURL:      releaseServer.URL + "/latest.json",
		PublicKeyPath:        publicKeyPath,
		ComposeTemplatePath:  templatePath,
		Channel:              "stable",
		EnvFile:              envPath,
		HealthURL:            apiHealth.URL,
		StudioHealthURL:      studioHealth.URL,
		DockerBinary:         "docker",
		BackupEnabled:        false,
		UpdateTimeoutSeconds: 30,
		HealthTimeoutSeconds: 1,
		AllowInsecureHTTP:    true,
	}
	runner := &recordingRunner{template: template}
	supervisor := NewSupervisor(config, "v1.0.0")
	supervisor.manifests = &ManifestClient{HTTPClient: releaseServer.Client()}
	supervisor.runner = runner
	if err := supervisor.state.Write(State{
		Phase:              PhaseSucceeded,
		CurrentVersion:     "v1.0.0",
		CurrentSequence:    1,
		CurrentComposePath: previousCompose,
		CurrentImages:      testImages(),
		AcceptedSequences:  map[string]uint64{"stable": 1},
	}); err != nil {
		t.Fatal(err)
	}
	if err := supervisor.Apply(context.Background(), false); err == nil {
		t.Fatal("expected Studio readiness failure")
	}
	state, err := supervisor.State()
	if err != nil {
		t.Fatal(err)
	}
	if state.Phase != PhaseFailed || !state.PreviousRestored ||
		state.CurrentVersion != "v1.0.0" || studioChecks.Load() < 2 {
		t.Fatalf("expected readiness failure to restore previous release: %+v", state)
	}
}

func TestFailedDeploymentAndFailedAutomaticRollbackReachTerminalState(t *testing.T) {
	t.Parallel()
	instanceDir := t.TempDir()
	envPath := filepath.Join(instanceDir, ".env")
	if err := os.WriteFile(envPath, []byte("BEAM_STUDIO_SECRET_KEY=test\n"), 0600); err != nil {
		t.Fatal(err)
	}
	templatePath := filepath.Join(instanceDir, "compose.template.yml")
	template := []byte(`services:
  api: { image: "@IMAGE_API@" }
  studio: { image: "@IMAGE_STUDIO@" }
  mcp: { image: "@IMAGE_MCP@" }
  orchestrator: { image: "@IMAGE_ORCHESTRATOR@" }
  worker: { image: "@IMAGE_WORKER@" }
  postgres: { image: "@IMAGE_POSTGRES@" }
  nats: { image: "@IMAGE_NATS@" }
x-version: "@BEAM_STUDIO_VERSION@"
`)
	if err := os.WriteFile(templatePath, template, 0600); err != nil {
		t.Fatal(err)
	}
	previousCompose := writeTestCompose(t, instanceDir, "1.0.0")
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	publicKeyPath := writeTestPublicKey(t, publicKey)
	document := testControlPlane()
	document.Channels["stable"] = testRelease("v1.1.0", 2)
	manifestData := signTestControlPlane(t, document, privateKey)
	releaseServer := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		_, _ = response.Write(manifestData)
	}))
	defer releaseServer.Close()
	supervisor := NewSupervisor(Config{
		InstanceDir:          instanceDir,
		ComposeProject:       "beam-studio-test",
		ControlPlaneURL:      releaseServer.URL,
		PublicKeyPath:        publicKeyPath,
		ComposeTemplatePath:  templatePath,
		Channel:              "stable",
		EnvFile:              envPath,
		HealthURL:            "http://127.0.0.1:1/health",
		StudioHealthURL:      "http://127.0.0.1:1/health",
		DockerBinary:         "docker",
		BackupEnabled:        false,
		UpdateTimeoutSeconds: 30,
		HealthTimeoutSeconds: 1,
		AllowInsecureHTTP:    true,
	}, "v1.0.0")
	supervisor.manifests = &ManifestClient{HTTPClient: releaseServer.Client()}
	supervisor.runner = &recordingRunner{template: template, errorsByCall: map[int]error{
		// 12 and 14 read each release's Compose configuration; 13 and 15 deploy.
		13: errors.New("new deployment failed"),
		15: errors.New("automatic rollback failed"),
	}}
	if err := supervisor.state.Write(State{
		Phase:              PhaseSucceeded,
		CurrentVersion:     "v1.0.0",
		CurrentSequence:    1,
		CurrentComposePath: previousCompose,
		CurrentImages:      testImages(),
		AcceptedSequences:  map[string]uint64{"stable": 1},
	}); err != nil {
		t.Fatal(err)
	}
	applyErr := supervisor.Apply(context.Background(), false)
	if applyErr == nil || !strings.Contains(applyErr.Error(), "automatic rollback also failed") {
		t.Fatalf("expected combined deployment and rollback error, received %v", applyErr)
	}
	state, err := supervisor.State()
	if err != nil {
		t.Fatal(err)
	}
	if state.Phase != PhaseFailed || state.PreviousRestored ||
		!strings.Contains(state.Error, "new deployment failed") ||
		!strings.Contains(state.Error, "automatic rollback failed") {
		t.Fatalf("unexpected terminal state after failed rollback: %+v", state)
	}
}

func TestAcceptedApplyReachesFailedStateWhenInstallationLockIsHeld(t *testing.T) {
	t.Parallel()
	instanceDir := t.TempDir()
	config := Config{InstanceDir: instanceDir}
	lock, err := acquireFileLock(config.LockPath())
	if err != nil {
		t.Fatal(err)
	}
	defer releaseFileLock(lock)

	supervisor := NewSupervisor(config, "1.0.0")
	operationID, err := supervisor.StartApply(false)
	if err != nil {
		t.Fatal(err)
	}
	state := waitForTerminalState(t, supervisor, operationID)
	if state.Phase != PhaseFailed {
		t.Fatalf("expected failed state, received %+v", state)
	}
	if !strings.Contains(state.Error, "installation lock") {
		t.Fatalf("expected lock error, received %+v", state)
	}
	if state.CompletedAt == "" || state.Operation != OperationApply {
		t.Fatalf("expected completed apply operation, received %+v", state)
	}
}

func TestAcceptedRollbackWithoutPreviousReleaseReachesFailedState(t *testing.T) {
	t.Parallel()
	supervisor := NewSupervisor(Config{InstanceDir: t.TempDir()}, "1.0.0")
	operationID, err := supervisor.StartRollback()
	if err != nil {
		t.Fatal(err)
	}
	state := waitForTerminalState(t, supervisor, operationID)
	if state.Phase != PhaseFailed {
		t.Fatalf("expected failed state, received %+v", state)
	}
	if !strings.Contains(state.Error, "no previous Beam Studio release") {
		t.Fatalf("expected missing release error, received %+v", state)
	}
	if state.CompletedAt == "" || state.Operation != OperationRollback {
		t.Fatalf("expected completed rollback operation, received %+v", state)
	}
}

func TestShutdownCancelsAndFinalizesActiveOperation(t *testing.T) {
	t.Parallel()
	supervisor := NewSupervisor(Config{InstanceDir: t.TempDir()}, "1.0.0")
	operationID, err := supervisor.startOperation(
		OperationApply,
		"test operation queued",
		func(ctx context.Context) error {
			<-ctx.Done()
			return ctx.Err()
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	shutdownContext, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := supervisor.Shutdown(shutdownContext); err != nil {
		t.Fatal(err)
	}
	state, err := supervisor.State()
	if err != nil {
		t.Fatal(err)
	}
	if state.OperationID != operationID || state.Phase != PhaseFailed ||
		!strings.Contains(state.Error, "canceled") {
		t.Fatalf("active operation was not finalized after shutdown: %+v", state)
	}
	if _, err := supervisor.StartApply(false); err == nil ||
		!strings.Contains(err.Error(), "shutting down") {
		t.Fatalf("expected new work to be rejected after shutdown, received %v", err)
	}
}

func TestPrepareReleaseSeparatesEqualVersionsBySequence(t *testing.T) {
	t.Parallel()
	instanceDir := t.TempDir()
	templatePath := filepath.Join(instanceDir, "compose.template.yml")
	template := []byte(`services:
  api: { image: "@IMAGE_API@" }
  studio: { image: "@IMAGE_STUDIO@" }
  mcp: { image: "@IMAGE_MCP@" }
  orchestrator: { image: "@IMAGE_ORCHESTRATOR@" }
  worker: { image: "@IMAGE_WORKER@" }
  postgres: { image: "@IMAGE_POSTGRES@" }
  nats: { image: "@IMAGE_NATS@" }
x-version: "@BEAM_STUDIO_VERSION@"
`)
	if err := os.WriteFile(templatePath, template, 0600); err != nil {
		t.Fatal(err)
	}
	supervisor := NewSupervisor(Config{
		InstanceDir:         instanceDir,
		ComposeTemplatePath: templatePath,
	}, "1.0.0")
	supervisor.runner = &recordingRunner{template: template}
	first := testRelease("v1.2.3", 7)
	second := testRelease("v1.2.3", 8)
	second.Images["worker"] = testImage(
		"ghcr.io/beam-network/beam-studio-runtime-action-runner",
		"e",
	)
	firstPath, err := supervisor.prepareRelease(context.Background(), first)
	if err != nil {
		t.Fatal(err)
	}
	secondPath, err := supervisor.prepareRelease(context.Background(), second)
	if err != nil {
		t.Fatal(err)
	}
	if firstPath == secondPath {
		t.Fatalf("equal versions with distinct sequences shared %q", firstPath)
	}
	if !strings.Contains(firstPath, "00000000000000000007-1.2.3") ||
		!strings.Contains(secondPath, "00000000000000000008-1.2.3") {
		t.Fatalf("unexpected sequence-scoped paths %q and %q", firstPath, secondPath)
	}
	firstCompose, err := os.ReadFile(firstPath)
	if err != nil {
		t.Fatal(err)
	}
	secondCompose, err := os.ReadFile(secondPath)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(firstCompose), "action-runner") ||
		!strings.Contains(string(secondCompose), "action-runner") {
		t.Fatal("sequence-scoped releases did not preserve their exact image maps")
	}
}

func TestRepositoryComposeTemplateRendersAllImmutableImages(t *testing.T) {
	t.Parallel()
	templatePath := filepath.Join("..", "..", "..", "..", "deploy", "compose.release.template.yml")
	template, err := os.ReadFile(templatePath)
	if err != nil {
		t.Fatal(err)
	}
	manifest := testRelease("v1.2.3", 7)
	// Every image the release pipeline signs (scripts/create-studio-release.mjs).
	manifest.Images["room-consumer"] = testImage(
		"ghcr.io/beam-network/beam-studio-runtime-room-consumer",
		"8",
	)
	rendered, err := renderComposeTemplate(template, manifest)
	if err != nil {
		t.Fatal(err)
	}
	content := string(rendered)
	if strings.Contains(content, "@IMAGE_") || strings.Contains(content, "@BEAM_STUDIO_VERSION@") {
		t.Fatal("repository Compose template retained an unresolved placeholder")
	}
	for role, image := range manifest.Images {
		if !strings.Contains(content, image) {
			t.Fatalf("repository Compose template omitted %s image %q", role, image)
		}
	}
	imageLines := 0
	for _, line := range strings.Split(content, "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "image:") {
			continue
		}
		imageLines++
		if !strings.Contains(line, "@sha256:") {
			t.Fatalf("repository Compose template contains mutable image line %q", line)
		}
	}
	if imageLines != len(manifest.Images) {
		t.Fatalf("expected %d rendered image lines, received %d", len(manifest.Images), imageLines)
	}
}

func TestReconcileFailsInterruptedPreDeploymentOperation(t *testing.T) {
	t.Parallel()
	for _, phase := range []string{
		PhaseQueued,
		PhaseChecking,
		PhaseDownloading,
		PhaseValidating,
		PhasePulling,
		PhaseBackingUp,
	} {
		phase := phase
		t.Run(phase, func(t *testing.T) {
			instanceDir := t.TempDir()
			supervisor := NewSupervisor(Config{InstanceDir: instanceDir}, "1.0.0")
			runner := &recordingRunner{}
			supervisor.runner = runner
			if err := supervisor.state.Write(State{
				OperationID:    "op-before-deploy",
				Operation:      OperationApply,
				Phase:          phase,
				CurrentVersion: "v1.0.0",
			}); err != nil {
				t.Fatal(err)
			}
			if err := supervisor.Reconcile(context.Background()); err != nil {
				t.Fatal(err)
			}
			state, err := supervisor.State()
			if err != nil {
				t.Fatal(err)
			}
			if state.Phase != PhaseFailed || state.CompletedAt == "" ||
				!strings.Contains(state.Message, "current release unchanged") {
				t.Fatalf("unexpected reconciled state: %+v", state)
			}
			runner.mu.Lock()
			defer runner.mu.Unlock()
			if len(runner.commands) != 0 {
				t.Fatalf("pre-deployment recovery must not run Compose: %v", runner.commands)
			}
		})
	}
}

func TestReconcileRestoresLastKnownGoodRelease(t *testing.T) {
	t.Parallel()
	healthServer := healthyTestServer(t)
	for _, phase := range []string{
		PhaseDeploying,
		PhaseVerifying,
		PhaseRollingBack,
		PhaseRecovering,
	} {
		phase := phase
		t.Run(phase, func(t *testing.T) {
			instanceDir := t.TempDir()
			composePath := writeTestCompose(t, instanceDir, "1.0.0")
			_ = writeTestCompose(t, instanceDir, "1.1.0")
			if err := os.Symlink(filepath.Join("releases", "1.1.0"), filepath.Join(instanceDir, "current")); err != nil {
				t.Fatal(err)
			}
			supervisor := NewSupervisor(Config{
				InstanceDir:          instanceDir,
				ComposeProject:       "beam-studio-test",
				EnvFile:              filepath.Join(instanceDir, ".env"),
				HealthURL:            healthServer.URL,
				StudioHealthURL:      healthServer.URL,
				DockerBinary:         "docker",
				HealthTimeoutSeconds: 1,
			}, "1.0.0")
			supervisor.runner = &recordingRunner{}
			if err := supervisor.state.Write(State{
				OperationID:        "op-interrupted",
				Operation:          OperationApply,
				Phase:              phase,
				CurrentVersion:     "v1.0.0",
				CurrentSequence:    4,
				CurrentComposePath: composePath,
				CurrentImages:      testImages(),
				TargetVersion:      "v1.1.0",
				TargetSequence:     5,
				TargetComposePath:  filepath.Join(instanceDir, "releases", "1.1.0", "compose.yml"),
			}); err != nil {
				t.Fatal(err)
			}
			if err := supervisor.Reconcile(context.Background()); err != nil {
				t.Fatal(err)
			}
			state, err := supervisor.State()
			if err != nil {
				t.Fatal(err)
			}
			if state.Phase != PhaseFailed || !state.PreviousRestored ||
				state.CurrentVersion != "v1.0.0" {
				t.Fatalf("expected last-known-good release restoration: %+v", state)
			}
			target, err := os.Readlink(filepath.Join(instanceDir, "current"))
			if err != nil {
				t.Fatal(err)
			}
			if target != filepath.Join("releases", "1.0.0") {
				t.Fatalf("unexpected recovered symlink target %q", target)
			}
		})
	}
}

func TestReconcileCompletesInterruptedFirstInstallation(t *testing.T) {
	t.Parallel()
	instanceDir := t.TempDir()
	composePath := writeTestCompose(t, instanceDir, "1.0.0")
	healthServer := healthyTestServer(t)
	supervisor := NewSupervisor(Config{
		InstanceDir:          instanceDir,
		ComposeProject:       "beam-studio-test",
		EnvFile:              filepath.Join(instanceDir, ".env"),
		HealthURL:            healthServer.URL,
		StudioHealthURL:      healthServer.URL,
		DockerBinary:         "docker",
		Channel:              "stable",
		HealthTimeoutSeconds: 1,
	}, "1.0.0")
	supervisor.runner = &recordingRunner{}
	images := testImages()
	if err := supervisor.state.Write(State{
		OperationID:       "op-first-install",
		Operation:         OperationApply,
		Phase:             PhaseVerifying,
		TargetVersion:     "v1.0.0",
		TargetSequence:    3,
		TargetComposePath: composePath,
		TargetImages:      images,
	}); err != nil {
		t.Fatal(err)
	}
	if err := supervisor.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	state, err := supervisor.State()
	if err != nil {
		t.Fatal(err)
	}
	if state.Phase != PhaseSucceeded || state.CurrentVersion != "v1.0.0" ||
		state.CurrentSequence != 3 || state.AcceptedSequences["stable"] != 3 ||
		state.CurrentImages["worker"] != images["worker"] {
		t.Fatalf("expected interrupted first install to complete: %+v", state)
	}
}

func TestReconcileRecordsManualInterventionWhenRecoveryFails(t *testing.T) {
	t.Parallel()
	instanceDir := t.TempDir()
	composePath := writeTestCompose(t, instanceDir, "1.0.0")
	supervisor := NewSupervisor(Config{
		InstanceDir:          instanceDir,
		ComposeProject:       "beam-studio-test",
		EnvFile:              filepath.Join(instanceDir, ".env"),
		DockerBinary:         "docker",
		HealthTimeoutSeconds: 1,
	}, "1.0.0")
	supervisor.runner = &recordingRunner{err: errors.New("compose failed")}
	if err := supervisor.state.Write(State{
		OperationID:        "op-recovery-failure",
		Operation:          OperationApply,
		Phase:              PhaseDeploying,
		CurrentVersion:     "v1.0.0",
		CurrentComposePath: composePath,
	}); err != nil {
		t.Fatal(err)
	}
	if err := supervisor.Reconcile(context.Background()); err == nil {
		t.Fatal("expected recovery failure")
	}
	state, err := supervisor.State()
	if err != nil {
		t.Fatal(err)
	}
	if state.Phase != PhaseFailed ||
		!strings.Contains(state.Message, "manual intervention required") ||
		!strings.Contains(state.Error, "compose failed") {
		t.Fatalf("unexpected recovery failure state: %+v", state)
	}
}

// terminalStateTimeout bounds waitForTerminalState. An operation normally ends
// in milliseconds, but under -race with packages and tests in parallel a
// single retried health probe waits two seconds, so the old two-second bound
// failed healthy runs. The poll still returns as soon as the job settles.
const terminalStateTimeout = 30 * time.Second

func waitForTerminalState(t *testing.T, supervisor *Supervisor, operationID string) State {
	t.Helper()
	deadline := time.Now().Add(terminalStateTimeout)
	var last State
	for time.Now().Before(deadline) {
		state, err := supervisor.State()
		if err != nil {
			t.Fatal(err)
		}
		if state.OperationID != operationID {
			t.Fatalf("expected operation %q, received %+v", operationID, state)
		}
		last = state
		if terminalPhase(state.Phase) {
			supervisor.jobMu.Lock()
			running := supervisor.jobRunning
			supervisor.jobMu.Unlock()
			if !running {
				return state
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("operation %q did not reach a terminal state within %s; last state: %+v", operationID, terminalStateTimeout, last)
	return State{}
}

func writeTestCompose(t *testing.T, instanceDir string, version string) string {
	t.Helper()
	directory := filepath.Join(instanceDir, "releases", version)
	if err := os.MkdirAll(directory, 0750); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(directory, "compose.yml")
	if err := os.WriteFile(path, []byte("services: {}\n"), 0600); err != nil {
		t.Fatal(err)
	}
	return path
}

func healthyTestServer(t *testing.T) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(server.Close)
	return server
}
