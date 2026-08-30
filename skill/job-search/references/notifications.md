# Notification digests

Notifications are optional and disabled by default. Read only updater-returned `alerts` from `state/last-run.json` or a private archived `*.result.json`; never build a delivery from finder packets, raw discovery inputs, candidate profiles, email bodies, or workbook rows.

Run `npm run notify [-- --input <private-result.json>]` first. Preview writes nothing and returns the version-1 digest, destination requests, classifications, quiet-hour deferrals, and exact `NAPP-…` approval ID. Do not add `--apply` unless the user explicitly approves that exact ID. Apply creates only idempotent private files under the configured state directory and never changes the workbook.

The digest is bounded and privacy-minimized. It may contain alert-backed job metadata and, only when configured for that destination, the selected resume label. It must not contain candidate identity, profile evidence, resume files or paths, raw run payloads, Gmail content, recipient addresses, connector endpoints, credentials, or private filesystem paths.

`private_file` destinations create a local request. `connector` destinations create an outbox request with an opaque connection reference and deterministic `not_before`; repository code does not invoke a connector or perform an external send. Any future connector must use `scripts/notification_connector_contract.mjs`, require the same exact approval ID, honor `not_before`, and return without sending when deferred. Never reinterpret a notification destination as permission to submit an application, update a job, or contact a recruiter.

If apply fails, preserve the redacted `pending-notification-*.json` marker. Use `npm run pending` and only its exact recovery command. Repeating an applied digest is idempotent.
