# Discovery workflow

1. Resolve the project root from the user's prompt or current working directory and load `.job-search.local.json`.
2. Run `node scripts/export_search_config.mjs`. Treat its output as authoritative. Read the configured candidate profile, `profile/candidate-packet-schema.md`, prior leads, and configured `state_directory/last-run.json` when present.
3. Create a unique run ID and record timestamps in the configured timezone.
4. Use the exported role and agent query budgets. Run both finders in parallel.
5. Give each finder the complete packet schema, candidate profile with stable evidence IDs, exported configuration, exact role families, exact budget, caps, and read-only rule. If a named project agent is unavailable, use a generic read-only subagent with the same prompt and record the fallback.
6. Prefer employer or public ATS pages. Canonicalize URLs, deduplicate by employer job ID, canonical URL, then normalized company/title/location. Preserve every other examination as a scan event.
7. Suppress expired or inaccessible listings and explicit residency, unsupported-country, or work-authorization blockers. Retain unclear sponsorship for review with reduced location points.
8. Select at most the configured judge maximum from candidates meeting the judge threshold. Blind the judge by removing finder eligibility, finder listing status, finder scores, total, recommendation, strengths, gaps, and best resume.
9. Give `job_judge` only canonical job evidence, source links, candidate evidence, rubric, and exported configuration. Require the judge envelope and structured listing status. Convert per-candidate failures or omissions into failed-judge records.
10. Convert finder/judge eligibility disagreements or unsupported evidence to `Needs Human Review`. A judge-verified `Expired` or `Inaccessible` listing remains `Ineligible`. Never infer listing status from rationale keywords.
11. Build the run payload from `schemas.md`. Every retained candidate must carry one allowed `best_resume`. Resolve `tracker_path` and `state_directory` from local configuration and call `scripts/update_tracker.mjs`. This is the only discovery write path and it applies the established table-body formatting to every appended Leads, Scan Log, and Run Log row.
12. On Fridays, recheck canonical URLs for `Shortlisted` and `Moved to Applications` leads, then call `scripts/recheck_expiry.mjs` with source-backed evidence.
13. Publish only updater-returned alerts, ordered by judge score and capped by Search Config.

An empty finder result is successful. A fallback is recorded explicitly. One finder failure produces a partial run. A workbook write failure preserves the workbook and records a pending payload in the configured state directory.
