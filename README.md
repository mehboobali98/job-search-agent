# Multi-Agent Job Search Agent

A reusable Codex workflow that discovers jobs with two parallel finders, independently judges candidate fit, safely updates a local Excel tracker, and returns a small priority digest. It never submits applications or sends outreach.

## How it works

- `backend_finder` searches backend/platform and staff/leadership roles.
- `ai_product_finder` searches applied AI, developer productivity, and selective product roles.
- `job_judge` scores canonical listings without seeing finder scores or recommendations.
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
```

Setup creates these private, ignored artifacts:

- `.job-search.local.json` — local paths, timezone, and target geography
- `profile/candidate-profile.md` — verified candidate evidence
- `profile/resumes/` — resume files
- `Job_Application_Tracker.xlsx` — the six-sheet tracker
- `state/` — run payloads and updater state

Complete the candidate profile, add resume files, and then tell Codex: `Run $job-search now`.

## Tracker

The local workbook has `Dashboard`, `Search Config`, `Leads`, `Applications`, `Scan Log`, and `Run Log`. `Search Config` is authoritative for budgets, scoring, thresholds, and alert limits. There are no daily worksheets; `First Seen`, `Last Seen`, and `Run ID` preserve history.

## Manual and scheduled runs

- Manual: open the project in Codex and say `Run $job-search now`.
- Lead actions: `shortlist L-…`, `dismiss L-…`, or `prepare L-…`.
- Scheduled: create a Codex scheduled task for this project and ask it to run `$job-search`. Each user creates their own schedule; schedules are not stored in this repository.

Local scheduled work requires the computer and Codex desktop to be running.

## Useful commands

```sh
npm run config
npm test
npm run create-tracker
npm run inspect -- Job_Application_Tracker.xlsx renders
npm run update -- --workbook Job_Application_Tracker.xlsx --input state/RUN.json --state-dir state
npm run verify-public
```

## Public-repository boundary

The repository contains only reusable code, schemas, templates, tests, project agents, and the generic skill. Git ignores the local configuration, live workbook, candidate profile, resumes, state, renders, PDFs, Word files, and spreadsheets. A pre-commit hook rejects those paths and common private-data patterns if they are staged accidentally.

Run `npm run install-skill` after pulling skill changes. It installs the generic skill into the current user's Codex skill directory.
