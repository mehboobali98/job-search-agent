# Job Search Agent

This project is a reusable, single-candidate-per-clone job-discovery system. Read `.job-search.local.json` for the local candidate's paths, timezone, and target geography. That file and every candidate artifact are intentionally ignored by Git.

## Safety and scope

- Never submit an application, send outreach, or change an application status without the configured candidate's explicit request.
- Finder and judge agents are read-only. Only the orchestrator may call `scripts/update_tracker.mjs`, `scripts/manage_lead.mjs`, or `scripts/recheck_expiry.mjs`.
- Use only evidence in the configured candidate profile; do not infer experience from a job description.
- Treat explicit residency, work-authorization, and unsupported-country restrictions as hard blockers.
- Preserve the configured canonical workbook through atomic writes. If an update fails, keep it unchanged and retain a pending JSON payload in the configured state directory.
- Prefer the employer's canonical job page. Aggregators are discovery sources, not sufficient evidence when a canonical page is available.
- Never stage or commit `.job-search.local.json`, the live workbook, candidate profiles, resumes, state, renders, or generated inspection files.

## Recurring workflow

Invoke `$job-search`. Resolve the project from the user's prompt or current working directory, load `.job-search.local.json`, and export the workbook configuration with `scripts/export_search_config.mjs`. Spawn `backend_finder` and `ai_product_finder` in parallel with the normalized profile, packet schema, exported configuration, and exact budgets. Combine and deduplicate their packets, then send the configured number of preliminary candidates to `job_judge` without finder scores or recommendations. Only records with `judge_status=Judged` may trigger priority alerts.

## Project files

- `.job-search.local.json` resolves the ignored tracker, candidate profile, resume directory, state directory, timezone, and geography.
- The configured candidate profile is the evidence source of truth.
- `profile/search-policy.md` defines query allocation and screening policy.
- `profile/candidate-packet-schema.md` defines finder, scan-event, blind-judge, judged, and failed-judge contracts.
- `scripts/update_tracker.mjs` is the only supported workbook mutation interface.
- `templates/` contains safe onboarding templates; it must never contain a real candidate's data.
