# Schemas

All packets are JSON-compatible. Text evidence is concise and source-specific.

## Search query plan

Query-plan v4 returns a JSON object with `target_geography`, `run_weekday`, exact `query_count`, `linkedin_query_count`, `company_watchlist_query_count`, `priority_markets`, `canonical_source_adapters`, `role_query_budget`, `by_finder`, and a flat `queries` list. Each finder receives only its own `by_finder` entries and must execute exactly that assigned count. Every canonical-source adapter has a stable ID, display name, recognized public hosts, `public_read_only` access contract, and explicit rules prohibiting private APIs, authenticated sessions, access-control bypasses, and submission endpoints.

Every query includes `query_id`, `finder`, `role_family`, `source`, `lane`, `keywords`, `location`, `filters`, and `source_rules`. A `linkedin_public` query also includes `search_url`, `public_index_query`, and `post_discovery_screening` containing skills, context, relocation terms, priority-market city aliases, and exclusions that must not narrow the discovery query. A `canonical_web` query includes `web_query`, configured `market_terms`, and the adapter registry. A `company_watchlist` query includes its directory URL/name, market terms, weekly company cap, interview-process signal, and rules that require an active canonical vacancy. Finders preserve `query_id`, the discovery source, and the original discovery URL in packets and scan events even when they replace the canonical URL with a verified employer or ATS listing.

## Finder result

Each finder returns `{ agent, status, query_count, query_attempts, packets, scan_events, error? }`. `query_attempts` contains exactly one `{ query_id, finder, source, lane, status: Completed|Failed, error? }` record per assigned query; failed records require an error and make the combined run `Partial`. Packets are deeply evaluated viable jobs. Scan events contain every duplicate, inaccessible, expired, shallow-rejected, preliminary-suppressed, or hard-blocked examination.

A finder packet requires identity and source fields, normalized job description with exact SHA-256 hash, `listing_status`, rubric evidence, finder eligibility and evidence, seven preliminary component scores, total, strengths, gaps, best resume, and stable candidate evidence IDs. Query-plan discoveries also carry `discovery_query_id`, `discovery_source`, their original discovery URL before canonical-source resolution, `canonical_source_adapter` when the canonical host matches the supplied registry, and evidence-backed `canonical_source_status`. A vacancy found through a company watchlist also carries the configured non-empty `interview_process_signal`; the updater stores it in Notes and it never changes a component score.

A scan event includes identity when known, finder, examination timestamp, outcome, reason, optional score/eligibility/hash, `counts_toward_unique`, `deep_evaluated`, and `destination: Scan Log`. `deep_evaluated: true` requires `counts_toward_unique: true`; a duplicate or other examination excluded from the unique-vacancy count cannot increase the deep-evaluation count. It also retains query-plan provenance in its raw JSON when applicable.

## Blind judge input

Include canonical job data, source links, job evidence, scoring rubric, and candidate evidence. Exclude finder eligibility and listing status, scores, preliminary total, recommendation, strengths, gaps, best resume, and `interview_process_signal`. The orchestrator preserves the signal outside the judge packet and restores it unchanged after judging.

## Judge result

The judge returns `{ agent: job_judge, status, results, failures, error? }` with status `Completed`, `Partial`, or `Failed`. Every failure or omitted input becomes a failed-judge candidate restored from the original finder packet.

A judged candidate requires identity, source, description and matching hash, structured `listing_status`, preserved finder eligibility/evidence, independently returned judge eligibility/evidence, confidence, all seven scores and exact total, strengths, gaps, best resume, explicit unsupported-evidence boolean/details, and `judge_status: Judged`. `Expired` or `Inaccessible` requires judge eligibility `Ineligible`.

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
    "job_judge": "Completed | Partial | Failed | Fallback Completed | Fallback Failed"
  },
  "queries": 0,
  "query_attempts": [],
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

The updater validates the envelope, timestamps, agent states, count relationships, Search Config limits, query-attempt attribution, scan events, candidate hashes, eligibility, canonical-source adapter claims, and alert rules before mutation. It writes one `Query Metrics` row per attempt, upserts strong unresolved cases in `Eligibility Review`, and returns review outcomes plus deterministic funnel, per-query, per-source, and coverage diagnostics. Payloads created before query-attempt or adapter tracking remain accepted.

## Friday recheck payload

`{ run_id, started_at, completed_at, notes, checks }`, where each check has `lead_id`, `result: Active|Expired`, the matching `canonical_url`, and source-backed `evidence`.
