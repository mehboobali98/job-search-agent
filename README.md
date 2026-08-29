# Multi-Agent Job Search Agent

A reusable Codex workflow that discovers jobs with two parallel finders, independently judges candidate fit, inspects prepared application forms, drafts evidence-backed responses, safely updates a local Excel tracker, and returns a small priority digest. It never submits applications or sends outreach.

## How it works

- `backend_finder` searches backend/platform and staff/leadership roles.
- `ai_product_finder` searches applied AI, developer productivity, and selective product roles.
- `application_form_agent` reads the current prepared application-form step and drafts responses without typing or submitting.
- `job_judge` scores canonical listings without finder anchoring and separately audits form responses against candidate evidence.
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
- `Job_Application_Tracker.xlsx` — the nine-sheet tracker
- `profile/search-terms.json` — private role titles, skills, exclusions, locations, and LinkedIn query settings
- `state/` — run payloads and updater state
- `application-packages/` — private form-response packets and required cover-letter files

Complete the candidate profile, add resume files, and then tell Codex: `Run $job-search now`.

Before the first run, edit `profile/search-terms.json` so each role family uses the candidate's actual titles and technologies. Keep terms atomic; the query builder adds LinkedIn-supported Boolean operators and quoting.

Priority markets belong in `linkedin_public.priority_market_locations`, with country-level LinkedIn locations and optional city aliases for canonical ATS discovery. `company_watchlists` defines bounded, public company directories that can replace one normal query on a configured weekday. Use `npm run queries -- --run-date 2026-08-28T08:00:00+05:00` to preview a specific scheduled day without running discovery.

## Tracker

The local workbook has `Dashboard`, `Search Config`, `Leads`, `Applications`, `Scan Log`, `Run Log`, `Form Runs`, `Query Metrics`, and `Eligibility Review`. `Search Config` is authoritative for budgets, scoring, thresholds, and alert limits. `Form Runs` stores compact inspection summaries while full answers remain in private local packets. `Query Metrics` records deterministic discovery-funnel counts for every attributed query attempt. `Eligibility Review` is a persistent inbox for strong roles whose eligibility or candidate evidence still needs a human decision; its Status and Resolution fields remain user-controlled. There are no daily worksheets; timestamps and IDs preserve history.

## Manual and scheduled runs

- Manual: open the project in Codex and say `Run $job-search now`.
- Lead actions: `shortlist L-…`, `dismiss L-…`, `prepare L-…`, or `applied L-…`.
- Form help: prepare the lead, open the application page in a supported browser, then say `form L-…`.
- Scheduled: create a Codex scheduled task for this project and ask it to run `$job-search`. Each user creates their own schedule; schedules are not stored in this repository.

Local scheduled work requires the computer and Codex desktop to be running.

## Public LinkedIn discovery

Run `npm run queries` to preview the exact discovery plan. It allocates the workbook's search budget across role families and produces a mix of public LinkedIn and canonical employer/ATS queries. LinkedIn discovery uses short title-only Boolean searches with exact phrases and uppercase `OR`, plus a seven-day freshness window by default and explicit remote or relocation lanes. Skills, technical context, exclusions, country eligibility, sponsorship, and relocation are evaluated after discovery so public indexing is not over-constrained.

Finder agents may read public LinkedIn job-detail pages without signing in. They record the query ID and LinkedIn job ID, classify unavailable or closed pages as expired, and resolve an employer or public ATS listing before judging whenever possible. The workflow never automates an authenticated LinkedIn session or submits an application.

Query-plan v4 supplies a deterministic public-source adapter registry for Ashby, Greenhouse, Workable, Lever, and SmartRecruiters. Adapters identify canonical hosts and published job IDs from public URLs only; they do not use private APIs, authenticated sessions, access-control bypasses, or submission endpoints. Listing status and eligibility always require page evidence and are never inferred from the URL.

Every new run records one attempt per generated query and attributes each discovery or scan event back to it. The updater persists query-level yields in `Query Metrics` and returns a funnel summary that distinguishes an adequate no-match run from no discoveries, partial query coverage, or insufficient deep evaluation.

## Priority markets and company watchlists

Priority markets receive dedicated country-level LinkedIn searches while configured city aliases are included in canonical employer/ATS searches. The query builder still honors the workbook's maximum-search limit; increasing LinkedIn coverage replaces canonical queries instead of adding unbounded work.

The default template includes a Friday [Hiring Without Whiteboards](https://github.com/poteto/hiring-without-whiteboards) watchlist. It is a company and interview-process directory, not a vacancy feed. The finder checks at most the configured number of matching companies, follows public career links, and returns only active canonical vacancies. Directory interview details are stored as an explicitly unscored Notes signal and must be reverified during the application process.

## Useful commands

```sh
npm run config
npm run queries
npm test
npm run create-tracker
npm run migrate-tracker
npm run inspect -- Job_Application_Tracker.xlsx renders
npm run update -- --workbook Job_Application_Tracker.xlsx --input state/RUN.json --state-dir state
npm run verify-public
```

## Application-form assistant

After `prepare L-…`, open the matching application page and say `form L-…`. The form agent inspects only the current step, extracts required-state evidence, drafts supported answers, and sends them to the independent judge. Salary, work authorization, sponsorship, relocation, sensitive demographic questions, attestations, and signatures remain manual unless the user has explicitly confirmed the exact answer.

Cover letters follow a strict gate: required fields receive a reviewed draft; optional, absent, or unclear fields do not. The workflow produces copy-ready responses but never populates the form, uploads files, advances a stateful step, or submits.

After manual submission, say `applied L-…`. The tracker records the date and follow-up without claiming that the agent submitted anything.

## Public-repository boundary

The repository contains only reusable code, schemas, templates, tests, project agents, and the generic skill. Git ignores the local configuration, live workbook, candidate profile, resumes, state, application packages, renders, PDFs, Word files, and spreadsheets. A pre-commit hook rejects those paths and common private-data patterns if they are staged accidentally.

Run `npm run install-skill` after pulling skill changes. It installs the generic skill into the current user's Codex skill directory.

## Roadmap

See [ROADMAP.md](ROADMAP.md) for planned reliability, search-quality, ingestion, notification, and service-mode work.

## Releases

Releases follow [Semantic Versioning](https://semver.org/). See [CHANGELOG.md](CHANGELOG.md) for version history.

## License

Licensed under the [MIT License](LICENSE).
