# Schemas

All packets are JSON-compatible. Text evidence is concise and source-specific.

## Finder result

Each finder returns `{ agent, status, query_count, packets, scan_events, error? }`. Packets are deeply evaluated viable jobs. Scan events contain every duplicate, inaccessible, expired, shallow-rejected, preliminary-suppressed, or hard-blocked examination.

A finder packet requires identity and source fields, normalized job description with exact SHA-256 hash, `listing_status`, rubric evidence, finder eligibility and evidence, seven preliminary component scores, total, strengths, gaps, best resume, and stable candidate evidence IDs.

A scan event includes identity when known, finder, examination timestamp, outcome, reason, optional score/eligibility/hash, `counts_toward_unique`, `deep_evaluated`, and `destination: Scan Log`.

## Blind judge input

Include canonical job data, source links, job evidence, scoring rubric, and candidate evidence. Exclude finder eligibility and listing status, scores, preliminary total, recommendation, strengths, gaps, and best resume.

## Judge result

The judge returns `{ agent: job_judge, status, results, failures, error? }` with status `Completed`, `Partial`, or `Failed`. Every failure or omitted input becomes a failed-judge candidate restored from the original finder packet.

A judged candidate requires identity, source, description and matching hash, structured `listing_status`, preserved finder eligibility/evidence, independently returned judge eligibility/evidence, confidence, all seven scores and exact total, strengths, gaps, best resume, explicit unsupported-evidence boolean/details, and `judge_status: Judged`. `Expired` or `Inaccessible` requires judge eligibility `Ineligible`.

Allowed resumes: `Backend / Platform`, `Staff / Principal / Tech Lead`, `Applied AI / LLM`, `Developer Productivity / AI Enablement`, and `Full-stack / Product`.

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

The updater validates the envelope, timestamps, agent states, count relationships, Search Config limits, scan events, candidate hashes, eligibility, and alert rules before mutation.

## Friday recheck payload

`{ run_id, started_at, completed_at, notes, checks }`, where each check has `lead_id`, `result: Active|Expired`, the matching `canonical_url`, and source-backed `evidence`.
