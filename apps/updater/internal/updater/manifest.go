package updater

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

const maxControlPlaneBytes = 2 << 20

const supportedDeploymentSchemaVersion = 1

var (
	releaseVersionPattern = regexp.MustCompile(`^v?[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$`)
	imageReferencePattern = regexp.MustCompile(
		`^[a-z0-9.-]+(?::[0-9]+)?/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$`,
	)
	sourceRevisionPattern = regexp.MustCompile(`^[a-f0-9]{40}$`)
)

// A release may carry any set of images; the updater knows none of them by
// name. Each key becomes the template placeholder @IMAGE_<KEY>@.
var imageKeyPattern = regexp.MustCompile(`^[a-z][a-z0-9-]{0,62}$`)

// Registry namespaces a release may pull from, whatever its images are.
var approvedImagePrefixes = []string{
	"ghcr.io/beam-network/beam-studio-",
	"docker.io/library/",
}

type ReleaseManifest struct {
	Sequence                uint64            `json:"sequence"`
	Version                 string            `json:"version"`
	SourceRevision          string            `json:"sourceRevision"`
	PublishedAt             string            `json:"publishedAt"`
	MinimumUpdaterVersion   string            `json:"minimumUpdaterVersion,omitempty"`
	DeploymentSchemaVersion int               `json:"deploymentSchemaVersion"`
	Updater                 string            `json:"updater"`
	Images                  map[string]string `json:"images"`
	ReleaseNotesURL         string            `json:"releaseNotesUrl,omitempty"`
	RollbackSafe            bool              `json:"rollbackSafe"`
	RequiresBackup          bool              `json:"requiresBackup"`
	AllowDowngrade          bool              `json:"allowDowngrade,omitempty"`
	Channel                 string            `json:"-"`
}

type ControlPlane struct {
	SchemaVersion int                        `json:"schemaVersion"`
	GeneratedAt   string                     `json:"generatedAt"`
	Channels      map[string]ReleaseManifest `json:"channels"`
	Signature     string                     `json:"signature"`
}

type ManifestClient struct {
	HTTPClient *http.Client
}

func NewManifestClient() *ManifestClient {
	return &ManifestClient{
		HTTPClient: &http.Client{Timeout: 30 * time.Second},
	}
}

func (client *ManifestClient) FetchAndVerify(
	ctx context.Context,
	manifestURL string,
	publicKeyPath string,
	channel string,
) (ReleaseManifest, error) {
	data, err := client.download(ctx, manifestURL, maxControlPlaneBytes)
	if err != nil {
		return ReleaseManifest{}, fmt.Errorf("download release control plane: %w", err)
	}

	var document ControlPlane
	// Unknown fields are ignored, not refused: the signature already covers them,
	// and a later control plane may add fields this updater has no use for.
	decoder := json.NewDecoder(bytes.NewReader(data))
	if err := decoder.Decode(&document); err != nil {
		return ReleaseManifest{}, fmt.Errorf("parse release control plane: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return ReleaseManifest{}, errors.New("parse release control plane: trailing JSON content")
	}
	if err := validateControlPlane(document); err != nil {
		return ReleaseManifest{}, err
	}

	publicKey, err := readEd25519PublicKey(publicKeyPath)
	if err != nil {
		return ReleaseManifest{}, err
	}
	signature, err := base64.StdEncoding.DecodeString(document.Signature)
	if err != nil {
		return ReleaseManifest{}, errors.New("release control-plane signature is not valid base64")
	}
	canonical, err := canonicalControlPlane(data)
	if err != nil {
		return ReleaseManifest{}, err
	}
	if !ed25519.Verify(publicKey, canonical, signature) {
		return ReleaseManifest{}, errors.New("release control-plane signature verification failed")
	}

	release, ok := document.Channels[channel]
	if !ok {
		return ReleaseManifest{}, fmt.Errorf("release channel %q is not published", channel)
	}
	release.Channel = channel
	return release, nil
}

func (client *ManifestClient) download(
	ctx context.Context,
	rawURL string,
	maxBytes int64,
) ([]byte, error) {
	sourceURL, err := url.Parse(rawURL)
	if err != nil {
		return nil, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Cache-Control", "no-cache")
	request.Header.Set("User-Agent", "beam-studio-updater")

	response, err := client.HTTPClient.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if sourceURL.Scheme == "https" && response.Request.URL.Scheme != "https" {
		return nil, errors.New("release server redirected HTTPS download to an insecure URL")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, fmt.Errorf("release server returned HTTP %d", response.StatusCode)
	}

	reader := io.LimitReader(response.Body, maxBytes+1)
	data, err := io.ReadAll(reader)
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > maxBytes {
		return nil, fmt.Errorf("release control plane exceeds %d bytes", maxBytes)
	}
	return data, nil
}

func validateControlPlane(document ControlPlane) error {
	if document.SchemaVersion != 1 {
		return fmt.Errorf("unsupported release control-plane schema %d", document.SchemaVersion)
	}
	if _, err := time.Parse(time.RFC3339, document.GeneratedAt); err != nil {
		return errors.New("release control-plane generatedAt must be RFC3339")
	}
	if len(document.Channels) == 0 {
		return errors.New("release control plane must publish at least one channel")
	}
	for channel, release := range document.Channels {
		switch channel {
		case "dev", "nightly", "stable":
		default:
			return fmt.Errorf("unsupported release channel %q", channel)
		}
		if err := validateRelease(channel, release); err != nil {
			return err
		}
	}
	if document.Signature == "" {
		return errors.New("release control-plane signature is required")
	}
	return nil
}

func validateRelease(channel string, release ReleaseManifest) error {
	if release.Sequence == 0 {
		return fmt.Errorf("release channel %q sequence must be positive", channel)
	}
	if !releaseVersionPattern.MatchString(release.Version) {
		return fmt.Errorf("release channel %q has invalid version %q", channel, release.Version)
	}
	if !sourceRevisionPattern.MatchString(release.SourceRevision) {
		return fmt.Errorf("release channel %q sourceRevision must be a full lowercase Git commit", channel)
	}
	if _, err := time.Parse(time.RFC3339, release.PublishedAt); err != nil {
		return fmt.Errorf("release channel %q publishedAt must be RFC3339", channel)
	}
	if release.MinimumUpdaterVersion != "" &&
		!releaseVersionPattern.MatchString(release.MinimumUpdaterVersion) {
		return fmt.Errorf("release channel %q has invalid minimumUpdaterVersion", channel)
	}
	if release.DeploymentSchemaVersion <= 0 {
		return fmt.Errorf("release channel %q deploymentSchemaVersion must be positive", channel)
	}
	if err := validateBeamImage("updater", release.Updater); err != nil {
		return fmt.Errorf("release channel %q: %w", channel, err)
	}
	if len(release.Images) == 0 {
		return fmt.Errorf("release channel %q must contain at least one image", channel)
	}
	for _, key := range imageKeys(release) {
		if !imageKeyPattern.MatchString(key) {
			return fmt.Errorf("release channel %q has invalid image key %q", channel, key)
		}
		if err := validateApprovedImage(key, release.Images[key]); err != nil {
			return fmt.Errorf("release channel %q: %w", channel, err)
		}
	}
	return nil
}

// imageKeys lists a release's images in a stable order.
func imageKeys(release ReleaseManifest) []string {
	keys := make([]string, 0, len(release.Images))
	for key := range release.Images {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func validateApprovedImage(key string, reference string) error {
	var err error
	for _, prefix := range approvedImagePrefixes {
		if err = validateImagePrefix(key, reference, prefix); err == nil {
			return nil
		}
	}
	return err
}

func validateBeamImage(key string, reference string) error {
	return validateImagePrefix(
		key,
		reference,
		"ghcr.io/beam-network/beam-studio-",
	)
}

func validateImagePrefix(key string, reference string, prefix string) error {
	if !imageReferencePattern.MatchString(reference) {
		return fmt.Errorf("image %q must be an immutable image@sha256 reference", key)
	}
	if !strings.HasPrefix(reference, prefix) {
		return fmt.Errorf("image %q is outside its approved registry namespace", key)
	}
	return nil
}

func canonicalControlPlane(data []byte) ([]byte, error) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	var document map[string]any
	if err := decoder.Decode(&document); err != nil {
		return nil, fmt.Errorf("canonicalize release control plane: %w", err)
	}
	delete(document, "signature")
	canonical, err := json.Marshal(document)
	if err != nil {
		return nil, fmt.Errorf("canonicalize release control plane: %w", err)
	}
	return canonical, nil
}

func readEd25519PublicKey(path string) (ed25519.PublicKey, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read release public key: %w", err)
	}
	block, _ := pem.Decode(data)
	if block == nil {
		return nil, errors.New("release public key is not PEM encoded")
	}
	parsed, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("parse release public key: %w", err)
	}
	publicKey, ok := parsed.(ed25519.PublicKey)
	if !ok {
		return nil, errors.New("release public key must use Ed25519")
	}
	return publicKey, nil
}

type semanticVersion struct {
	major      int
	minor      int
	patch      int
	prerelease string
}

func compareVersions(left string, right string) (int, error) {
	a, err := parseSemanticVersion(left)
	if err != nil {
		return 0, err
	}
	b, err := parseSemanticVersion(right)
	if err != nil {
		return 0, err
	}
	for _, pair := range [][2]int{{a.major, b.major}, {a.minor, b.minor}, {a.patch, b.patch}} {
		if pair[0] < pair[1] {
			return -1, nil
		}
		if pair[0] > pair[1] {
			return 1, nil
		}
	}
	if a.prerelease == b.prerelease {
		return 0, nil
	}
	if a.prerelease == "" {
		return 1, nil
	}
	if b.prerelease == "" {
		return -1, nil
	}
	return comparePrerelease(a.prerelease, b.prerelease), nil
}

func parseSemanticVersion(value string) (semanticVersion, error) {
	normalized := strings.TrimPrefix(value, "v")
	main, prerelease, _ := strings.Cut(normalized, "-")
	parts := strings.Split(main, ".")
	if len(parts) != 3 {
		return semanticVersion{}, fmt.Errorf("invalid semantic version %q", value)
	}
	numbers := make([]int, 3)
	for index, part := range parts {
		number, err := strconv.Atoi(part)
		if err != nil || number < 0 {
			return semanticVersion{}, fmt.Errorf("invalid semantic version %q", value)
		}
		numbers[index] = number
	}
	return semanticVersion{
		major:      numbers[0],
		minor:      numbers[1],
		patch:      numbers[2],
		prerelease: prerelease,
	}, nil
}

func comparePrerelease(left string, right string) int {
	leftParts := strings.Split(left, ".")
	rightParts := strings.Split(right, ".")
	length := min(len(leftParts), len(rightParts))
	for index := 0; index < length; index++ {
		leftPart := leftParts[index]
		rightPart := rightParts[index]
		if leftPart == rightPart {
			continue
		}
		leftNumber, leftNumeric := numericIdentifier(leftPart)
		rightNumber, rightNumeric := numericIdentifier(rightPart)
		switch {
		case leftNumeric && rightNumeric:
			if leftNumber < rightNumber {
				return -1
			}
			return 1
		case leftNumeric:
			return -1
		case rightNumeric:
			return 1
		default:
			return strings.Compare(leftPart, rightPart)
		}
	}
	switch {
	case len(leftParts) < len(rightParts):
		return -1
	case len(leftParts) > len(rightParts):
		return 1
	default:
		return 0
	}
}

func numericIdentifier(value string) (int, bool) {
	if value == "" {
		return 0, false
	}
	for _, character := range value {
		if character < '0' || character > '9' {
			return 0, false
		}
	}
	number, err := strconv.Atoi(value)
	return number, err == nil
}
