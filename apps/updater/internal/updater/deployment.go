package updater

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"sort"
)

// Labels a release template sets on its services to tell the updater what to
// verify and back up. The updater knows no service, port or database by name:
// a release describes its own deployment, and Compose resolves the values
// against the instance's environment (published ports, credentials).
const (
	// An HTTP(S) URL, reachable from the host, that must answer 2xx once the
	// release is up. A service may carry at most one; several services may.
	healthURLLabel = "beam.studio.health-url"
	// Marks the service whose database is dumped before an update. The only
	// supported engine is "postgresql", dumped with pg_dump as POSTGRES_USER.
	backupLabel = "beam.studio.backup"
)

type deploymentBackup struct {
	service  string
	user     string
	database string
}

// deployment is what a rendered release declares about itself.
type deployment struct {
	healthURLs []string
	backup     *deploymentBackup
}

type composeConfig struct {
	Services map[string]struct {
		Labels      map[string]string  `json:"labels"`
		Environment map[string]*string `json:"environment"`
	} `json:"services"`
}

func (supervisor *Supervisor) inspectDeployment(
	ctx context.Context,
	composePath string,
) (deployment, error) {
	var output bytes.Buffer
	if err := supervisor.runCompose(ctx, composePath, &output, "config", "--format", "json"); err != nil {
		return deployment{}, fmt.Errorf("read release Compose configuration: %w", err)
	}
	return parseDeployment(output.Bytes())
}

func parseDeployment(data []byte) (deployment, error) {
	var config composeConfig
	if err := json.Unmarshal(data, &config); err != nil {
		return deployment{}, fmt.Errorf("parse release Compose configuration: %w", err)
	}
	names := make([]string, 0, len(config.Services))
	for name := range config.Services {
		names = append(names, name)
	}
	sort.Strings(names)

	var result deployment
	for _, name := range names {
		service := config.Services[name]
		if target, ok := service.Labels[healthURLLabel]; ok {
			parsed, err := url.Parse(target)
			if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
				return deployment{}, fmt.Errorf("service %q has an invalid %s label", name, healthURLLabel)
			}
			result.healthURLs = append(result.healthURLs, target)
		}
		engine, ok := service.Labels[backupLabel]
		if !ok {
			continue
		}
		if engine != "postgresql" {
			return deployment{}, fmt.Errorf("service %q declares unsupported backup engine %q", name, engine)
		}
		if result.backup != nil {
			return deployment{}, fmt.Errorf("services %q and %q both declare a backup", result.backup.service, name)
		}
		// The official image's defaults: the user is postgres, the database the user.
		user := environmentValue(service.Environment, "POSTGRES_USER", "postgres")
		result.backup = &deploymentBackup{
			service:  name,
			user:     user,
			database: environmentValue(service.Environment, "POSTGRES_DB", user),
		}
	}
	return result, nil
}

func environmentValue(environment map[string]*string, name string, fallback string) string {
	if value := environment[name]; value != nil && *value != "" {
		return *value
	}
	return fallback
}

// healthTargets are the URLs to probe after a deployment. Releases published
// before templates declared their own fall back to the configured ones.
func (supervisor *Supervisor) healthTargets(declared deployment) []string {
	if len(declared.healthURLs) > 0 {
		return declared.healthURLs
	}
	return []string{supervisor.config.HealthURL, supervisor.config.StudioHealthURL}
}

// backupTarget is the database to dump before an update, with the same
// fallback for templates that predate the backup label.
func (supervisor *Supervisor) backupTarget(declared deployment) deploymentBackup {
	if declared.backup != nil {
		return *declared.backup
	}
	return deploymentBackup{
		service:  supervisor.config.DatabaseService,
		user:     supervisor.config.DatabaseUser,
		database: supervisor.config.DatabaseName,
	}
}
