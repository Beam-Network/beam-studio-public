package updater

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestManifestClientFetchesSelectedSignedChannel(t *testing.T) {
	t.Parallel()
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	keyPath := writeTestPublicKey(t, publicKey)
	document := testControlPlane()
	document.Channels["nightly"] = testRelease("v1.3.0-nightly.1", 8)
	data := signTestControlPlane(t, document, privateKey)

	server := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write(data)
	}))
	defer server.Close()

	client := &ManifestClient{HTTPClient: server.Client()}
	release, err := client.FetchAndVerify(
		context.Background(),
		server.URL+"/latest.json",
		keyPath,
		"nightly",
	)
	if err != nil {
		t.Fatal(err)
	}
	if release.Version != "v1.3.0-nightly.1" || release.Sequence != 8 ||
		release.Channel != "nightly" {
		t.Fatalf("unexpected selected release: %+v", release)
	}
}

func TestManifestClientRejectsTamperedControlPlane(t *testing.T) {
	t.Parallel()
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	keyPath := writeTestPublicKey(t, publicKey)
	document := testControlPlane()
	data := signTestControlPlane(t, document, privateKey)
	var tampered map[string]any
	if err := json.Unmarshal(data, &tampered); err != nil {
		t.Fatal(err)
	}
	channels := tampered["channels"].(map[string]any)
	stable := channels["stable"].(map[string]any)
	stable["version"] = "v9.9.9"
	data, err = json.Marshal(tampered)
	if err != nil {
		t.Fatal(err)
	}

	server := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		_, _ = response.Write(data)
	}))
	defer server.Close()
	client := &ManifestClient{HTTPClient: server.Client()}
	if _, err := client.FetchAndVerify(
		context.Background(), server.URL, keyPath, "stable",
	); err == nil {
		t.Fatal("expected tampered control plane to be rejected")
	}
}

func TestManifestClientRejectsUnsignedControlPlaneFields(t *testing.T) {
	t.Parallel()
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	keyPath := writeTestPublicKey(t, publicKey)
	data := signTestControlPlane(t, testControlPlane(), privateKey)
	var document map[string]any
	if err := json.Unmarshal(data, &document); err != nil {
		t.Fatal(err)
	}
	document["composeUrl"] = "https://example.invalid/untrusted.yml"
	data, err = json.Marshal(document)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		_, _ = response.Write(data)
	}))
	defer server.Close()
	client := &ManifestClient{HTTPClient: server.Client()}
	_, err = client.FetchAndVerify(context.Background(), server.URL, keyPath, "stable")
	if err == nil || !strings.Contains(err.Error(), "signature verification failed") {
		t.Fatalf("expected an unsigned field to break the signature, received %v", err)
	}
}

func TestManifestClientIgnoresSignedFieldsItDoesNotKnow(t *testing.T) {
	t.Parallel()
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	keyPath := writeTestPublicKey(t, publicKey)
	data := signTestControlPlane(t, testControlPlane(), privateKey)
	var document map[string]any
	if err := json.Unmarshal(data, &document); err != nil {
		t.Fatal(err)
	}
	delete(document, "signature")
	channels := document["channels"].(map[string]any)
	channels["stable"].(map[string]any)["addedByALaterRelease"] = true
	document["alsoAddedLater"] = []any{"x"}
	unsigned, err := json.Marshal(document)
	if err != nil {
		t.Fatal(err)
	}
	canonical, err := canonicalControlPlane(unsigned)
	if err != nil {
		t.Fatal(err)
	}
	document["signature"] = base64.StdEncoding.EncodeToString(ed25519.Sign(privateKey, canonical))
	data, err = json.Marshal(document)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		_, _ = response.Write(data)
	}))
	defer server.Close()
	client := &ManifestClient{HTTPClient: server.Client()}
	if _, err := client.FetchAndVerify(context.Background(), server.URL, keyPath, "stable"); err != nil {
		t.Fatalf("expected a signed control plane with newer fields to be accepted: %v", err)
	}
}

func TestControlPlaneRejectsMutableOrUnexpectedImages(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name      string
		key       string
		reference string
	}{
		{"mutable tag", "api", "ghcr.io/beam-network/beam-studio-runtime-api:v1.2.3"},
		{"unapproved namespace", "api", testImage("ghcr.io/other/beam-studio-api", "b")},
		{"wrong database image", "postgres", testImage("ghcr.io/other/postgres", "c")},
		{"invalid key", "API", testImage("ghcr.io/beam-network/beam-studio-runtime-api", "d")},
		{"path-like key", "../api", testImage("ghcr.io/beam-network/beam-studio-runtime-api", "e")},
	}
	for _, testCase := range cases {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()
			release := testRelease("v1.2.3", 1)
			release.Images[testCase.key] = testCase.reference
			if err := validateRelease("stable", release); err == nil {
				t.Fatalf("expected %s to be rejected", testCase.reference)
			}
		})
	}
}

func TestReleasesMayAddAndRemoveImagesWithoutAnUpdaterChange(t *testing.T) {
	t.Parallel()
	release := testRelease("v1.3.0", 2)
	delete(release.Images, "mcp")
	release.Images["cache"] = testImage("docker.io/library/redis", "f")
	release.Images["worker-pool"] = testImage("ghcr.io/beam-network/beam-studio-runtime-worker-pool", "a")
	if err := validateRelease("stable", release); err != nil {
		t.Fatalf("expected a different image set to be valid: %v", err)
	}
	release.Images = map[string]string{}
	if err := validateRelease("stable", release); err == nil {
		t.Fatal("expected a release without images to be rejected")
	}
}

func TestLogicalImageKeysAllowRepositoryRename(t *testing.T) {
	t.Parallel()
	release := testRelease("v1.3.0", 2)
	release.Images["worker"] = testImage(
		"ghcr.io/beam-network/beam-studio-runtime-action-runner",
		"c",
	)
	release.Images["orchestrator"] = testImage(
		"ghcr.io/beam-network/beam-studio-runtime-action-dispatcher",
		"d",
	)
	if err := validateRelease("stable", release); err != nil {
		t.Fatalf("expected renamed repositories to remain valid: %v", err)
	}
}

func TestCompareVersions(t *testing.T) {
	t.Parallel()
	cases := []struct {
		left     string
		right    string
		expected int
	}{
		{"1.0.0", "1.0.0", 0},
		{"v1.2.0", "1.1.9", 1},
		{"1.2.0-beta.1", "1.2.0", -1},
		{"1.2.0-beta.2", "1.2.0-beta.10", -1},
		{"2.0.0", "10.0.0", -1},
	}
	for _, testCase := range cases {
		actual, err := compareVersions(testCase.left, testCase.right)
		if err != nil {
			t.Fatal(err)
		}
		if actual != testCase.expected {
			t.Fatalf(
				"compareVersions(%q, %q) = %d, expected %d",
				testCase.left,
				testCase.right,
				actual,
				testCase.expected,
			)
		}
	}
}

func TestJavaScriptControlPlaneGeneratorMatchesGoVerifier(t *testing.T) {
	t.Parallel()
	nodePath, err := exec.LookPath("node")
	if err != nil {
		t.Skip("Node.js is not available")
	}
	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	privateKeyDER, err := x509.MarshalPKCS8PrivateKey(privateKey)
	if err != nil {
		t.Fatal(err)
	}
	tempDir := t.TempDir()
	privateKeyPath := filepath.Join(tempDir, "private.pem")
	privateKeyPEM := pem.EncodeToMemory(&pem.Block{
		Type:  "PRIVATE KEY",
		Bytes: privateKeyDER,
	})
	if err := os.WriteFile(privateKeyPath, privateKeyPEM, 0600); err != nil {
		t.Fatal(err)
	}
	repositoryRoot, err := filepath.Abs(filepath.Join("..", "..", "..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	scriptPath := filepath.Join(repositoryRoot, "scripts", "create-studio-release.mjs")
	outputDir := filepath.Join(tempDir, "release")
	arguments := []string{
		scriptPath,
		"--version", "2.3.4",
		"--sequence", "12",
		"--source-revision", strings.Repeat("a", 40),
		"--private-key", privateKeyPath,
		"--output-dir", outputDir,
		"--install-template", filepath.Join(repositoryRoot, "scripts", "install-beam-studio.sh"),
		"--updater-image", testImage("ghcr.io/beam-network/beam-studio-runtime-updater", "f"),
	}
	for key, reference := range testImages() {
		arguments = append(arguments, "--image-"+key, reference)
	}
	// The generator requires every image of the release template.
	arguments = append(arguments, "--image-room-consumer",
		testImage("ghcr.io/beam-network/beam-studio-runtime-runtime-room-consumer", "8"))
	command := exec.Command(nodePath, arguments...)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("release generator failed: %v\n%s", err, output)
	}

	controlPlanePath := filepath.Join(outputDir, "latest.json")
	data, err := os.ReadFile(controlPlanePath)
	if err != nil {
		t.Fatal(err)
	}
	canonical, err := canonicalControlPlane(data)
	if err != nil {
		t.Fatal(err)
	}
	jqPath, err := exec.LookPath("jq")
	if err == nil {
		jqCanonical, commandErr := exec.Command(
			jqPath,
			"-cSj",
			"del(.signature)",
			controlPlanePath,
		).CombinedOutput()
		if commandErr != nil {
			t.Fatalf("jq canonicalization failed: %v\n%s", commandErr, jqCanonical)
		}
		if !bytes.Equal(jqCanonical, canonical) {
			t.Fatalf("installer jq canonicalization differs from signed payload\n%s\n%s", jqCanonical, canonical)
		}
	}
	var document ControlPlane
	if err := json.Unmarshal(data, &document); err != nil {
		t.Fatal(err)
	}
	signature, err := base64.StdEncoding.DecodeString(document.Signature)
	if err != nil {
		t.Fatal(err)
	}
	publicKey, err := readEd25519PublicKey(
		filepath.Join(outputDir, "beam-studio-release-key.pem"),
	)
	if err != nil {
		t.Fatal(err)
	}
	if !ed25519.Verify(publicKey, canonical, signature) {
		t.Fatal("Go verifier rejected the JavaScript-generated control-plane signature")
	}
	installer, err := os.ReadFile(filepath.Join(outputDir, "install.sh"))
	if err != nil {
		t.Fatal(err)
	}
	const keyPrefix = `PUBLIC_KEY_BASE64="${BEAM_STUDIO_RELEASE_PUBLIC_KEY_BASE64:-`
	var embeddedKey string
	for _, line := range strings.Split(string(installer), "\n") {
		if strings.HasPrefix(line, keyPrefix) && strings.HasSuffix(line, `}"`) {
			embeddedKey = strings.TrimSuffix(strings.TrimPrefix(line, keyPrefix), `}"`)
			break
		}
	}
	decodedKey, err := base64.StdEncoding.DecodeString(embeddedKey)
	if err != nil || embeddedKey == "" {
		t.Fatalf("rendered installer does not contain a valid embedded public key: %v", err)
	}
	publishedKey, err := os.ReadFile(filepath.Join(outputDir, "beam-studio-release-key.pem"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(decodedKey, publishedKey) {
		t.Fatal("rendered installer public key differs from the signing public key")
	}
	stable := document.Channels["stable"]
	if stable.Sequence != 12 || stable.Images["worker"] != testImages()["worker"] {
		t.Fatalf("unexpected generated stable release: %+v", stable)
	}
}

func testControlPlane() ControlPlane {
	return ControlPlane{
		SchemaVersion: 1,
		GeneratedAt:   time.Now().UTC().Format(time.RFC3339),
		Channels: map[string]ReleaseManifest{
			"stable": testRelease("v1.2.3", 7),
		},
	}
}

func testRelease(version string, sequence uint64) ReleaseManifest {
	return ReleaseManifest{
		Sequence:                sequence,
		Version:                 version,
		SourceRevision:          strings.Repeat("a", 40),
		PublishedAt:             time.Now().UTC().Format(time.RFC3339),
		MinimumUpdaterVersion:   "v1.0.0",
		DeploymentSchemaVersion: 1,
		Updater: testImage(
			"ghcr.io/beam-network/beam-studio-runtime-updater",
			"f",
		),
		Images:         testImages(),
		RollbackSafe:   true,
		RequiresBackup: true,
	}
}

func testImages() map[string]string {
	return map[string]string{
		"api":          testImage("ghcr.io/beam-network/beam-studio-runtime-api", "1"),
		"mcp":          testImage("ghcr.io/beam-network/beam-studio-runtime-mcp", "2"),
		"nats":         testImage("docker.io/library/nats", "3"),
		"orchestrator": testImage("ghcr.io/beam-network/beam-studio-runtime-orchestrator", "4"),
		"postgres":     testImage("docker.io/library/postgres", "5"),
		"studio":       testImage("ghcr.io/beam-network/beam-studio-runtime-studio", "6"),
		"worker":       testImage("ghcr.io/beam-network/beam-studio-runtime-worker", "7"),
	}
}

func testImage(repository string, character string) string {
	return repository + "@sha256:" + strings.Repeat(character, 64)
}

func signTestControlPlane(
	t *testing.T,
	document ControlPlane,
	privateKey ed25519.PrivateKey,
) []byte {
	t.Helper()
	document.Signature = ""
	unsigned, err := json.Marshal(document)
	if err != nil {
		t.Fatal(err)
	}
	canonical, err := canonicalControlPlane(unsigned)
	if err != nil {
		t.Fatal(err)
	}
	document.Signature = base64.StdEncoding.EncodeToString(
		ed25519.Sign(privateKey, canonical),
	)
	data, err := json.Marshal(document)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func writeTestPublicKey(t *testing.T, publicKey ed25519.PublicKey) string {
	t.Helper()
	encoded, err := x509.MarshalPKIXPublicKey(publicKey)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "release-key.pem")
	data := pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: encoded})
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	return path
}
