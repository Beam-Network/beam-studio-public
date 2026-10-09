# Runbook: blocked actions

Alert: `BeamActionBlocked`.

1. Identify whether the bounded reason is `permission`, `configuration`, `trust`, or `sandbox`.
2. Find the affected run through the product event journal, then correlate logs and traces with its `workflowRunId`.
3. For permission/configuration failures, compare the action manifest requirements with worker allowlists and the saved workflow snapshot.
4. For trust/checksum failures, verify the Registry lock, checksum, provenance, and installed version. Do not bypass verification.
5. For sandbox failures, inspect timeout/memory/scratch limits and the sandbox termination reason. Do not run the action outside the sandbox as a workaround.
6. Apply the smallest configuration or package correction and retry through normal product controls.
