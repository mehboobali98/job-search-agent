# Multi-Agent Job Search Agent

A reusable Codex workflow that discovers jobs with two parallel finders, optionally ingests read-only Gmail job alerts, independently judges candidate fit, prepares privacy-minimized notification digests, monitors shortlisted roles, prepares claim-safe application guidance, tracks confirmed outcomes, and safely updates a local Excel tracker. It never submits applications or sends outreach.

## How it works

- `backend_finder` searches backend/platform and staff/leadership roles.
- `ai_product_finder` searches applied AI, developer productivity, and selective product roles.
- `gmail_alert_finder` represents sanitized, opt-in inbox alert seeds after the private batch importer has removed message bodies and direct message identifiers.
- `application_form_agent` reads the current prepared application-form step and drafts responses without typing or submitting.
- `change_monitor` rechecks shortlisted and prepared canonical listings for material changes without writing to the tracker.
- `tailoring_agent` maps canonical job requirements and ATS keywords to stable candidate evidence without editing resumes.
- `job_judge` scores canonical listings without finder anchoring, runs blind synthetic calibration fixtures, and separately audits form responses and tailoring reports against candidate evidence.
- The orchestrator is the only writer. Deterministic scripts validate and atomically update the workbook.

Each clone is configured for one person. Their name, profile, resumes, workbook, and run history stay in Git-ignored local files.

## Requirements

- Codex desktop with subagents and public web access
- Node.js 20 or newer
- Codex workspace dependencies available as `node_modules` (Codex provides `@oai/artifact-tool`)

## Set up a new candidate

```sh
npm run setup -- --name "Candidate Name" --timezone "Etc/UTC" --geography "Worldwide remote"
npm run install-skill
npm run preflight
```

Setup creates these private, ignored artifacts:

- `.job-search.local.json` — local paths, timezone, and target geography
- `profile/candidate-profile.md` — verified candidate evidence
- `profile/resumes/` — resume files
- `Job_Application_Tracker.xlsx` — the twelve-sheet tracker
- `profile/search-terms.json` — private role titles, skills, exclusions, locations, and LinkedIn query settings
- `profile/eligibility-evidence.json` — private, cited, expiring eligibility-policy evidence and human overrides
- `state/` — run payloads, deterministic replay archives, and updater state
- `application-packages/` — private tailoring reports, form-response packets, and required cover-letter files

Complete the candidate profile, add resume files, and then tell Codex: `Run $job-search now`.

Before the first run, edit `profile/search-terms.json` so each role family uses the candidate's actual titles and technologies. Keep terms atomic; the query builder adds LinkedIn-supported Boolean operators and quoting.

Priority markets belong in `linkedin_public.priority_market_locations`, with country-level LinkedIn locations and optional city aliases for canonical ATS discovery. `company_watchlists` defines bounded, public company directories that can replace one normal query on a configured weekday. Use `npm run queries -- --run-date 2026-08-28T08:00:00+05:00` to preview a specific scheduled day without running discovery.

## Reliability checks and recovery

`npm run preflight` returns one machine-readable report for the Node runtime, bundled workbook dependency, local config version, twelve-sheet tracker contract, stable candidate evidence, five-variant PDF/DOCX resume inventory, search terms, eligibility registry, writable private directories, and pending recovery markers. Failed checks block discovery; warnings remain visible.

Local config version 6 adds disabled-by-default notification preferences while versions 1 through 5 remain readable. Version 5 introduced the disabled-by-default Gmail job-alert block. `npm run upgrade-config` previews every change without writing. Apply only with `npm run upgrade-config -- --apply`; the upgrader saves the prior config under the ignored state directory, initializes missing generic support files and private directories without overwriting anything, then atomically replaces the config.

`npm run dry-run -- --input state/RUN.json` validates a proposed discovery payload against an isolated workbook copy and verifies that the live workbook hash is unchanged. If a writer previously failed, `npm run pending` reports its marker checksum, age, failure summary, and exact recovery steps without deleting it. Extraction for replay is explicit and remains inside the private state directory.

## Opt-in Gmail job-alert ingestion

Gmail ingestion is off by default and requires no credentials for setup, upgrades, or tests. Config version 5 adds `gmail_job_alerts` with `enabled: false`, `read_only: true`, a bounded Gmail query, a 168-hour freshness window, a 50-message cap, a 20-link-per-message cap, and an empty sender allowlist. Enable it only after adding exact sender addresses or domains to the private `.job-search.local.json`. The validator rejects an enabled configuration without an allowlist, values outside the caps, unknown fields, and any attempt to set `read_only` to false.

The versioned transport-neutral input is documented by `schemas/job-alert-batch.v1.schema.json`. Keep real batches under the ignored `state/` directory and preview them first:

```sh
npm run ingest-alerts -- --input state/job-alert-imports/private-batch.json
npm run ingest-alerts -- --input state/job-alert-imports/private-batch.json --apply
```

Preview is the default and writes nothing. `--apply` atomically stores only the sanitized proposal under `state/job-alert-ingestion/`; it does not touch the workbook. A failed promotion leaves a sanitized pending marker recoverable through `npm run pending`. Running the same batch again is idempotent.

The importer extracts HTTPS job links and labeled company, role, location, work-type, and posted-date metadata from plain text and HTML. It unwraps common tracking redirects, applies the existing canonical-source normalization, reconciles identities within the batch and against `Leads`, and explicitly classifies malformed messages, disallowed senders, stale messages, extraction failures, unsupported links, batch duplicates, tracker duplicates, expired notices, and configured-limit overflow.

Sanitized provenance retains only the batch ID, received timestamp, link index, and a one-way message reference. Subjects, sender addresses, transport message IDs, raw tracking URLs, and full text/HTML bodies are never copied into proposals, the tracker, run archives, diagnostics, or logs. Accepted seeds still require a live public vacancy check and the existing blind judge. The only tracker write remains `scripts/update_tracker.mjs`.

This release defines the Gmail connector boundary with the single `gmail.readonly` scope and permits only message list/get operations. It does not invent credentials or provide a live mailbox authentication adapter when no Gmail connector is available; normalized connector records and synthetic fixtures enter through the same batch contract.

## Historical tracker import

Historical `.xlsx` files stay private and are opened read-only. A compatible Job Search Agent tracker with `LeadsTable` or `ApplicationsTable` is mapped automatically; other workbooks use the strict version-1 mapping in `schemas/historical-tracker-import.v1.schema.json`. Copy `templates/historical-tracker-import.mapping.example.json` into the ignored `state/` directory and replace only the sheet and header names.

Preview is the default and prints hashed row references, classifications, counts, and policy flags without source notes, company names, job titles, or raw rows:

```sh
npm run import-history -- --source state/tracker-imports/old-tracker.xlsx
npm run import-history -- --source state/tracker-imports/old-tracker.xlsx --mapping state/tracker-imports/mapping.json
```

The importer accepts at most 50 MB, 20 mapped sheets, 10,000 rows, and 100 used columns. It normalizes URLs through the existing tracker identity logic, groups duplicates inside the source, and reconciles them against both current leads and applications. Exact duplicates are ignored. Conflicting source identities and matches to multiple current rows are quarantined instead of choosing a winner.

The current tracker is always authoritative: historical import never overwrites an existing lead or application, never regresses an application stage, and never invents a resume, score, eligibility decision, or application event. New historical records are marked `Legacy / unjudged`, default to low confidence and unverified eligibility when those values are absent, retain only bounded mapped fields, and carry a hashed/auditable source-row reference.

Apply only after reviewing the preview:

```sh
npm run import-history -- --source state/tracker-imports/old-tracker.xlsx --mapping state/tracker-imports/mapping.json --apply
```

Apply writes one verified atomic replacement of the configured tracker and one import row in `Run Log`. Repeating the same import is idempotent. A failed promotion leaves `pending-history-import-*.json`; `npm run pending` returns the exact hash-checked recovery command. The source workbook is never changed.

## Notification digests and destinations

Notifications are disabled by default and require no connector credentials for setup, upgrades, previews, or tests. Config version 6 adds a global 1–20 item digest cap, bounded quiet hours, and at most ten destinations. Each destination has an opaque ID, enabled flag, `private_file` or `connector` adapter, channel, minimum score, 1–20 item cap, and an explicit choice about including the selected resume name. Connector destinations use only a non-secret opaque `connection_ref`; raw addresses, endpoint URLs, and credentials do not belong in configuration.

The digest and outbox contracts are `schemas/job-digest.v1.schema.json` and `schemas/notification-delivery-request.v1.schema.json`. The command consumes only an archived updater result, never a candidate profile, raw discovery payload, email body, or workbook. Preview the latest result, or choose an archived run explicitly:

```sh
npm run notify
npm run notify -- --input state/runs/RUN-ID.result.json
```

Preview writes nothing and displays the deterministic `NAPP-…` approval ID, privacy-minimized digest, destination plan, filters, and quiet-hour deferrals. To enable local private-file delivery, first upgrade and edit the ignored `.job-search.local.json`:

```json
{
  "notifications": {
    "enabled": true,
    "max_items_per_digest": 10,
    "quiet_hours": { "enabled": true, "start": "22:00", "end": "08:00" },
    "destinations": [
      {
        "id": "local-review",
        "enabled": true,
        "adapter": "private_file",
        "channel": "local",
        "minimum_score": 80,
        "max_items": 10,
        "include_resume": false
      }
    ]
  }
}
```

After reviewing the exact preview, apply with its approval ID:

```sh
npm run notify -- --input state/runs/RUN-ID.result.json --apply --approve NAPP-EXACT-ID
```

Apply atomically creates idempotent private requests under `state/notifications/`. A `private_file` request is available locally; a `connector` request is queued in the private outbox with a deterministic `not_before` timestamp. This command never invokes a connector or performs an external send. Failed promotion leaves a redacted `pending-notification-*.json` marker with an exact recovery command from `npm run pending`.

Digest content is limited to alert-backed job metadata: lead ID, company, role, score, canonical public URL, location, eligibility, one strength, one risk, posting date, and optionally the selected resume label. It excludes candidate identity, profile evidence, resume files or paths, credentials, raw run payloads, email data, and private filesystem paths. Notification delivery never updates the tracker, submits an application, or contacts a recruiter.

### Authenticated live connector boundary

Live delivery remains separately disabled even after an outbox request exists. Local config stays at version 6; no connector endpoint or credential reference is added to `.job-search.local.json`. Instead, create a private profile under `state/notification-connectors/<profile_id>.profile.json` using `schemas/notification-connector-profile.v1.schema.json` and values supplied by the real connector account. Do not invent or copy an endpoint or account identifier from documentation. The profile supports one bounded transport: HTTPS JSON with a bearer value read from a named process environment variable only at send time.

The private profile must explicitly set its enabled flag, opaque connection reference, query-free HTTPS endpoint, exact destination/channel allowlist, 1–15 second timeout, request limit up to 256 KiB, response limit up to 64 KiB, one to three attempts, non-decreasing deterministic retry delays totaling at most ten seconds, and mandatory `Idempotency-Key` support. Redirects are rejected. Credential values never belong in the profile, repository config, tracker, fixtures, diagnostics, logs, bindings, receipts, or recovery markers.

Preview and import only the sanitized binding:

```sh
npm run connector-profile -- --profile state/notification-connectors/<profile_id>.profile.json
npm run connector-profile -- --profile state/notification-connectors/<profile_id>.profile.json --apply --approve NCON-EXACT-ID
```

Preview exports a deterministic binding and exact `NCON-…` approval without writing or reading the credential. Apply stores only the binding under `state/notifications/connectors/`; it contains hashes, opaque references, allowlists, and limits, but no endpoint or environment-variable name. Changing any private profile field requires a new binding approval.

Then preview an existing connector-outbox request. Preview performs no credential lookup and no network call:

```sh
npm run notify-send -- --request state/notifications/outbox/NREQ-….request.json --profile state/notification-connectors/<profile_id>.profile.json
```

A real attempt is possible only after separately reviewing that preview and supplying both the explicit send flag and the request's unchanged notification approval:

```sh
npm run notify-send -- --request state/notifications/outbox/NREQ-….request.json --profile state/notification-connectors/<profile_id>.profile.json --send --approve NAPP-EXACT-ID
```

Before reading the environment credential, the dispatcher revalidates the adapter-neutral request, approved profile hash, matching enabled local destination, private-profile allowlist, quiet-hour `not_before`, body size, and exact approval. Every retry uses the same request ID as its idempotency key. Successful delivery writes a sanitized receipt; repeating it returns that receipt without network activity. A failure leaves `pending-notification-connector-*.json`; `npm run pending` provides the exact private recovery command. If delivery was confirmed but receipt persistence failed, recovery writes the receipt without resending. For an unconfirmed attempt, recovery reuses the same key, so effective duplicate prevention still depends on the external endpoint honoring `Idempotency-Key`.

No live connector or account was used to develop or test this boundary. Setup, upgrades, tests, previews, and preflight never send and never require connector credentials. Provider-specific OAuth refresh, account discovery, and delivery-format adapters remain outside this bounded slice.

### Authenticated provider-status reconciliation

Provider status uses a separate private profile and cannot send a notification. Keep a version-1 profile under `state/notification-status-connectors/<profile_id>.status-profile.json` using `schemas/notification-connector-status-profile.v1.schema.json`. It is disabled by default and contains a query-free HTTPS status endpoint, bearer environment-variable name, exact destination allowlist, 1–15 second timeout, request limit up to 16 KiB, and response limit up to 64 KiB. Credential values remain only in the process environment.

Preview and import only the sanitized status binding:

```sh
npm run status-profile -- --profile state/notification-status-connectors/<profile_id>.status-profile.json
npm run status-profile -- --profile state/notification-status-connectors/<profile_id>.status-profile.json --apply --approve NSTATCON-EXACT-ID
```

The imported version-1 binding contains hashes, opaque references, the allowlist, and limits, but no endpoint or credential environment-variable name. Changing any status-profile field changes the exact approval.

Then preview an existing connector outbox request. Preview does not read the credential, access the network, or write state:

```sh
npm run notify-status -- --request state/notifications/outbox/NREQ-….request.json --profile state/notification-status-connectors/<profile_id>.status-profile.json
```

A real read-only provider query requires a separately reviewed exact `NSTAT-…` approval and the explicit probe flag:

```sh
npm run notify-status -- --request state/notifications/outbox/NREQ-….request.json --profile state/notification-status-connectors/<profile_id>.status-profile.json --probe --approve NSTAT-EXACT-ID
```

The probe revalidates the unchanged outbox request, approved binding, profile hash, connection reference, and destination/channel allowlist before reading the environment credential. It performs exactly one HTTPS POST, rejects redirects, enforces the configured timeout and byte limits, and never retries automatically. The request body contains only the operation, opaque request ID, and request hash. The response must match the strict version-1 `{ schema_version, request_id, delivery_status, observed_at }` contract, where status is `delivered`, `rejected`, `pending`, or `unknown`.

Successful probes atomically append only the sanitized observation defined by `schemas/notification-connector-status-observation.v1.schema.json`. It excludes endpoints, credential details, response bodies, request items, and candidate artifacts. A failed probe or post-response persistence failure leaves `pending-notification-status-*.json`; `npm run pending` provides the exact recovery command. Confirmed recovery writes the observation without another network request. Unknown recovery performs no automatic retry and still requires explicit `--probe` plus the unchanged exact approval.

No live provider account or status endpoint was used during implementation or validation. The boundary is connector-neutral and expects a private adapter endpoint that implements the strict response contract; provider-native APIs, OAuth refresh, and account discovery remain future work.

### Read-only delivery health

Inspect connector delivery state without loading a connector profile or credential and without making a network request:

```sh
npm run notify-health
npm run notify-health -- --stale-after-hours 24
```

The command reads only connector requests already in the private outbox, sanitized receipts, sanitized provider-status observations, and redacted connector/status recovery markers. It validates at most 1,000 artifacts, accepts files no larger than 256 KiB, rejects symbolic links and malformed contracts, and reports deterministic `confirmed`, `rejected`, `unknown`, `deferred`, `queued`, or `stale` status. Provider `pending` observations remain queued until they cross the configured inspection threshold, then become stale. The stale threshold is an inspection argument bounded from 1 to 720 hours; it is not a configuration migration.

New reports use `schemas/notification-delivery-health.v2.schema.json`; version 1 remains the historical local-only contract. Version 2 adds only sanitized provider observation/binding IDs, provider status/timestamp, hashed status-artifact references, and deterministic provider-review guidance. Reports exclude connector endpoints, profile fields, credential sources or values, request items, candidate artifacts, response bodies, and private paths. The command writes nothing, performs no retry, and never treats an unknown outcome as failed or safe to resend. Requests requiring attention point only to `npm run pending`, manual outbox review, or provider-status review.

Real report instances are private operational artifacts and are blocked by the public-repository verifier outside synthetic fixtures. The inspector remains compatible with supported configuration versions 1 through 5 and does not upgrade the local configuration.

## Tracker

The local workbook has `Dashboard`, `Search Config`, `Leads`, `Applications`, `Scan Log`, `Run Log`, `Form Runs`, `Query Metrics`, `Eligibility Review`, `Lead Monitor`, `Application Outcomes`, and `Action Dashboard`. `Search Config` is authoritative for budgets, scoring, thresholds, and alert limits. `Form Runs` stores compact inspection summaries while full answers remain in private local packets. `Query Metrics` records deterministic discovery-funnel counts for every attributed query attempt. `Eligibility Review` is a persistent inbox for strong roles whose eligibility or candidate evidence still needs a human decision; its Status and Resolution fields remain user-controlled. `Lead Monitor` stores the latest source-backed snapshot of shortlisted and prepared roles while `Scan Log` preserves change history. `Application Outcomes` is append-only and user-confirmed. `Action Dashboard` is a derived queue for reviews, manual submissions, due follow-ups, and stale leads. There are no daily worksheets; timestamps and IDs preserve history.

## Manual and scheduled runs

- Manual: open the project in Codex and say `Run $job-search now`.
- Lead actions: `shortlist L-…`, `dismiss L-…`, `prepare L-…`, or `applied L-…`.
- Application intelligence: `tailor L-…`, `outcome L-…`, or `calibrate outcomes`.
- Form help: prepare the lead, open the application page in a supported browser, then say `form L-…`.
- Scheduled: create a Codex scheduled task for this project and ask it to run `$job-search`. Each user creates their own schedule; schedules are not stored in this repository.

Local scheduled work requires the computer and Codex desktop to be running.

## Public LinkedIn discovery

Run `npm run queries` to preview the exact discovery plan. It allocates the workbook's search budget across role families and produces a mix of public LinkedIn and canonical employer/ATS queries. LinkedIn discovery uses short title-only Boolean searches with exact phrases and uppercase `OR`, plus a seven-day freshness window by default and explicit remote or relocation lanes. Skills, technical context, exclusions, country eligibility, sponsorship, and relocation are evaluated after discovery so public indexing is not over-constrained.

Finder agents may read public LinkedIn job-detail pages without signing in. They record the query ID and LinkedIn job ID, classify unavailable or closed pages as expired, and resolve an employer or public ATS listing before judging whenever possible. The workflow never automates an authenticated LinkedIn session or submits an application.

Query-plan v4 supplies a deterministic public-source adapter registry for Ashby, Greenhouse, Workable, Lever, and SmartRecruiters. Adapters identify canonical hosts and published job IDs from public URLs only; they do not use private APIs, authenticated sessions, access-control bypasses, or submission endpoints. Listing status and eligibility always require page evidence and are never inferred from the URL.

Every new run records one attempt per generated query and attributes each discovery or scan event back to it. The updater persists query-level yields in `Query Metrics` and returns a funnel summary that distinguishes an adequate no-match run from no discoveries, partial query coverage, or insufficient deep evaluation.

`npm run recommend-budgets` reads only the rolling private run archives and compares conservative per-role utility after a minimum sample. It can recommend moving at most one query while preserving the total budget. Recommendations never apply themselves: the separate atomic writer requires `npm run apply-budget -- --recommendation state/RECOMMENDATION.json --approve QBUD-…` with the exact generated ID and rejects stale or modified evidence.

Each discovery payload also records the exact query plan, screening filters, relevant configuration, and evidence-snapshot identifiers. The updater stores immutable private input/result archives with a canonical replay hash. `npm run replay -- --input state/runs/RUN-ID.input.json` normalizes one run, while `npm run compare-runs -- --before-run RUN-A --after-run RUN-B --state-dir state` explains query, filter, evidence, count, and candidate-decision changes without rerunning searches or modifying the tracker.

## Eligibility evidence and lead monitoring

Run `npm run eligibility` to validate and preview the candidate-local eligibility registry. Entries cover hiring countries, remote regions, sponsorship, relocation, or work authorization and require a conservative scope, HTTPS citation, observation date, expiry date, confidence, and optional expiring human override. Only fresh, in-scope entries may be referenced. Stale or conflicting evidence never automatically rejects a job; conflicts go to `Eligibility Review`.

The weekly monitoring workflow gives `change_monitor` only `Shortlisted` and `Moved to Applications` roles. `npm run monitor -- --workbook Job_Application_Tracker.xlsx --input state/MONITOR.json --eligibility-registry profile/eligibility-evidence.json --state-dir state` atomically compares closure, location, work model, description, compensation, and eligibility. It records the latest snapshot in `Lead Monitor`, appends every check to `Scan Log`, and stops preparation for unavailable listings without regressing later application stages.

## Priority markets and company watchlists

Priority markets receive dedicated country-level LinkedIn searches while configured city aliases are included in canonical employer/ATS searches. The query builder still honors the workbook's maximum-search limit; increasing LinkedIn coverage replaces canonical queries instead of adding unbounded work.

The default template includes a Friday [Hiring Without Whiteboards](https://github.com/poteto/hiring-without-whiteboards) watchlist. It is a company and interview-process directory, not a vacancy feed. The finder checks at most the configured number of matching companies, follows public career links, and returns only active canonical vacancies. Directory interview details are stored as an explicitly unscored Notes signal and must be reverified during the application process.

## Useful commands

```sh
npm run config
npm run preflight
npm run upgrade-config
npm run pending
npm run dry-run -- --input state/RUN.json
npm run ingest-alerts -- --input state/job-alert-imports/private-batch.json
npm run import-history -- --source state/tracker-imports/old-tracker.xlsx --mapping state/tracker-imports/mapping.json
npm run notify -- --input state/runs/RUN-ID.result.json
npm run connector-profile -- --profile state/notification-connectors/<profile_id>.profile.json
npm run notify-send -- --request state/notifications/outbox/NREQ-….request.json --profile state/notification-connectors/<profile_id>.profile.json
npm run notify-health
npm run queries
npm run eligibility
npm run calibrate-judge
npm run recommend-budgets
npm test
npm run create-tracker
npm run migrate-tracker
npm run inspect -- Job_Application_Tracker.xlsx renders
npm run update -- --workbook Job_Application_Tracker.xlsx --input state/RUN.json --state-dir state
npm run monitor -- --workbook Job_Application_Tracker.xlsx --input state/MONITOR.json --eligibility-registry profile/eligibility-evidence.json --state-dir state
npm run actions -- --workbook Job_Application_Tracker.xlsx --state-dir state
npm run outcome -- --workbook Job_Application_Tracker.xlsx --input state/OUTCOME.json --state-dir state
npm run calibrate -- --workbook Job_Application_Tracker.xlsx
npm run tailor -- --input state/TAILORING.json --candidate-profile profile/candidate-profile.md --output application-packages/L-ID/tailoring.md
npm run compare-runs -- --before-run RUN-A --after-run RUN-B --state-dir state
npm run verify-public
```

## Application intelligence and operations

After `prepare L-…`, say `tailor L-…` for an advisory report. The read-only tailoring agent maps canonical job requirements and ATS keywords to stable candidate-evidence IDs, and the independent judge must approve every suggested bullet. The deterministic builder rejects unknown evidence, incomplete keyword coverage, and false approvals. It emits Markdown under the private application-packages directory but never edits the resume.

When the candidate reports a screening, interview, rejection, offer, withdrawal, acceptance, or ghosting outcome, say `outcome L-…`. Only explicitly confirmed events are recorded. The append-only history drives advisory conversion summaries by score band and resume; small samples are labeled insufficient and the system never changes weights, thresholds, queries, or resumes automatically.

`Action Dashboard` is refreshed by every supported writer and can be rebuilt with `npm run actions`. It lists work to perform manually; it never sends a follow-up, submits an application, resolves eligibility, or performs outreach.

Judge calibration uses only versioned synthetic fixtures. `npm run calibrate-judge` emits a blind packet that excludes baselines, expected ranges, and unsupported-claim traps. After `job_judge` returns one result per fixture, `npm run calibrate-judge -- --input state/JUDGE-CALIBRATION.json` checks score arithmetic, component and total ranges, required stable citations, unsupported claims, and drift from the baseline. It reports quality without changing scoring policy or candidate data.

## Application-form assistant

After `prepare L-…`, open the matching application page and say `form L-…`. The form agent inspects only the current step, extracts required-state evidence, drafts supported answers, and sends them to the independent judge. Salary, work authorization, sponsorship, relocation, sensitive demographic questions, attestations, and signatures remain manual unless the user has explicitly confirmed the exact answer.

Cover letters follow a strict gate: required fields receive a reviewed draft; optional, absent, or unclear fields do not. The workflow produces copy-ready responses but never populates the form, uploads files, advances a stateful step, or submits.

After manual submission, say `applied L-…`. The tracker records the date and follow-up without claiming that the agent submitted anything.

## Public-repository boundary

The repository contains only reusable code, schemas, templates, tests, project agents, synthetic fixtures, and the generic skill. Git ignores the local configuration, live workbook, candidate profile, resumes, state, application packages, mail-import directories, raw `.eml`/`.mbox`/`.pst` files, renders, PDFs, Word files, and spreadsheets. A pre-commit hook rejects those paths, real email addresses, and common private-data patterns if they are staged accidentally.

Run `npm run install-skill` after pulling skill changes. It installs the generic skill into the current user's Codex skill directory.

GitHub CI runs the dependency-free contract suite on Node 20, 22, and 24. The full workbook integration suite remains a release gate in Codex because `@oai/artifact-tool` is a bundled private workspace dependency rather than a public npm dependency.

## Roadmap

See [ROADMAP.md](ROADMAP.md) for planned reliability, search-quality, ingestion, notification, and service-mode work.

## Releases

Releases follow [Semantic Versioning](https://semver.org/). See [CHANGELOG.md](CHANGELOG.md) for version history.

## License

Licensed under the [MIT License](LICENSE).
