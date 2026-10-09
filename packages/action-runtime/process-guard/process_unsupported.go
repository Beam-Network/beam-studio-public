//go:build !linux && !windows

package main

import "errors"

type processHandle struct{}

var unsupported = errors.New("Durable action process ownership is supported on Linux and Windows only")

func processScope() (string, error)           { return "", unsupported }
func processHostEvidence() (string, string, string, error) {
	return "", "", "", unsupported
}
func openProcess(int) (*processHandle, error) { return nil, unsupported }
func (h *processHandle) identity() identity   { return identity{} }
func (h *processHandle) close()               {}
func (h *processHandle) exited() bool         { return false }
func (h *processHandle) kill() error          { return unsupported }
func lockRecord(string) (func(), error)       { return nil, unsupported }
func syncDirectory(string) error              { return unsupported }
