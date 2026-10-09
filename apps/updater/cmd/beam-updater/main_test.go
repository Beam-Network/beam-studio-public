package main

import (
	"bytes"
	"strings"
	"testing"
	"time"

	"github.com/Beam-Network/beam-studio-public/apps/updater/internal/updater"
)

func TestAcceptedOperationID(t *testing.T) {
	t.Parallel()
	operationID, err := acceptedOperationID([]byte(`{"accepted":true,"operationId":"op-123"}`))
	if err != nil {
		t.Fatal(err)
	}
	if operationID != "op-123" {
		t.Fatalf("expected op-123, received %q", operationID)
	}
}

func TestAcceptedOperationIDIsRequired(t *testing.T) {
	t.Parallel()
	if _, err := acceptedOperationID([]byte(`{"accepted":true}`)); err == nil {
		t.Fatal("expected a missing operation ID to be rejected")
	}
}

func TestWaitForOperationHasBoundedFailure(t *testing.T) {
	t.Parallel()
	err := waitForOperation("/unused/updater.sock", "op-timeout", time.Millisecond)
	if err == nil || !strings.Contains(err.Error(), "timed out") ||
		!strings.Contains(err.Error(), "phase queued") {
		t.Fatalf("expected bounded wait error with last phase, received %v", err)
	}
}

func TestOperationProgressShowsEachImageOnceAfterFastPulls(t *testing.T) {
	t.Parallel()
	var output bytes.Buffer
	progress := operationProgress{output: &output}
	state := updater.State{
		Phase:               updater.PhasePulling,
		Message:             "Pulling image 3/7: api",
		CompletedImagePulls: []string{"Pulling image 1/7: postgres", "Pulling image 2/7: nats"},
	}
	progress.update(state)
	progress.update(state)
	state.CompletedImagePulls = append(state.CompletedImagePulls, state.Message)
	state.Phase = updater.PhaseDeploying
	state.Message = "Replacing the Beam Studio stack"
	progress.update(state)
	if count := strings.Count(output.String(), "[OK] Pulling image "); count != 3 {
		t.Fatalf("expected three completed image lines, received %d: %s", count, output.String())
	}
	for _, image := range []string{"postgres", "nats", "api"} {
		if !strings.Contains(output.String(), image) {
			t.Fatalf("missing image %s: %s", image, output.String())
		}
	}
	if strings.Count(output.String(), "Pulling image 3/7: api") != 2 {
		t.Fatalf("expected one active and one completed line: %s", output.String())
	}
}

func TestOperationProgressMarksFailedImage(t *testing.T) {
	t.Parallel()
	var output bytes.Buffer
	progress := operationProgress{output: &output}
	progress.update(updater.State{Phase: updater.PhasePulling, Message: "Pulling image 1/7: postgres"})
	progress.update(updater.State{Phase: updater.PhaseFailed, Message: "Beam Studio apply failed"})
	if !strings.Contains(output.String(), "[FAILED] Pulling image 1/7: postgres") ||
		strings.Contains(output.String(), "[OK] Pulling image 1/7: postgres") {
		t.Fatalf("failed image was not reported accurately: %s", output.String())
	}
}
