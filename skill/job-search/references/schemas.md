# Schemas

All packets are JSON-compatible. Text evidence is concise and source-specific.

## Job-alert batch and discovery proposal

Job alerts use the transport-neutral version-1 batch in `schemas/job-alert-batch.v1.schema.json`. The envelope has `schema_version`, `batch_id`, `{ provider, access_mode: read_only, query? }`, `retrieved_at`, and `messages[]`. A private message carries transport ID, receipt timestamp, From header, optional subject, and text and/or HTML body. Those raw fields exist only in the ignored input batch.

`scripts/ingest_job_alerts.mjs` emits the version-1 sanitized proposal in `schemas/job-alert-discovery-proposal.v1.schema.json`. It contains a deterministic proposal ID, read-only transport marker, query hash, one `gmail_alert_finder` query attempt, proposed candidates, classifications, compact counts, and explicit privacy flags. Proposed candidates contain normalized public job URLs, extracted non-private job metadata, canonical adapter/job ID when available, live-verification/judge requirements, and provenance limited to batch ID, received timestamp, link index, and a one-way message reference.

The classifications are `malformed_message`, `sender_not_allowed`, `stale_message`, `extraction_failure`, `unsupported_link`, `duplicate_in_batch`, `duplicate_in_tracker`, `expired_listing`, and `limit_exceeded`. They are proposal diagnostics, not raw tracker scan events. Do not force malformed records without a valid job identity through the updater.

An alert proposal is not a finder packet. For each retained seed, verify a live public canonical vacancy, collect the complete finder packet below, blind the judge normally, and retain the Gmail discovery attribution in the final run. The run may add `agents.gmail_alert_finder` with a normal finder status. The updater remains the only tracker writer.

## Historical tracker import mapping

Historical `.xlsx` sources use `schemas/historical-tracker-import.v1.schema.json` when compatible `LeadsTable` or `ApplicationsTable` auto-mapping is unavailable. The strict envelope contains `schema_version: 1`, opaque `import_id`, deterministic `imported_at`, and one to twenty sheet mappings. Each mapping has an exact sheet name, `record_type: lead|application`, one-based header row, and unique exact header names for mapped fields; company and title are required.

The runtime accepts only the documented lead/application fields and bounded values. It converts source dates to stable timestamps, accepts only existing tracker choices for statuses, stages, eligibility, confidence, and resume variants, rejects non-HTTP(S) URLs, and derives all identities with `candidateIdentityKeys`. Preview diagnostics use only one-way row references and omit raw rows and private text. The mapping never grants permission to overwrite a current tracker row.

## Notification digest and delivery request

`schemas/job-digest.v1.schema.json` defines a deterministic privacy-minimized digest built only from updater-returned alerts. It contains an opaque digest ID, run/replay identity, stable timestamp and timezone, at most twenty job items, and explicit flags proving candidate identity, credentials, private paths, and raw run payloads are absent.

`schemas/notification-delivery-request.v1.schema.json` defines one adapter-neutral request per enabled destination. It contains the exact approval ID, opaque destination/connection references, selected digest items, deterministic `not_before`, per-destination filter policy, and safety flags proving the request writer did not perform external delivery and allowing neither application submission nor recruiter outreach. A private-file request is local; a connector request remains queued until the separately authorized dispatcher honors the same approval and time boundary.

`schemas/notification-connector-profile.v1.schema.json` defines the private live HTTPS JSON bearer profile. Real profile instances stay ignored under private state. They contain an enabled flag, opaque profile and connection references, a query-free HTTPS endpoint without user info or fragments, the name (never value) of a bearer-token environment variable, exact destination/channel allowlist, 1–15 second timeout, bounded request/response sizes, one to three attempts, at most ten seconds of deterministic retry delay, and mandatory `Idempotency-Key` support.

`schemas/notification-connector-binding.v1.schema.json` and `schemas/notification-connector-receipt.v1.schema.json` define sanitized private artifacts. A binding hashes the complete profile and endpoint while exporting neither endpoint nor credential-source detail. A receipt records only deterministic request/binding identities, request hash, delivery timestamp, 2xx status, attempt count, stable idempotency key, and explicit redaction/non-application safety flags.

## Search query plan

Query-plan v4 returns a JSON object with `target_geography`, `run_weekday`, exact `query_count`, `linkedin_query_count`, `company_watchlist_query_count`, `priority_markets`, `canonical_source_adapters`, `role_query_budget`, `by_finder`, and a flat `queries` list. Each finder receives only its own `by_finder` entries and must execute exactly that assigned count. Every canonical-source adapter has a stable ID, display name, recognized public hosts, `public_read_only` access contract, and explicit rules prohibiting private APIs, authenticated sessions, access-control bypasses, and submission endpoints.

Every query includes `query_id`, `finder`, `role_family`, `source`, `lane`, `keywords`, `location`, `filters`, and `source_rules`. A `linkedin_public` query also includes `search_url`, `public_index_query`, and `post_discovery_screening` containing skills, context, relocation terms, priority-market city aliases, and exclusions that must not narrow the discovery query. A `canonical_web` query includes `web_query`, configured `market_terms`, and the adapter registry. A `company_watchlist` query includes its directory URL/name, market terms, weekly company cap, interview-process signal, and rules that require an active canonical vacancy. Finders preserve `query_id`, the discovery source, and the original discovery URL in packets and scan events even when they replace the canonical URL with a verified employer or ATS listing.

## Finder result

Each finder returns `{ agent, status, query_count, query_attempts, packets, scan_events, error? }`. `query_attempts` contains exactly one `{ query_id, finder, role_family, source, lane, status: Completed|Failed, error? }` record per assigned query; failed records require an error and make the combined run `Partial`. The role family is required for new runs and remains optional only for legacy payload compatibility. Packets are deeply evaluated viable jobs. Scan events contain every duplicate, inaccessible, expired, shallow-rejected, preliminary-suppressed, or hard-blocked examination.

A finder packet requires identity and source fields, normalized job description with exact SHA-256 hash, `listing_status`, rubric evidence, finder eligibility and evidence, fresh in-scope `finder_eligibility_evidence_ids`, seven preliminary component scores, total, strengths, gaps, best resume, and stable candidate evidence IDs. Query-plan discoveries also carry `discovery_query_id`, `discovery_source`, their original discovery URL before canonical-source resolution, `canonical_source_adapter` when the canonical host matches the supplied registry, and evidence-backed `canonical_source_status`. A vacancy found through a company watchlist also carries the configured non-empty `interview_process_signal`; the updater stores it in Notes and it never changes a component score.

A scan event includes identity when known, finder, examination timestamp, outcome, reason, optional score/eligibility/hash, `counts_toward_unique`, `deep_evaluated`, and `destination: Scan Log`. `deep_evaluated: true` requires `counts_toward_unique: true`; a duplicate or other examination excluded from the unique-vacancy count cannot increase the deep-evaluation count. It also retains query-plan provenance in its raw JSON when applicable.

## Blind judge input

Include canonical job data, source links, job evidence, the full active eligibility-registry snapshot, scoring rubric, and candidate evidence. Exclude finder eligibility, finder registry IDs and listing status, scores, preliminary total, recommendation, strengths, gaps, best resume, and `interview_process_signal`. The orchestrator preserves the signal and finder IDs outside the judge packet and restores them unchanged after judging.

## Judge result

The judge returns `{ agent: job_judge, status, results, failures, error? }` with status `Completed`, `Partial`, or `Failed`. Every failure or omitted input becomes a failed-judge candidate restored from the original finder packet.

A judged candidate requires identity, source, description and matching hash, structured `listing_status`, preserved finder eligibility/evidence/registry IDs, independently returned judge eligibility/evidence/registry IDs, confidence, all seven scores and exact total, strengths, gaps, best resume, explicit unsupported-evidence boolean/details, and `judge_status: Judged`. `Expired` or `Inaccessible` requires judge eligibility `Ineligible`. The orchestrator emits the stable unique union as `eligibility_evidence_ids` for deterministic updater validation.

Allowed resumes: `Backend / Platform`, `Staff / Principal / Tech Lead`, `Applied AI / LLM`, `Developer Productivity / AI Enablement`, and `Full-stack / Product`.

The updater persists this value in `Leads.Best Resume`. A later `prepare` action copies it to `Applications.Resume Version` and repeats it in the resume-tailoring guidance and next action so the intended resume is visible without consulting the discovery packet.

A failed-judge candidate restores the finder packet with `listing_status: Active`, preliminary score, finder eligibility/evidence, `eligibility: Needs Judge`, `confidence: Low`, and `judge_status: Needs Judge`. It has no final scores.

## Run payload

```json
{
  "run_id": "RUN-YYYYMMDD-HHMMSS",
  "started_at": "ISO-8601",
  "completed_at": "ISO-8601",
  "status": "Completed or Partial",
  "agents": {
    "backend_finder": "Completed | Failed | Fallback Completed | Fallback Failed",
    "ai_product_finder": "Completed | Failed | Fallback Completed | Fallback Failed",
    "gmail_alert_finder": "optional; Completed | Failed | Fallback Completed | Fallback Failed",
    "job_judge": "Completed | Partial | Failed | Fallback Completed | Fallback Failed"
  },
  "queries": 0,
  "query_attempts": [],
  "replay_context": {
    "query_plan": [],
    "filters": {},
    "config": {},
    "evidence": {}
  },
  "found": 0,
  "unique": 0,
  "evaluated": 0,
  "judged": 0,
  "errors": [],
  "notes": "",
  "scan_events": [],
  "candidates": []
}
```

The updater validates the envelope, timestamps, agent states, count relationships, Search Config limits, query-attempt attribution, replay context, scan events, candidate hashes, eligibility, referenced registry IDs, canonical-source adapter claims, and alert rules before mutation. It ignores stale and out-of-scope registry entries, converts active registry conflicts to `Needs Human Review`, writes one `Query Metrics` row per attempt, upserts strong unresolved cases in `Eligibility Review`, refreshes the Action Dashboard, and returns review outcomes plus deterministic funnel, per-query, per-source, coverage, and replay diagnostics. The exact input and result are archived privately under `state_directory/runs/`. Payloads created before query-attempt, registry, adapter, or replay-context tracking remain accepted.

## Application outcome payload

`{ schema_version: 1, event_id, lead_id, occurred_at, outcome, stage, reason_category?, notes?, user_confirmed: true }`. Outcome is `Applied|Screening|Interview|Rejected|Offer|Withdrawn|Accepted|Ghosted`. Stage is one allowed application pipeline stage. The writer requires an existing application, appends one idempotent event to `Application Outcomes`, advances but never regresses the application, and never infers an event without explicit user confirmation.

## Tailoring report payload

A schema-version-1 tailoring packet contains job identity and description hash, one allowed resume version, source-backed job requirements and ATS keywords, exactly one coverage record per keyword, evidence-backed bullet recommendations, gaps, prohibited claims, and a completed independent `job_judge` review. Every covered or transferable keyword and every bullet cites stable candidate-evidence IDs. An approved packet supports every bullet and contains no unsupported bullet IDs. The builder emits private Markdown only; it never edits a resume or application.

## Lead monitor payload

`{ run_id, started_at, completed_at, notes, checks }` contains exactly one check per supplied `Shortlisted` or `Moved to Applications` lead. Every check requires `lead_id`, the exact matching `canonical_url`, `listing_status: Active|Expired|Inaccessible`, and concise source-backed `evidence`. An active check additionally requires exact location, work type, normalized `job_description` and matching SHA-256 `description_hash`, `compensation: { published: boolean, text: string|null }`, `eligibility: Eligible|Unclear|Ineligible`, eligibility evidence, and fresh in-scope `eligibility_evidence_ids`. An expired or inaccessible check contains no inferred active-page facts.

The monitor writer compares listing status, location, work type, description hash, compensation publication/text, and eligibility. It returns `{ run_id, outcomes, reviews, registry_warnings }`; every outcome includes lead ID, listing status, `changed`, `change_types`, and a concise summary.

## Friday recheck payload

`{ run_id, started_at, completed_at, notes, checks }`, where each check has `lead_id`, `result: Active|Expired`, the matching `canonical_url`, and source-backed `evidence`.
