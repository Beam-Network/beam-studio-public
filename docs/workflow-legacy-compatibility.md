# Workflow Legacy Compatibility

V1 keeps transfer templates as valid user-facing objects while adding workflow
tables as the execution mirror.

| Legacy table | Workflow table | V1 mapping |
| --- | --- | --- |
| `transfer_templates` | `workflow_templates` | One generated workflow template per transfer template, linked by `legacy_transfer_template_id`. |
| `transfer_sources` / `transfer_destinations` | `workflow_runs.template_snapshot_json` | Sources and destinations are copied into the immutable run snapshot before execution. |
| `runs` | `workflow_runs` | Every new run stores `runs.workflow_run_id`; old queued runs are backfilled by the worker before claim execution. |
| `run_transfers` | `workflow_step_runs` | The single `@beam/transfer` step records status, inputs, outputs, state and `external_ref`; legacy transfer rows remain for existing UI surfaces. |
| `execution_logs` | `execution_logs` | V1 mirrors workflow events into the existing log table until workflow-native log views exist. |

## V1 Limits

- Workflow V1 accepts only linear pipelines ordered by step `position`.
- Branches, joins, loops and parallel execution are rejected by the runner.
- Runtime placement is resolved to `local-workers`.
- Only builtin `@beam/*` action packages can execute.
- Remote action installation is intentionally disabled.
