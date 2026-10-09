package updater

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"maps"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"
)

type CheckResult struct {
	CurrentVersion  string `json:"currentVersion,omitempty"`
	LatestVersion   string `json:"latestVersion"`
	LatestSequence  uint64 `json:"latestSequence"`
	UpdateAvailable bool   `json:"updateAvailable"`
	Channel         string `json:"channel"`
	PublishedAt     string `json:"publishedAt"`
	ReleaseNotesURL string `json:"releaseNotesUrl,omitempty"`
	RequiresBackup  bool   `json:"requiresBackup"`
}

type Supervisor struct {
	config         Config
	updaterVersion string
	manifests      *ManifestClient
	runner         CommandRunner
	state          *StateStore
	jobMu          sync.Mutex
	jobRunning     bool
	acceptingJobs  bool
	activeCancel   context.CancelFunc
	activeDone     chan struct{}
}

func NewSupervisor(config Config, updaterVersion string) *Supervisor {
	return &Supervisor{
		config:         config,
		updaterVersion: updaterVersion,
		manifests:      NewManifestClient(),
		runner:         HostCommandRunner{},
		state:          NewStateStore(config.StatePath()),
		acceptingJobs:  true,
	}
}

func (supervisor *Supervisor) State() (State, error) {
	return supervisor.state.Read()
}

func (supervisor *Supervisor) Reconcile(ctx context.Context) error {
	lock, err := acquireFileLock(supervisor.config.LockPath())
	if err != nil {
		return fmt.Errorf("acquire installation lock for startup reconciliation: %w", err)
	}
	defer releaseFileLock(lock)

	state, err := supervisor.state.Read()
	if err != nil {
		return err
	}
	if state.Phase == PhaseIdle || terminalPhase(state.Phase) {
		return nil
	}

	switch state.Phase {
	case PhaseQueued, PhaseChecking, PhaseDownloading, PhaseValidating,
		PhasePulling, PhaseBackingUp:
		state.Phase = PhaseFailed
		state.Message = "Updater operation was interrupted before deployment; current release unchanged"
		state.Error = "updater restarted before deployment began"
		state.CompletedAt = time.Now().UTC().Format(time.RFC3339)
		return supervisor.state.Write(state)
	case PhaseDeploying, PhaseVerifying, PhaseRollingBack, PhaseRecovering:
		return supervisor.recoverInterruptedDeployment(ctx, state)
	default:
		unknownPhase := state.Phase
		state.Phase = PhaseFailed
		state.Message = "Updater state is unknown; manual intervention required"
		state.Error = fmt.Sprintf("cannot reconcile unknown updater phase %q", unknownPhase)
		state.CompletedAt = time.Now().UTC().Format(time.RFC3339)
		return supervisor.state.Write(state)
	}
}

func (supervisor *Supervisor) recoverInterruptedDeployment(
	ctx context.Context,
	state State,
) error {
	recoveryTarget := state.CurrentComposePath
	firstInstallation := false
	if recoveryTarget == "" {
		recoveryTarget = state.TargetComposePath
		firstInstallation = true
	}
	if recoveryTarget == "" {
		err := errors.New("interrupted deployment has no recoverable release descriptor")
		supervisor.recordRecoveryFailure(state, err)
		return err
	}

	state.Phase = PhaseRecovering
	if firstInstallation {
		state.Message = "Recovering interrupted first installation"
	} else {
		state.Message = "Recovering the last known good Beam Studio release"
	}
	state.Error = ""
	state.CompletedAt = ""
	if err := supervisor.state.Write(state); err != nil {
		return err
	}

	if err := supervisor.deployAndVerify(ctx, recoveryTarget); err != nil {
		supervisor.recordRecoveryFailure(state, err)
		return err
	}
	if err := supervisor.activateRelease(recoveryTarget); err != nil {
		supervisor.recordRecoveryFailure(state, err)
		return err
	}

	if firstInstallation {
		state.Phase = PhaseSucceeded
		state.CurrentVersion = state.TargetVersion
		state.CurrentSequence = state.TargetSequence
		state.CurrentComposePath = state.TargetComposePath
		state.CurrentImages = cloneImages(state.TargetImages)
		state.Message = "Interrupted first installation recovered and verified"
		if state.AcceptedSequences == nil {
			state.AcceptedSequences = make(map[string]uint64)
		}
		if state.TargetSequence > state.AcceptedSequences[supervisor.config.Channel] {
			state.AcceptedSequences[supervisor.config.Channel] = state.TargetSequence
		}
	} else {
		state.Phase = PhaseFailed
		state.Message = "Interrupted operation failed; previous release restored"
		state.Error = "updater restarted after deployment began"
		state.PreviousRestored = true
	}
	state.CompletedAt = time.Now().UTC().Format(time.RFC3339)
	return supervisor.state.Write(state)
}

func (supervisor *Supervisor) recordRecoveryFailure(state State, recoveryErr error) {
	state.Phase = PhaseFailed
	state.Message = "Automatic recovery failed; manual intervention required"
	state.Error = recoveryErr.Error()
	state.CompletedAt = time.Now().UTC().Format(time.RFC3339)
	_ = supervisor.state.Write(state)
}

func (supervisor *Supervisor) Check(ctx context.Context) (CheckResult, error) {
	manifest, err := supervisor.fetchManifest(ctx)
	if err != nil {
		return CheckResult{}, err
	}
	state, err := supervisor.state.Read()
	if err != nil {
		return CheckResult{}, err
	}
	available := state.CurrentVersion == ""
	if accepted := state.AcceptedSequences[supervisor.config.Channel]; accepted > 0 && manifest.Sequence < accepted {
		return CheckResult{}, fmt.Errorf(
			"release channel %q sequence regressed from %d to %d",
			supervisor.config.Channel,
			accepted,
			manifest.Sequence,
		)
	}
	if state.CurrentSequence > 0 {
		available = manifest.Sequence > state.CurrentSequence
	} else if state.CurrentVersion != "" {
		comparison, err := compareVersions(state.CurrentVersion, manifest.Version)
		if err != nil {
			return CheckResult{}, err
		}
		available = comparison < 0
	}
	return CheckResult{
		CurrentVersion:  state.CurrentVersion,
		LatestVersion:   manifest.Version,
		LatestSequence:  manifest.Sequence,
		UpdateAvailable: available,
		Channel:         manifest.Channel,
		PublishedAt:     manifest.PublishedAt,
		ReleaseNotesURL: manifest.ReleaseNotesURL,
		RequiresBackup:  manifest.RequiresBackup,
	}, nil
}

func (supervisor *Supervisor) StartApply(force bool) (string, error) {
	return supervisor.startOperation(
		OperationApply,
		"Beam Studio update queued",
		func(ctx context.Context) error { return supervisor.Apply(ctx, force) },
	)
}

func (supervisor *Supervisor) StartRollback() (string, error) {
	return supervisor.startOperation(
		OperationRollback,
		"Beam Studio rollback queued",
		supervisor.Rollback,
	)
}

func (supervisor *Supervisor) startOperation(
	operation string,
	message string,
	run func(context.Context) error,
) (string, error) {
	supervisor.jobMu.Lock()
	defer supervisor.jobMu.Unlock()
	if !supervisor.acceptingJobs {
		return "", errors.New("the updater is shutting down")
	}
	if supervisor.jobRunning {
		return "", errors.New("an updater operation is already running")
	}
	operationID, err := newOperationID()
	if err != nil {
		return "", err
	}
	startedAt := time.Now().UTC().Format(time.RFC3339)
	if _, err := supervisor.state.Update(func(state *State) {
		state.OperationID = operationID
		state.Operation = operation
		state.Phase = PhaseQueued
		state.TargetVersion = ""
		state.TargetSequence = 0
		state.TargetComposePath = ""
		state.TargetImages = nil
		state.CompletedImagePulls = nil
		state.PreviousRestored = false
		state.Message = message
		state.Error = ""
		state.StartedAt = startedAt
		state.CompletedAt = ""
	}); err != nil {
		return "", err
	}
	operationContext, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	supervisor.jobRunning = true
	supervisor.activeCancel = cancel
	supervisor.activeDone = done
	go func() {
		defer func() {
			supervisor.jobMu.Lock()
			supervisor.jobRunning = false
			supervisor.activeCancel = nil
			supervisor.activeDone = nil
			close(done)
			supervisor.jobMu.Unlock()
		}()
		if err := run(operationContext); err != nil {
			supervisor.ensureOperationFailed(operationID, operation, err)
			fmt.Fprintf(os.Stderr, "Beam Studio %s failed: %v\n", operation, err)
		}
	}()
	return operationID, nil
}

func (supervisor *Supervisor) Shutdown(ctx context.Context) error {
	supervisor.jobMu.Lock()
	supervisor.acceptingJobs = false
	cancel := supervisor.activeCancel
	done := supervisor.activeDone
	supervisor.jobMu.Unlock()
	if cancel == nil || done == nil {
		return nil
	}
	cancel()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return fmt.Errorf("wait for active updater operation during shutdown: %w", ctx.Err())
	}
}

func (supervisor *Supervisor) Apply(parent context.Context, force bool) (resultErr error) {
	lock, err := acquireFileLock(supervisor.config.LockPath())
	if err != nil {
		return err
	}
	defer releaseFileLock(lock)

	ctx, cancel := context.WithTimeout(parent, supervisor.config.UpdateTimeout())
	defer cancel()
	startedAt := time.Now().UTC().Format(time.RFC3339)
	previous, err := supervisor.state.Read()
	if err != nil {
		return err
	}
	if err := supervisor.setPhase(PhaseChecking, "", "Checking the signed release manifest", "", startedAt); err != nil {
		return err
	}

	manifest, err := supervisor.fetchManifest(ctx)
	if err != nil {
		supervisor.failState(err)
		return err
	}
	acceptedSequence := previous.AcceptedSequences[supervisor.config.Channel]
	if acceptedSequence > 0 && manifest.Sequence < acceptedSequence {
		err := fmt.Errorf(
			"release channel %q sequence regressed from %d to %d",
			supervisor.config.Channel,
			acceptedSequence,
			manifest.Sequence,
		)
		supervisor.failState(err)
		return err
	}
	if previous.CurrentSequence > 0 && manifest.Sequence < previous.CurrentSequence {
		err := fmt.Errorf(
			"release sequence %d is older than installed sequence %d",
			manifest.Sequence,
			previous.CurrentSequence,
		)
		supervisor.failState(err)
		return err
	}
	if previous.CurrentSequence > 0 && manifest.Sequence == previous.CurrentSequence {
		if manifest.Version != previous.CurrentVersion ||
			!maps.Equal(manifest.Images, previous.CurrentImages) {
			err := fmt.Errorf(
				"release sequence %d was republished with different version or images",
				manifest.Sequence,
			)
			supervisor.failState(err)
			return err
		}
		if !force {
			previous.Phase = PhaseSucceeded
			previous.TargetVersion = manifest.Version
			previous.TargetSequence = manifest.Sequence
			previous.TargetImages = cloneImages(manifest.Images)
			previous.Message = fmt.Sprintf("Beam Studio %s is already installed", previous.CurrentVersion)
			previous.Error = ""
			previous.StartedAt = startedAt
			previous.CompletedAt = time.Now().UTC().Format(time.RFC3339)
			return supervisor.state.Write(previous)
		}
	}
	if previous.CurrentVersion != "" {
		comparison, compareErr := compareVersions(previous.CurrentVersion, manifest.Version)
		if compareErr != nil {
			supervisor.failState(compareErr)
			return compareErr
		}
		if comparison > 0 && !manifest.AllowDowngrade && !force {
			err := fmt.Errorf(
				"release %s is older than installed version %s and is not marked as an allowed downgrade",
				manifest.Version,
				previous.CurrentVersion,
			)
			supervisor.failState(err)
			return err
		}
	}
	if previous.CurrentVersion != "" && !manifest.RollbackSafe {
		err := errors.New("release is not marked rollback-safe and cannot be installed with one-click update")
		supervisor.failState(err)
		return err
	}

	if err := supervisor.setPhase(
		PhaseDownloading,
		manifest.Version,
		"Rendering the verified release image map",
		"",
		startedAt,
	); err != nil {
		return err
	}
	composePath, err := supervisor.prepareRelease(ctx, manifest)
	if err != nil {
		supervisor.failState(err)
		return err
	}
	if err := supervisor.setTargetRelease(manifest, composePath); err != nil {
		return err
	}

	if err := supervisor.setPhase(PhaseValidating, manifest.Version, "Validating Docker Compose", "", startedAt); err != nil {
		return err
	}
	if err := supervisor.runCompose(ctx, composePath, io.Discard, "config", "--quiet"); err != nil {
		supervisor.failState(err)
		return err
	}

	imageOrder := imageKeys(manifest)
	completedImagePulls := make([]string, 0, len(imageOrder))
	for index, service := range imageOrder {
		message := fmt.Sprintf("Pulling image %d/%d: %s", index+1, len(imageOrder), service)
		if err := supervisor.setPhase(PhasePulling, manifest.Version, message, "", startedAt); err != nil {
			return err
		}
		// Pull the signed image reference rather than a Compose service: one image
		// may back several services (worker-1, worker-2, ...) or none named after it.
		if err := supervisor.runner.Run(
			ctx,
			io.Discard,
			supervisor.config.DockerBinary,
			"pull",
			"--quiet",
			manifest.Images[service],
		); err != nil {
			supervisor.failState(fmt.Errorf("pull %s image: %w", service, err))
			return fmt.Errorf("pull %s image: %w", service, err)
		}
		if _, err := supervisor.state.Update(func(state *State) {
			state.CompletedImagePulls = append(state.CompletedImagePulls, message)
		}); err != nil {
			return err
		}
		completedImagePulls = append(completedImagePulls, message)
	}

	if supervisor.config.BackupEnabled &&
		manifest.RequiresBackup &&
		previous.CurrentComposePath != "" {
		if err := supervisor.setPhase(PhaseBackingUp, manifest.Version, "Backing up PostgreSQL", "", startedAt); err != nil {
			return err
		}
		if err := supervisor.backupDatabase(ctx, previous); err != nil {
			supervisor.failState(err)
			return err
		}
	}

	deploymentStarted := false
	defer func() {
		if resultErr == nil || !deploymentStarted || previous.CurrentComposePath == "" {
			return
		}
		rollbackContext, cancelRollback := context.WithTimeout(
			context.Background(),
			supervisor.config.UpdateTimeout(),
		)
		defer cancelRollback()
		if stateErr := supervisor.setPhase(
			PhaseRollingBack,
			previous.CurrentVersion,
			"Update failed; restoring the previous release",
			resultErr.Error(),
			startedAt,
		); stateErr != nil {
			resultErr = errors.Join(resultErr, fmt.Errorf("persist automatic rollback state: %w", stateErr))
		}
		if rollbackErr := supervisor.deployAndVerify(
			rollbackContext,
			previous.CurrentComposePath,
		); rollbackErr != nil {
			resultErr = fmt.Errorf("%w; automatic rollback also failed: %v", resultErr, rollbackErr)
			supervisor.failState(resultErr)
			return
		}
		rolledBack := previous
		rolledBack.Phase = PhaseFailed
		rolledBack.TargetVersion = manifest.Version
		rolledBack.TargetSequence = manifest.Sequence
		rolledBack.TargetComposePath = composePath
		rolledBack.TargetImages = cloneImages(manifest.Images)
		rolledBack.CompletedImagePulls = append([]string(nil), completedImagePulls...)
		rolledBack.Message = "Update failed; previous release restored"
		rolledBack.Error = resultErr.Error()
		rolledBack.PreviousRestored = true
		rolledBack.StartedAt = startedAt
		rolledBack.CompletedAt = time.Now().UTC().Format(time.RFC3339)
		_ = supervisor.state.Write(rolledBack)
	}()

	if err := supervisor.setPhase(PhaseDeploying, manifest.Version, "Replacing the Beam Studio stack", "", startedAt); err != nil {
		return err
	}
	deploymentStarted = true
	if err := supervisor.deployAndVerify(ctx, composePath); err != nil {
		resultErr = err
		supervisor.failState(err)
		return resultErr
	}

	if err := supervisor.activateRelease(composePath); err != nil {
		resultErr = err
		supervisor.failState(err)
		return resultErr
	}

	next := State{
		OperationID:         previous.OperationID,
		Operation:           previous.Operation,
		Phase:               PhaseSucceeded,
		CurrentVersion:      manifest.Version,
		CurrentSequence:     manifest.Sequence,
		CurrentComposePath:  composePath,
		CurrentImages:       cloneImages(manifest.Images),
		PreviousVersion:     previous.CurrentVersion,
		PreviousSequence:    previous.CurrentSequence,
		PreviousComposePath: previous.CurrentComposePath,
		PreviousImages:      cloneImages(previous.CurrentImages),
		TargetVersion:       manifest.Version,
		TargetSequence:      manifest.Sequence,
		TargetComposePath:   composePath,
		TargetImages:        cloneImages(manifest.Images),
		CompletedImagePulls: append([]string(nil), completedImagePulls...),
		AcceptedSequences:   cloneSequences(previous.AcceptedSequences),
		Message:             "Beam Studio update completed",
		StartedAt:           startedAt,
		CompletedAt:         time.Now().UTC().Format(time.RFC3339),
	}
	if next.AcceptedSequences == nil {
		next.AcceptedSequences = make(map[string]uint64)
	}
	if manifest.Sequence > next.AcceptedSequences[supervisor.config.Channel] {
		next.AcceptedSequences[supervisor.config.Channel] = manifest.Sequence
	}
	if err := supervisor.state.Write(next); err != nil {
		return err
	}
	return nil
}

func (supervisor *Supervisor) Rollback(parent context.Context) error {
	lock, err := acquireFileLock(supervisor.config.LockPath())
	if err != nil {
		return err
	}
	defer releaseFileLock(lock)

	state, err := supervisor.state.Read()
	if err != nil {
		return err
	}
	if state.PreviousComposePath == "" || state.PreviousVersion == "" {
		return errors.New("no previous Beam Studio release is available")
	}

	ctx, cancel := context.WithTimeout(parent, supervisor.config.UpdateTimeout())
	defer cancel()
	startedAt := time.Now().UTC().Format(time.RFC3339)
	if err := supervisor.setPhase(
		PhaseRollingBack,
		state.PreviousVersion,
		"Restoring the previous Beam Studio release",
		"",
		startedAt,
	); err != nil {
		return err
	}
	if err := supervisor.deployAndVerify(ctx, state.PreviousComposePath); err != nil {
		supervisor.failState(err)
		return err
	}
	if err := supervisor.activateRelease(state.PreviousComposePath); err != nil {
		supervisor.failState(err)
		return err
	}

	next := State{
		OperationID:         state.OperationID,
		Operation:           state.Operation,
		Phase:               PhaseSucceeded,
		CurrentVersion:      state.PreviousVersion,
		CurrentSequence:     state.PreviousSequence,
		CurrentComposePath:  state.PreviousComposePath,
		CurrentImages:       cloneImages(state.PreviousImages),
		PreviousVersion:     state.CurrentVersion,
		PreviousSequence:    state.CurrentSequence,
		PreviousComposePath: state.CurrentComposePath,
		PreviousImages:      cloneImages(state.CurrentImages),
		TargetVersion:       state.PreviousVersion,
		TargetSequence:      state.PreviousSequence,
		TargetComposePath:   state.PreviousComposePath,
		TargetImages:        cloneImages(state.PreviousImages),
		AcceptedSequences:   cloneSequences(state.AcceptedSequences),
		Message:             "Beam Studio rollback completed",
		StartedAt:           startedAt,
		CompletedAt:         time.Now().UTC().Format(time.RFC3339),
	}
	return supervisor.state.Write(next)
}

func (supervisor *Supervisor) fetchManifest(ctx context.Context) (ReleaseManifest, error) {
	manifest, err := supervisor.manifests.FetchAndVerify(
		ctx,
		supervisor.config.ControlPlaneURL,
		supervisor.config.PublicKeyPath,
		supervisor.config.Channel,
	)
	if err != nil {
		return ReleaseManifest{}, err
	}
	if manifest.DeploymentSchemaVersion != supportedDeploymentSchemaVersion {
		return ReleaseManifest{}, fmt.Errorf(
			"updater supports deployment schema %d; release requires %d; rerun install.sh",
			supportedDeploymentSchemaVersion,
			manifest.DeploymentSchemaVersion,
		)
	}
	if manifest.MinimumUpdaterVersion != "" && supervisor.updaterVersion != "dev" {
		comparison, err := compareVersions(supervisor.updaterVersion, manifest.MinimumUpdaterVersion)
		if err != nil {
			return ReleaseManifest{}, err
		}
		if comparison < 0 {
			return ReleaseManifest{}, fmt.Errorf(
				"updater %s is too old; release requires %s",
				supervisor.updaterVersion,
				manifest.MinimumUpdaterVersion,
			)
		}
	}
	return manifest, nil
}

func (supervisor *Supervisor) prepareRelease(
	ctx context.Context,
	manifest ReleaseManifest,
) (string, error) {
	versionDir := filepath.Join(
		supervisor.config.ReleasesDir(),
		fmt.Sprintf(
			"%020d-%s",
			manifest.Sequence,
			strings.TrimPrefix(manifest.Version, "v"),
		),
	)
	if !pathInside(supervisor.config.ReleasesDir(), versionDir) {
		return "", errors.New("release path escaped the configured releases directory")
	}
	if err := os.MkdirAll(versionDir, 0750); err != nil {
		return "", fmt.Errorf("create release directory: %w", err)
	}
	composePath := filepath.Join(versionDir, "compose.yml")
	template, err := supervisor.releaseTemplate(ctx, manifest, versionDir)
	if err != nil {
		return "", err
	}
	if len(template) > 2<<20 {
		return "", errors.New("release Compose template exceeds 2 MiB")
	}
	data, err := renderComposeTemplate(template, manifest)
	if err != nil {
		return "", err
	}
	temporary, err := os.CreateTemp(versionDir, ".compose-*.yml")
	if err != nil {
		return "", err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0640); err != nil {
		temporary.Close()
		return "", err
	}
	if _, err := temporary.Write(data); err != nil {
		temporary.Close()
		return "", err
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return "", err
	}
	if err := temporary.Close(); err != nil {
		return "", err
	}
	if err := os.Rename(temporaryPath, composePath); err != nil {
		return "", err
	}
	if err := syncParentDirectory(composePath); err != nil {
		return "", fmt.Errorf("sync release directory: %w", err)
	}
	descriptorPath := filepath.Join(versionDir, "release.json")
	descriptor := struct {
		Channel string `json:"channel"`
		ReleaseManifest
	}{Channel: manifest.Channel, ReleaseManifest: manifest}
	descriptorData, err := json.MarshalIndent(descriptor, "", "  ")
	if err != nil {
		return "", fmt.Errorf("encode local release descriptor: %w", err)
	}
	if err := writeFileAtomically(descriptorPath, append(descriptorData, '\n'), 0640); err != nil {
		return "", fmt.Errorf("write local release descriptor: %w", err)
	}
	return composePath, nil
}

func (supervisor *Supervisor) deployAndVerify(ctx context.Context, composePath string) error {
	declared, err := supervisor.inspectDeployment(ctx, composePath)
	if err != nil {
		return err
	}
	if err := supervisor.runCompose(
		ctx,
		composePath,
		os.Stdout,
		"up",
		"-d",
		"--remove-orphans",
		"--wait",
		"--wait-timeout",
		fmt.Sprintf("%d", supervisor.config.HealthTimeoutSeconds),
	); err != nil {
		return err
	}

	if err := supervisor.setPhase(PhaseVerifying, "", "Waiting for the release health endpoints", "", ""); err != nil {
		return fmt.Errorf("persist verification phase: %w", err)
	}
	targets := supervisor.healthTargets(declared)
	deadline := time.Now().Add(supervisor.config.HealthTimeout())
	client := &http.Client{Timeout: 5 * time.Second}
	lastErr := errors.New("health endpoints did not respond")
	for time.Now().Before(deadline) {
		lastErr = nil
		for _, target := range targets {
			if err := probeHealth(ctx, client, target); err != nil {
				lastErr = fmt.Errorf("%s: %w", target, err)
				break
			}
		}
		if lastErr == nil {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(2 * time.Second):
		}
	}
	return fmt.Errorf("Studio health verification timed out: %w", lastErr)
}

// releaseTemplate extracts the Compose template shipped in the release's signed,
// digest-pinned updater image. Rendering the template installed with the first
// release instead would leave every later deployment change (environment,
// mounts, services) out of the updates that are meant to deliver it.
func (supervisor *Supervisor) releaseTemplate(
	ctx context.Context,
	manifest ReleaseManifest,
	versionDir string,
) ([]byte, error) {
	docker := supervisor.config.DockerBinary
	if err := supervisor.runner.Run(ctx, io.Discard, docker, "pull", "--quiet", manifest.Updater); err != nil {
		return nil, fmt.Errorf("pull release updater image: %w", err)
	}
	var created bytes.Buffer
	if err := supervisor.runner.Run(ctx, &created, docker, "create", manifest.Updater); err != nil {
		return nil, fmt.Errorf("create release updater container: %w", err)
	}
	container := strings.TrimSpace(created.String())
	if container == "" {
		return nil, errors.New("docker create returned no container ID")
	}
	defer func() {
		_ = supervisor.runner.Run(context.Background(), io.Discard, docker, "rm", "--force", container)
	}()
	path := filepath.Join(versionDir, "compose.template.yml")
	if err := supervisor.runner.Run(
		ctx,
		io.Discard,
		docker,
		"cp",
		container+":/compose.release.template.yml",
		path,
	); err != nil {
		return nil, fmt.Errorf("extract release Compose template: %w", err)
	}
	template, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read release Compose template: %w", err)
	}
	return template, nil
}

func (supervisor *Supervisor) runCompose(
	ctx context.Context,
	composePath string,
	stdout io.Writer,
	arguments ...string,
) error {
	args := composeArguments(supervisor.config, composePath, arguments...)
	return supervisor.runner.Run(ctx, stdout, supervisor.config.DockerBinary, args...)
}

func (supervisor *Supervisor) backupDatabase(ctx context.Context, state State) error {
	if err := os.MkdirAll(supervisor.config.BackupsDir(), 0750); err != nil {
		return fmt.Errorf("create backup directory: %w", err)
	}
	filename := fmt.Sprintf(
		"beam-studio-%s-%s.dump",
		strings.TrimPrefix(state.CurrentVersion, "v"),
		time.Now().UTC().Format("20060102T150405Z"),
	)
	path := filepath.Join(supervisor.config.BackupsDir(), filename)
	file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return fmt.Errorf("create database backup: %w", err)
	}
	declared, backupErr := supervisor.inspectDeployment(ctx, state.CurrentComposePath)
	if backupErr == nil {
		target := supervisor.backupTarget(declared)
		backupErr = supervisor.runCompose(
			ctx,
			state.CurrentComposePath,
			file,
			"exec",
			"-T",
			target.service,
			"pg_dump",
			"-U",
			target.user,
			"-d",
			target.database,
			"-Fc",
		)
	}
	syncErr := file.Sync()
	closeErr := file.Close()
	if backupErr != nil {
		os.Remove(path)
		return fmt.Errorf("back up PostgreSQL: %w", backupErr)
	}
	if syncErr != nil {
		os.Remove(path)
		return fmt.Errorf("sync PostgreSQL backup: %w", syncErr)
	}
	if closeErr != nil {
		return closeErr
	}
	return supervisor.pruneBackups()
}

func (supervisor *Supervisor) pruneBackups() error {
	entries, err := os.ReadDir(supervisor.config.BackupsDir())
	if err != nil {
		return err
	}
	type backupFile struct {
		path    string
		modTime time.Time
	}
	var backups []backupFile
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".dump") {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		backups = append(backups, backupFile{
			path:    filepath.Join(supervisor.config.BackupsDir(), entry.Name()),
			modTime: info.ModTime(),
		})
	}
	sort.Slice(backups, func(i, j int) bool {
		return backups[i].modTime.After(backups[j].modTime)
	})
	if len(backups) <= supervisor.config.BackupRetention {
		return nil
	}
	for _, backup := range backups[supervisor.config.BackupRetention:] {
		if err := os.Remove(backup.path); err != nil {
			return err
		}
	}
	return nil
}

func (supervisor *Supervisor) activateRelease(composePath string) error {
	currentLink := filepath.Join(supervisor.config.InstanceDir, "current")
	relativeTarget, err := filepath.Rel(supervisor.config.InstanceDir, filepath.Dir(composePath))
	if err != nil {
		return err
	}
	temporaryLink := fmt.Sprintf("%s.tmp-%d", currentLink, time.Now().UnixNano())
	if err := os.Symlink(relativeTarget, temporaryLink); err != nil {
		return fmt.Errorf("create current release symlink: %w", err)
	}
	defer os.Remove(temporaryLink)
	if err := os.Rename(temporaryLink, currentLink); err != nil {
		return fmt.Errorf("activate current release symlink: %w", err)
	}
	if err := syncParentDirectory(currentLink); err != nil {
		return fmt.Errorf("sync current release link: %w", err)
	}
	return nil
}

func (supervisor *Supervisor) setPhase(
	phase string,
	targetVersion string,
	message string,
	errorMessage string,
	startedAt string,
) error {
	_, err := supervisor.state.Update(func(state *State) {
		state.Phase = phase
		if targetVersion != "" {
			state.TargetVersion = targetVersion
		}
		state.Message = message
		state.Error = errorMessage
		if startedAt != "" {
			state.StartedAt = startedAt
			state.CompletedAt = ""
		}
	})
	return err
}

func (supervisor *Supervisor) setTargetRelease(manifest ReleaseManifest, composePath string) error {
	_, err := supervisor.state.Update(func(state *State) {
		state.TargetSequence = manifest.Sequence
		state.TargetComposePath = composePath
		state.TargetImages = cloneImages(manifest.Images)
	})
	return err
}

func (supervisor *Supervisor) failState(err error) {
	_, stateErr := supervisor.state.Update(func(state *State) {
		state.Phase = PhaseFailed
		operation := state.Operation
		if operation == "" {
			operation = OperationApply
		}
		state.Message = fmt.Sprintf("Beam Studio %s failed", operation)
		state.Error = err.Error()
		state.CompletedAt = time.Now().UTC().Format(time.RFC3339)
	})
	if stateErr != nil {
		fmt.Fprintf(os.Stderr, "persist terminal updater state: %v\n", stateErr)
	}
}

func (supervisor *Supervisor) ensureOperationFailed(
	operationID string,
	operation string,
	err error,
) {
	_, stateErr := supervisor.state.Update(func(state *State) {
		if state.OperationID != operationID || terminalPhase(state.Phase) {
			return
		}
		state.Phase = PhaseFailed
		state.Message = fmt.Sprintf("Beam Studio %s failed", operation)
		state.Error = err.Error()
		state.CompletedAt = time.Now().UTC().Format(time.RFC3339)
	})
	if stateErr != nil {
		fmt.Fprintf(os.Stderr, "persist terminal updater state: %v\n", stateErr)
	}
}

func renderComposeTemplate(template []byte, manifest ReleaseManifest) ([]byte, error) {
	replacements := map[string]string{"@BEAM_STUDIO_VERSION@": manifest.Version}
	for key, reference := range manifest.Images {
		replacements[imagePlaceholder(key)] = reference
	}
	rendered := string(template)
	for placeholder, value := range replacements {
		if !strings.Contains(rendered, placeholder) {
			return nil, fmt.Errorf("release Compose template is missing %s", placeholder)
		}
		rendered = strings.ReplaceAll(rendered, placeholder, value)
	}
	if strings.Contains(rendered, "@IMAGE_") ||
		strings.Contains(rendered, "@BEAM_STUDIO_VERSION@") {
		return nil, errors.New("release Compose template contains unresolved placeholders")
	}
	return []byte(rendered), nil
}

// imagePlaceholder is the template token for a release image: worker-pool
// becomes @IMAGE_WORKER_POOL@.
func imagePlaceholder(key string) string {
	return "@IMAGE_" + strings.ToUpper(strings.ReplaceAll(key, "-", "_")) + "@"
}

func probeHealth(ctx context.Context, client *http.Client, target string) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return err
	}
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("endpoint returned HTTP %d", response.StatusCode)
	}
	return nil
}

func writeFileAtomically(path string, data []byte, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0750); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), ".release-*")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(mode); err != nil {
		temporary.Close()
		return err
	}
	if _, err := temporary.Write(data); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := os.Rename(temporaryPath, path); err != nil {
		return err
	}
	return syncParentDirectory(path)
}

func cloneImages(images map[string]string) map[string]string {
	if images == nil {
		return nil
	}
	clone := make(map[string]string, len(images))
	for key, value := range images {
		clone[key] = value
	}
	return clone
}

func cloneSequences(sequences map[string]uint64) map[string]uint64 {
	if sequences == nil {
		return nil
	}
	clone := make(map[string]uint64, len(sequences))
	for key, value := range sequences {
		clone[key] = value
	}
	return clone
}

func newOperationID() (string, error) {
	data := make([]byte, 16)
	if _, err := rand.Read(data); err != nil {
		return "", fmt.Errorf("generate updater operation ID: %w", err)
	}
	return hex.EncodeToString(data), nil
}

func pathInside(root string, candidate string) bool {
	relative, err := filepath.Rel(root, candidate)
	return err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}

func acquireFileLock(path string) (*os.File, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0750); err != nil {
		return nil, err
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0640)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		file.Close()
		return nil, errors.New("another updater process holds the installation lock")
	}
	return file, nil
}

func releaseFileLock(file *os.File) {
	_ = syscall.Flock(int(file.Fd()), syscall.LOCK_UN)
	_ = file.Close()
}
