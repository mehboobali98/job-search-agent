# Candidate packet schema

## Finder result

Each finder returns an object with `agent`, `status`, `query_count`, `packets`, `scan_events`, and optional `error`. `packets` contains only deeply evaluated viable jobs. `scan_events` records every other examined listing, including inaccessible, expired, duplicate, shallow-rejected, preliminary-suppressed, and hard-blocked jobs.

A finder packet contains company, title, location, work type, canonical URL, source, employer job ID when published, posted date when published, normalized canonical description text, its exact SHA-256 description hash, structured `listing_status: Active|Expired|Inaccessible`, job-description evidence by rubric component, `finder_eligibility`, `finder_eligibility_evidence`, preliminary component scores and exact total, strengths, gaps, best resume, and stable `candidate_evidence_ids` from `candidate-profile.md`. When a query plan discovered the job, also include `discovery_query_id`, `discovery_source`, and the original discovery URL; the canonical URL may differ after resolving an employer or ATS copy.

A scan event contains company/title/location when known, URL, source, job ID when known, finder, examined time, outcome, reason, preliminary score when calculated, eligibility when determined, description hash when available, `counts_toward_unique` and `deep_evaluated` booleans, and `destination: Scan Log`. Query-driven examinations also include `discovery_query_id` and `discovery_source` in the raw scan packet.

## Blind judge input

The orchestrator sends canonical job data, source links, job evidence, the fixed scoring rubric, and the candidate evidence entries identified by stable IDs. It removes finder component scores, preliminary total, recommendation, band, finder strengths, finder gaps, best-resume recommendation, `finder_eligibility`, and the finder-produced `listing_status`. The orchestrator preserves the finder decisions separately and compares them with the judge's independently returned values outside the judge prompt.

## Judge result

The judge returns `{ agent: job_judge, status, results, failures, error? }`. Status is `Completed`, `Partial`, or `Failed`. `results` contains successfully judged records. Each failure contains canonical URL or key and a source-specific reason; the orchestrator restores the corresponding blinded finder packet as a failed-judge candidate. Any omitted input candidate is treated as a failure, never silently dropped.

## Judged candidate

A judged candidate contains preserved `finder_eligibility` and `finder_eligibility_evidence`, independently returned `judge_eligibility` and `judge_eligibility_evidence`, structured `listing_status`, confidence, seven component scores, exact final score, non-empty strengths, gaps, best resume, `unsupported_evidence` as an explicit boolean, unsupported-evidence details, `judge_status: Judged`, source, canonical URL, location, work type, normalized description, and the job identity fields. `posted_date` may be null when the employer does not publish it. A judge-verified `Expired` or `Inaccessible` listing remains `Ineligible` even when the finder previously considered it active.

## Failed-judge candidate

If the judge fails, restore the original finder packet by canonical key and emit a pending record with company, title, location, work type, canonical URL, source, job ID, posted date, normalized description and its exact hash, `listing_status: Active`, best resume, `finder_eligibility`, `finder_eligibility_evidence`, `preliminary_score`, `eligibility: Needs Judge`, `confidence: Low`, and `judge_status: Needs Judge`. Do not attach final component scores or a final score.

## Run payload

The orchestrator submits `run_id`, timestamps, status, per-agent status, counts, errors, notes, `scan_events`, and `candidates`. `scan_events` contains non-judged examination events. `candidates` contains judged leads, judged suppressions, and failed-judge pending records. The updater reads thresholds and alert limits from the workbook, recomputes canonical keys and judged totals, and appends both collections to the audit log.
