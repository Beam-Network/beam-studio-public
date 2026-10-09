package updater

import (
	"strings"
	"testing"
)

func TestReleaseDeclaresItsOwnHealthChecksAndBackup(t *testing.T) {
	t.Parallel()
	declared, err := parseDeployment([]byte(`{"services":{
		"web":{"labels":{"beam.studio.health-url":"http://127.0.0.1:4000/health"}},
		"api":{"labels":{"beam.studio.health-url":"http://127.0.0.1:8787/health"}},
		"db":{"labels":{"beam.studio.backup":"postgresql"},
		      "environment":{"POSTGRES_USER":"studio","POSTGRES_DB":"studio_data","POSTGRES_PASSWORD":"x"}},
		"worker":{"environment":{"A":null}}
	}}`))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(declared.healthURLs, " ") != "http://127.0.0.1:8787/health http://127.0.0.1:4000/health" {
		t.Fatalf("unexpected health URLs %v", declared.healthURLs)
	}
	supervisor := NewSupervisor(Config{}, "1.0.0")
	if targets := supervisor.healthTargets(declared); len(targets) != 2 {
		t.Fatalf("declared health URLs must replace the configured ones: %v", targets)
	}
	backup := supervisor.backupTarget(declared)
	if backup != (deploymentBackup{service: "db", user: "studio", database: "studio_data"}) {
		t.Fatalf("unexpected backup target %+v", backup)
	}
}

func TestPostgresBackupUsesTheImageDefaults(t *testing.T) {
	t.Parallel()
	declared, err := parseDeployment([]byte(`{"services":{"db":{"labels":{"beam.studio.backup":"postgresql"}}}}`))
	if err != nil {
		t.Fatal(err)
	}
	if *declared.backup != (deploymentBackup{service: "db", user: "postgres", database: "postgres"}) {
		t.Fatalf("unexpected backup target %+v", declared.backup)
	}
}

func TestTemplatesWithoutLabelsFallBackToTheConfiguredDeployment(t *testing.T) {
	t.Parallel()
	declared, err := parseDeployment([]byte(`{"services":{"api":{}}}`))
	if err != nil {
		t.Fatal(err)
	}
	config := Config{
		HealthURL:       "http://127.0.0.1:8787/health",
		StudioHealthURL: "http://127.0.0.1:3004/health",
		DatabaseService: "postgres",
		DatabaseUser:    "beam",
		DatabaseName:    "beam_studio",
	}
	supervisor := NewSupervisor(config, "1.0.0")
	if targets := supervisor.healthTargets(declared); strings.Join(targets, " ") !=
		"http://127.0.0.1:8787/health http://127.0.0.1:3004/health" {
		t.Fatalf("unexpected fallback health URLs %v", targets)
	}
	if backup := supervisor.backupTarget(declared); backup !=
		(deploymentBackup{service: "postgres", user: "beam", database: "beam_studio"}) {
		t.Fatalf("unexpected fallback backup target %+v", backup)
	}
}

func TestInvalidDeploymentLabelsAreRejected(t *testing.T) {
	t.Parallel()
	for name, config := range map[string]string{
		"relative health URL": `{"services":{"api":{"labels":{"beam.studio.health-url":"/health"}}}}`,
		"non-HTTP health URL": `{"services":{"api":{"labels":{"beam.studio.health-url":"file:///etc/passwd"}}}}`,
		"unknown backup":      `{"services":{"db":{"labels":{"beam.studio.backup":"mysql"}}}}`,
		"two backups": `{"services":{"a":{"labels":{"beam.studio.backup":"postgresql"}},
			"b":{"labels":{"beam.studio.backup":"postgresql"}}}}`,
	} {
		if _, err := parseDeployment([]byte(config)); err == nil {
			t.Fatalf("expected %s to be rejected", name)
		}
	}
}

func TestTemplatePlaceholdersFollowTheReleaseImageKeys(t *testing.T) {
	t.Parallel()
	manifest := testRelease("v1.2.3", 7)
	manifest.Images = map[string]string{
		"worker-pool": testImage("ghcr.io/beam-network/beam-studio-runtime-worker-pool", "a"),
	}
	rendered, err := renderComposeTemplate(
		[]byte("services:\n  pool:\n    image: \"@IMAGE_WORKER_POOL@\"\nx-version: \"@BEAM_STUDIO_VERSION@\"\n"),
		manifest,
	)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(rendered), manifest.Images["worker-pool"]) {
		t.Fatalf("expected the worker-pool image to be rendered:\n%s", rendered)
	}
	if _, err := renderComposeTemplate([]byte("services: {}\nx: \"@BEAM_STUDIO_VERSION@\"\n"), manifest); err == nil {
		t.Fatal("expected a template missing a release image placeholder to be rejected")
	}
}
