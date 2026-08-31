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

Use `npm run connector-discover -- --input state/notification-connector-discovery/exports/<NCAPEXP-…>.capabilities.json` to preview a strict private capability export produced outside repository code. Preview is network-free and writes nothing. Only exact `--apply --approve NCAP-EXACT-ID` may atomically persist the sanitized catalog; it neither creates a profile nor authorizes delivery. A failure leaves `pending-notification-discovery-*.json`, and exact recovery revalidates the unchanged source hash, catalog, and approval before committing. Repeating a committed catalog is idempotent.

Use `npm run connector-drift -- --catalog <private-catalog> --binding <private-binding>` for a bounded read-only compatibility report. Both files must be regular exact-name artifacts under their configured private directories. The command reads neither raw exports nor profiles, writes nothing, accesses no credential, endpoint, or network, and does not authorize delivery. Keep real reports private. A review-required result is deliberate uncertainty and must not be upgraded to aligned without a hash-bound target.

Use `npm run connector-history -- --before <earlier-private-catalog> --after <later-private-catalog>` for a bounded read-only semantic comparison. Both files must be exact-name regular catalogs in the private discovery directory, belong to the same opaque connection, and be chronologically ordered. The command reads no raw export or profile, writes nothing, accesses no credential, endpoint, or network, and never authorizes delivery. Keep real reports private; unchanged means semantic equality, not identical export identity.

Live notification connectors use a separate two-step authorization. First preview a private version-1 or version-2 profile with `npm run connector-profile -- --profile <private-profile>` and import only its sanitized binding with exact `--apply --approve NCON-EXACT-ID`. This never exports the endpoint, credential environment-variable name/value, or version-2 native target. Version 1 retains adapter-neutral JSON; version 2 may select `adapter_neutral_json_v1` or bounded `slack_blocks_v1` per destination. Then preview an existing outbox request with `npm run notify-send -- --request <private-request> --profile <private-profile>`. Only explicit `--send --approve NAPP-EXACT-ID` may attempt HTTPS delivery. Preview, setup, tests, and preflight never read the credential or use the network, and preview returns no rendered payload.

The live dispatcher enforces exact local and profile destination allowlists, approved renderer and native-target hashes, quiet-hour `not_before`, 1–15 second timeouts, 256 KiB maximum rendered request bodies, 64 KiB maximum responses, at most three attempts, at most ten seconds of deterministic retry delay, redirect rejection, and the stable request ID as `Idempotency-Key`. It records only sanitized receipts. Failures retain `pending-notification-connector-*.json` without targets or rendered content; a confirmed marker writes the receipt without resending, while unconfirmed recovery reuses the same deterministic body and idempotency key after a fresh explicit send approval.

Use `npm run notify-health [-- --stale-after-hours 24]` for a read-only sanitized delivery-health report. The inspector reads at most 1,000 connector outbox requests, sanitized receipts, sanitized provider-status observations, and redacted connector/status recovery markers, with a 256 KiB per-file limit. It rejects links and malformed contracts, reports hashed artifact references, and never loads profiles, endpoints, credential sources or values, request items into the report, candidate artifacts, or response bodies. It writes nothing, performs no network activity or automatic retry, and remains compatible with supported configuration versions 1 through 5 without migration. Recovery-required entries point to `npm run pending`.

Provider-status reconciliation uses its own private version-1 profile and sanitized binding. `npm run status-profile -- --profile <private-status-profile>` is preview-only; exact `--apply --approve NSTATCON-…` imports only the sanitized binding. `npm run notify-status -- --request <private-request> --profile <private-status-profile>` is also preview-only and does not read the credential. A real read-only query requires `--probe --approve NSTAT-…`; it performs exactly one bounded HTTPS attempt with redirects rejected and no automatic retry. A successful strict response is atomically stored as a sanitized observation. A failed or post-response commit retains `pending-notification-status-*.json`; confirmed recovery persists without another network call, while an unknown recovery requires another explicit probe approval. No configuration migration is required.

New `npm run notify-health` reports use schema version 2 and additionally inspect sanitized provider-status observations and redacted status-probe recovery markers within the same 1,000-artifact/256-KiB bounds. The health command itself still never reads a profile or credential, accesses the network, writes state, retries, or sends.

Use `npm run pending` to inspect checksums, age, failure summaries, and guided recovery commands. Inspection is read-only. If extraction is needed, use the exact `--marker` and `--extract` command from the report; extracted material must remain under the private state directory. Never delete a marker merely to silence preflight. A successful replay removes its own marker.

## Adaptive query budgets

`npm run recommend-budgets` reads rolling private run archives and uses attributed role-family metrics only. Insufficient samples produce no recommendation. An eligible recommendation transfers at most one query, preserves the total budget, and never changes thresholds, scoring, resumes, or search terms.

Recommendation output is advisory and has `requires_explicit_approval: true` and `applied: false`. Do not apply it unless the user explicitly approves the exact `recommendation_id`. Then save the recommendation in private state and call:

```sh
npm run apply-budget -- --recommendation state/RECOMMENDATION.json --approve QBUD-EXACT-ID
```

The writer rejects a stale workbook budget, modified recommendation, wrong ID, or changed total. It commits through a verified atomic workbook replacement and preserves a pending marker on failure.
