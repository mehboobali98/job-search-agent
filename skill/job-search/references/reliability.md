# Reliability and adaptive guidance

## Preflight

Run `node scripts/preflight.mjs` before discovery when local configuration has `reliability.require_preflight: true`. A failed check blocks discovery. Warnings do not block, but report them and resolve pending recovery markers before another workbook write. The report is intentionally compact and never includes candidate-profile, resume, sender, query, or email-body content.

Older local config versions remain readable. `npm run upgrade-config` is preview-only. Apply only after the user requests it with `npm run upgrade-config -- --apply`; the script writes a private backup, initializes missing generic support files and directories without overwriting existing data, and then atomically replaces the config.

Config version 5 adds `gmail_job_alerts`, disabled by default with `read_only: true`, a bounded query and freshness window, message/link limits, and an empty sender allowlist. Setup and tests never require Gmail credentials. Enabling requires at least one exact sender address or domain. Never store credentials in local configuration.

Config version 6 adds `notifications`, disabled by default with a bounded digest, quiet hours, and at most ten destinations. Enabling requires an enabled destination. Connector destinations store only a non-secret opaque reference; never store an address, endpoint URL, or credential. Versions 1 through 5 remain readable.

## Dry-run and pending recovery

Use `npm run dry-run -- --input <run.json>` to validate a discovery payload on an isolated workbook copy. The command must report `workbook_unchanged: true` and never writes project state.

Use `npm run ingest-alerts -- --input <private-batch.json>` for a read-only sanitized preview. Only `--apply` may persist the proposal under private state. It never writes the workbook. A failed proposal promotion leaves a sanitized `pending-job-alert-*.json` marker; use the exact recovery command returned by `npm run pending`. Repeating the same batch is idempotent.

Use `npm run import-history -- --source <private.xlsx> [--mapping <private-mapping.json>]` for a privacy-safe historical-import preview. It never modifies the source or tracker. Only explicit `--apply` may append missing legacy history through a verified atomic tracker replacement. A failure leaves `pending-history-import-*.json`; recovery verifies that both source and target still match the failed attempt before replaying. Repeating a committed import is idempotent.

Use `npm run notify [-- --input <private-result.json>]` to preview a version-1 digest and delivery plan from updater-returned alerts. Preview writes nothing. Only `--apply --approve NAPP-EXACT-ID` may atomically create private local or connector-outbox requests; no connector is invoked. A failure leaves `pending-notification-*.json` with redacted diagnostics and exact replay inputs. Repeating an approved request is idempotent.

Use `npm run pending` to inspect checksums, age, failure summaries, and guided recovery commands. Inspection is read-only. If extraction is needed, use the exact `--marker` and `--extract` command from the report; extracted material must remain under the private state directory. Never delete a marker merely to silence preflight. A successful replay removes its own marker.

## Adaptive query budgets

`npm run recommend-budgets` reads rolling private run archives and uses attributed role-family metrics only. Insufficient samples produce no recommendation. An eligible recommendation transfers at most one query, preserves the total budget, and never changes thresholds, scoring, resumes, or search terms.

Recommendation output is advisory and has `requires_explicit_approval: true` and `applied: false`. Do not apply it unless the user explicitly approves the exact `recommendation_id`. Then save the recommendation in private state and call:

```sh
npm run apply-budget -- --recommendation state/RECOMMENDATION.json --approve QBUD-EXACT-ID
```

The writer rejects a stale workbook budget, modified recommendation, wrong ID, or changed total. It commits through a verified atomic workbook replacement and preserves a pending marker on failure.
