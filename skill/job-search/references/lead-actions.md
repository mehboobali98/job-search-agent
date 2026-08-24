# Lead actions

Load `.job-search.local.json`, resolve its `tracker_path` and `state_directory`, then call:

`node scripts/manage_lead.mjs --workbook <tracker> --lead-id <ID> --action <shortlist|dismiss|prepare> --state-dir <state-directory>`

- `shortlist` keeps the lead in `Leads` and marks it `Shortlisted`.
- `dismiss` marks it `Dismissed`; later discovery may refresh the record but must preserve that status and never alert it.
- `prepare` marks it `Moved to Applications`, creates or updates the matching `Applications` row at `Preparing`, and begins the manual application-package workflow.

Report the committed change or returned pending-write path. Preparing never submits an application, sends outreach, or invents candidate evidence.
