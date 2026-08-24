---
name: job-search
description: Run a configured multi-agent job-discovery workflow, independently judge matches, update a local Excel tracker, and produce priority alerts. Use for scheduled searches and for shortlist, dismiss, or prepare commands. Never submit applications or send outreach.
---

# Job Search

Resolve the project root from the user's prompt or current working directory. Require `.job-search.local.json`; never guess candidate identity or artifact paths.

For discovery, read [workflow.md](references/workflow.md) and [schemas.md](references/schemas.md) completely. For `shortlist L-…`, `dismiss L-…`, or `prepare L-…`, read [lead-actions.md](references/lead-actions.md) completely.

## Invariants

- Export the authoritative configuration with `scripts/export_search_config.mjs`, then read the configured candidate profile, search policy, packet schema, prior leads, and prior run state.
- Delegate discovery to `backend_finder` and `ai_product_finder` in parallel when both are available.
- Remove finder scores and recommendations before sending candidates to `job_judge`.
- Use the judge component total as the final score.
- Convert eligibility disagreements or unsupported candidate claims to `Needs Human Review`; never alert them. A judge-returned structured `Expired` or `Inaccessible` status remains `Ineligible`.
- If judging fails, retain viable candidates as `Needs Judge`; never alert them.
- Continue with partial coverage if one finder fails and record the failure.
- Only the orchestrator may modify the workbook or publish a digest.
- Never submit an application, send outreach, or claim candidate experience absent from the configured profile.

## Completion

After the workbook update succeeds, report only updater-returned alerts, capped by Search Config. Include lead ID, company, role, score, resume, location, eligibility, strengths, primary risk, posting date, and canonical link. If none qualify, give a compact no-match message.
