# Run replay and comparison

Every new discovery payload includes `replay_context` containing the exact generated query plan, screening filters, relevant exported configuration, and stable evidence-snapshot identifiers or hashes. The updater stores private immutable input and result archives under the configured `state_directory/runs/` and returns a canonical replay hash.

Use `scripts/replay_run.mjs --input <run.json>` to build a read-only normalized snapshot. Use `scripts/compare_runs.mjs --before-run <id> --after-run <id> --state-dir <state>` or explicit input paths to explain query, filter, configuration, evidence, count, and candidate-decision changes. Replay and comparison never mutate the workbook, rerun web searches, or reinterpret source evidence.
