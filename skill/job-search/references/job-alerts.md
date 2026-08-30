# Gmail job-alert ingestion

Gmail ingestion is optional, disabled by default, and read-only. Do not access a mailbox unless local config version 5 has `gmail_job_alerts.enabled: true`, the sender allowlist is non-empty, and the user has supplied a private batch or an available authorized connector. Never request, fabricate, print, log, or store credentials. A live connector may use only `https://www.googleapis.com/auth/gmail.readonly` and the message list/get operations; never send, delete, modify, label, archive, trash, or otherwise change mail.

All sources enter through `schemas/job-alert-batch.v1.schema.json`. Synthetic fixtures and normalized live connector results must follow the same deterministic path. Enforce the configured Gmail query, freshness hours, maximum messages, maximum links per message, and exact sender/domain allowlist. Do not silently increase a limit.

Preview with `npm run ingest-alerts -- --input <private-batch.json>`. Preview is read-only and prints only the sanitized proposal. Use `--apply` only when persistent private proposal state is explicitly intended. Apply is atomic, idempotent, and recoverable; it never touches the workbook.

The importer extracts URLs and labeled job metadata from plain text and HTML, unwraps common redirect parameters, calls the existing canonical-source normalizer, and reconciles identity keys inside the batch and against current tracker leads. It classifies every non-proposed item with one explicit versioned code. Do not reinterpret a classification from private body text after import.

Sanitized provenance is limited to batch ID, hashed message reference, receipt timestamp, and link index. Never copy message bodies, subjects, From headers, transport IDs, raw tracking URLs, or non-job private content into proposals, agent prompts, tracker raw JSON, run archives, diagnostics, logs, or public files. If a seed includes metadata containing an address or local path, retain only the redacted job metadata.

A proposal is upstream of discovery, not an updater payload. For each candidate, publicly verify that the canonical vacancy is active, collect the complete job description and evidence, determine listing and eligibility status from current evidence, compute the normal preliminary packet, and then blind `job_judge`. Expired or inaccessible public listings become normal source-backed scan events. Only judged or failed-judge packets may enter the discovery run, and only `scripts/update_tracker.mjs` may update the workbook.

If live Gmail connector access is unavailable, stop at the sanitized private batch boundary. Do not weaken authentication, use browser secrets, reuse an unrelated authenticated session, or claim that live mailbox ingestion occurred.
