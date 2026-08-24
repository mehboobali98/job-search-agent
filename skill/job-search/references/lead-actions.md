# Lead actions

Load `.job-search.local.json`, resolve its `tracker_path` and `state_directory`, then call:

`node scripts/manage_lead.mjs --workbook <tracker> --lead-id <ID> --action <shortlist|dismiss|prepare|applied> --state-dir <state-directory>`

- `shortlist` keeps the lead in `Leads` and marks it `Shortlisted`.
- `dismiss` marks it `Dismissed`; later discovery may refresh the record but must preserve that status and never alert it.
- `prepare` marks it `Moved to Applications`, creates or updates the matching `Applications` row at `Preparing`, and begins the manual application-package workflow. For a new row, it copies `Leads.Best Resume` into `Applications.Resume Version`, names that resume in `Recommended Resume Improvements` and `Next Action`, and applies the established Arial 9, wrapped, bordered table style. Repeating `prepare` must preserve later manual edits.
- `applied` is allowed only after the user explicitly says the application was submitted. It requires an existing prepared application, records `Applied` status and stage, adds the application date and a seven-day follow-up by default, and preserves later manual edits when repeated. Pass `--applied-at YYYY-MM-DD`, `--follow-up-at YYYY-MM-DD`, `--salary <text>`, or `--cover-letter <text>` only when the user supplied those values.

Report the committed change or returned pending-write path. Lead actions never submit an application, send outreach, or invent candidate evidence.
