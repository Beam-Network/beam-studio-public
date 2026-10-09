//go:build !linux

package main

import "errors"

var unsupportedBudget = errors.New("Action CPU and peak-memory budgets require delegated Linux cgroup v2")

func budgetPath(string) (string, error)      { return "", unsupportedBudget }
func launchBudgeted(string) error            { return unsupportedBudget }
func probeBudget() (receipt, error)          { return receipt{}, unsupportedBudget }
func sealBudget(string) (receipt, error)     { return receipt{}, unsupportedBudget }
func cleanupBudget(string) (receipt, error)  { return receipt{}, unsupportedBudget }
func confirmBudgetProcess(string, int) error { return unsupportedBudget }
func cleanupRecordedBudget(string) error     { return unsupportedBudget }
