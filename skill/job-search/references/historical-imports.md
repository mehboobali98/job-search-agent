# Historical tracker import

Historical import reads a private `.xlsx` source and never modifies it. Use `scripts/import_tracker_history.mjs` only as the orchestrator. Preview is the default; never add `--apply` unless the user explicitly intends to persist missing legacy history in the configured tracker.

Compatible Job Search Agent workbooks with `LeadsTable` or `ApplicationsTable` map automatically. Other layouts require a version-1 mapping matching `schemas/historical-tracker-import.v1.schema.json`. Keep real source workbooks and mappings under the ignored state directory. Do not infer ambiguous headers or silently map two fields to one source column.

The importer enforces the file, sheet, row, column, text, URL, score, date, status, stage, and resume limits. It normalizes URLs and computes all identity keys through the existing tracker library. Exact source duplicates are ignored. Conflicting source rows and identities matching multiple current tracker rows are quarantined. Never choose a conflict winner automatically.

The current tracker is authoritative. Never overwrite existing lead or application fields, regress a current stage, or infer a resume, score, eligibility decision, application outcome, or submission event from missing history. A missing historical application may link to an existing lead. A completely new record may add a `Legacy / unjudged` lead and application with low-confidence/unverified defaults, but it cannot alert.

Preview output is limited to hashes, counts, classifications, policy flags, and target lead IDs. It omits source notes, companies, titles, raw rows, workbook paths, and mapping contents. Apply performs a formula scan, exports a distinct temporary workbook, verifies the full tracker contract and every planned row, then atomically replaces the target. Repeating the same import is idempotent.

If apply fails before promotion, the live tracker must remain byte-for-byte unchanged and `pending-history-import-*.json` must retain the exact private paths and hashes. Use `npm run pending` and run only its exact `--recover ... --apply` command. Recovery must stop if either source or target changed after the failed attempt.
