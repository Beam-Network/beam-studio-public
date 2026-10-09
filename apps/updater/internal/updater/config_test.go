package updater

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestLoadConfigAppliesSafeDefaults(t *testing.T) {
	t.Parallel()
	tempDir := t.TempDir()
	configPath := filepath.Join(tempDir, "updater.json")
	data, err := json.Marshal(map[string]any{
		"instanceDir":     tempDir,
		"controlPlaneUrl": "https://cdn.example/studio/latest.json",
		"publicKeyPath":   filepath.Join(tempDir, "release-key.pem"),
		"socketPath":      filepath.Join(tempDir, "updater.sock"),
		"envFile":         filepath.Join(tempDir, ".env"),
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(configPath, data, 0600); err != nil {
		t.Fatal(err)
	}
	config, err := LoadConfig(configPath)
	if err != nil {
		t.Fatal(err)
	}
	if config.Channel != "stable" ||
		config.ComposeProject != "beam-studio" ||
		config.HealthURL != "http://127.0.0.1:8787/health" ||
		config.StudioHealthURL != "http://127.0.0.1:3004/health" ||
		config.ComposeTemplatePath != "/usr/local/share/beam-studio/compose.release.template.yml" {
		t.Fatalf("safe defaults were not applied: %+v", config)
	}
	if config.UpdateTimeoutSeconds != 900 || config.HealthTimeoutSeconds != 180 {
		t.Fatalf("timeout defaults were not applied: %+v", config)
	}
}

func TestLoadConfigRejectsInsecureControlPlane(t *testing.T) {
	t.Parallel()
	tempDir := t.TempDir()
	configPath := filepath.Join(tempDir, "updater.json")
	data, err := json.Marshal(map[string]any{
		"instanceDir":     tempDir,
		"controlPlaneUrl": "http://cdn.example/studio/latest.json",
		"publicKeyPath":   filepath.Join(tempDir, "release-key.pem"),
		"socketPath":      filepath.Join(tempDir, "updater.sock"),
		"envFile":         filepath.Join(tempDir, ".env"),
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(configPath, data, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadConfig(configPath); err == nil {
		t.Fatal("expected insecure control-plane URL to be rejected")
	}
}
