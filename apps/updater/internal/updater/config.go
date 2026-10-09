package updater

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"time"
)

type Config struct {
	InstanceDir          string `json:"instanceDir"`
	ComposeProject       string `json:"composeProject"`
	ControlPlaneURL      string `json:"controlPlaneUrl"`
	PublicKeyPath        string `json:"publicKeyPath"`
	ComposeTemplatePath  string `json:"composeTemplatePath"`
	Channel              string `json:"channel"`
	SocketPath           string `json:"socketPath"`
	SocketGroup          string `json:"socketGroup,omitempty"`
	EnvFile              string `json:"envFile"`
	HealthURL            string `json:"healthUrl"`
	StudioHealthURL      string `json:"studioHealthUrl"`
	DockerBinary         string `json:"dockerBinary,omitempty"`
	DatabaseService      string `json:"databaseService,omitempty"`
	DatabaseUser         string `json:"databaseUser,omitempty"`
	DatabaseName         string `json:"databaseName,omitempty"`
	BackupEnabled        bool   `json:"backupEnabled"`
	BackupRetention      int    `json:"backupRetention,omitempty"`
	UpdateTimeoutSeconds int    `json:"updateTimeoutSeconds,omitempty"`
	HealthTimeoutSeconds int    `json:"healthTimeoutSeconds,omitempty"`
	AllowInsecureHTTP    bool   `json:"allowInsecureHttp,omitempty"`
}

func LoadConfig(path string) (Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return Config{}, fmt.Errorf("read updater config: %w", err)
	}

	var config Config
	if err := json.Unmarshal(data, &config); err != nil {
		return Config{}, fmt.Errorf("parse updater config: %w", err)
	}
	config.applyDefaults()
	if err := config.Validate(); err != nil {
		return Config{}, err
	}
	return config, nil
}

func (config *Config) applyDefaults() {
	if config.ComposeProject == "" {
		config.ComposeProject = "beam-studio"
	}
	if config.Channel == "" {
		config.Channel = "stable"
	}
	if config.ComposeTemplatePath == "" {
		config.ComposeTemplatePath = "/usr/local/share/beam-studio/compose.release.template.yml"
	}
	if config.SocketPath == "" {
		config.SocketPath = "/run/beam-studio/updater.sock"
	}
	if config.EnvFile == "" && config.InstanceDir != "" {
		config.EnvFile = filepath.Join(config.InstanceDir, ".env")
	}
	if config.HealthURL == "" {
		config.HealthURL = "http://127.0.0.1:8787/health"
	}
	if config.StudioHealthURL == "" {
		config.StudioHealthURL = "http://127.0.0.1:3004/health"
	}
	if config.DockerBinary == "" {
		config.DockerBinary = "docker"
	}
	if config.DatabaseService == "" {
		config.DatabaseService = "postgres"
	}
	if config.DatabaseUser == "" {
		config.DatabaseUser = "beam"
	}
	if config.DatabaseName == "" {
		config.DatabaseName = "beam_studio"
	}
	if config.BackupRetention <= 0 {
		config.BackupRetention = 5
	}
	if config.UpdateTimeoutSeconds <= 0 {
		config.UpdateTimeoutSeconds = 900
	}
	if config.HealthTimeoutSeconds <= 0 {
		config.HealthTimeoutSeconds = 180
	}
}

func (config Config) Validate() error {
	required := map[string]string{
		"instanceDir":         config.InstanceDir,
		"controlPlaneUrl":     config.ControlPlaneURL,
		"publicKeyPath":       config.PublicKeyPath,
		"composeTemplatePath": config.ComposeTemplatePath,
		"socketPath":          config.SocketPath,
		"envFile":             config.EnvFile,
	}
	for name, value := range required {
		if value == "" {
			return fmt.Errorf("updater config %q is required", name)
		}
	}

	for name, path := range map[string]string{
		"instanceDir":         config.InstanceDir,
		"publicKeyPath":       config.PublicKeyPath,
		"composeTemplatePath": config.ComposeTemplatePath,
		"socketPath":          config.SocketPath,
		"envFile":             config.EnvFile,
	} {
		if !filepath.IsAbs(path) {
			return fmt.Errorf("updater config %q must be an absolute path", name)
		}
	}

	controlPlaneURL, err := url.Parse(config.ControlPlaneURL)
	if err != nil || controlPlaneURL.Host == "" {
		return errors.New("updater controlPlaneUrl must be an absolute URL")
	}
	if controlPlaneURL.Scheme != "https" && !config.AllowInsecureHTTP {
		return errors.New("updater controlPlaneUrl must use HTTPS")
	}
	for name, value := range map[string]string{
		"healthUrl":       config.HealthURL,
		"studioHealthUrl": config.StudioHealthURL,
	} {
		healthURL, err := url.Parse(value)
		if err != nil ||
			healthURL.Host == "" ||
			(healthURL.Scheme != "http" && healthURL.Scheme != "https") {
			return fmt.Errorf("updater %s must be an absolute HTTP or HTTPS URL", name)
		}
	}
	if config.UpdateTimeout() < time.Minute {
		return errors.New("updater update timeout must be at least 60 seconds")
	}
	if config.HealthTimeout() < 10*time.Second {
		return errors.New("updater health timeout must be at least 10 seconds")
	}
	return nil
}

func (config Config) UpdateTimeout() time.Duration {
	return time.Duration(config.UpdateTimeoutSeconds) * time.Second
}

func (config Config) HealthTimeout() time.Duration {
	return time.Duration(config.HealthTimeoutSeconds) * time.Second
}

func (config Config) StatePath() string {
	return filepath.Join(config.InstanceDir, "state.json")
}

func (config Config) LockPath() string {
	return filepath.Join(config.InstanceDir, "update.lock")
}

func (config Config) ReleasesDir() string {
	return filepath.Join(config.InstanceDir, "releases")
}

func (config Config) BackupsDir() string {
	return filepath.Join(config.InstanceDir, "backups")
}
