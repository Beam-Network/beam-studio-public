package updater

import "testing"

// Development versions are built by .github/workflows/release-studio.yml as
// v0.0.0-dev.r<zero-padded run number>.<commit>; they must sort by run number,
// including after the earlier hash-only versions.
func TestDevVersionsSortByRunNumber(t *testing.T) {
	t.Parallel()
	cases := [][2]string{
		{"v0.0.0-dev.aa8028f60cb2", "v0.0.0-dev.r0000000197.59813c361b9d"},
		{"v0.0.0-dev.r0000000197.ffffffffffff", "v0.0.0-dev.r0000000198.000000000000"},
		{"v0.0.0-dev.r0000000999.aaaaaaaaaaaa", "v0.0.0-dev.r0000001000.111111111111"},
	}
	for _, c := range cases {
		if got, err := compareVersions(c[0], c[1]); err != nil || got != -1 {
			t.Fatalf("%s should sort before %s: %d %v", c[0], c[1], got, err)
		}
	}
}
