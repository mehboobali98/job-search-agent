# Multi-Agent Job Search Agent

A reusable Codex workflow that discovers jobs with two parallel finders, independently judges candidate fit, monitors shortlisted roles, prepares claim-safe application guidance, tracks confirmed outcomes, and safely updates a local Excel tracker. It never submits applications or sends outreach.

## How it works

- `backend_finder` searches backend/platform and staff/leadership roles.
- `ai_product_finder` searches applied AI, developer productivity, and selective product roles.
- `application_form_agent` reads the current prepared application-form step and drafts responses without typing or submitting.
- `change_monitor` rechecks shortlisted and prepared canonical listings for material changes without writing to the tracker.
- `tailoring_agent` maps canonical job requirements and ATS keywords to stable candidate evidence without editing resumes.
- `job_judge` scores canonical listings without finder anchoring, runs blind synthetic calibration fixtures, and separately audits form responses and tailoring reports against candidate evidence.
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
npm run preflight
```

Setup creates these private, ignored artifacts:

- `.job-search.local.json` — local paths, timezone, and target geography
- `profile/candidate-profile.md` — verified candidate evidence
- `profile/resumes/` — resume files
- `Job_Application_Tracker.xlsx` — the twelve-sheet tracker
- `profile/search-terms.json` — private role titles, skills, exclusions, locations, and LinkedIn query settings
- `profile/eligibility-evidence.json` — private, cited, expiring eligibility-policy evidence and human overrides
- `state/` — run payloads, deterministic replay archives, and updater state
- `application-packages/` — private tailoring reports, form-response packets, and required cover-letter files

Complete the candidate profile, add resume files, and then tell Codex: `Run $job-search now`.

Before the first run, edit `profile/search-terms.json` so each role family uses the candidate's actual titles and technologies. Keep terms atomic; the query builder adds LinkedIn-supported Boolean operators and quoting.

Priority markets belong in `linkedin_public.priority_market_locations`, with country-level LinkedIn locations and optional city aliases for canonical ATS discovery. `company_watchlists` defines bounded, public company directories that can replace one normal query on a configured weekday. Use `npm run queries -- --run-date 2026-08-28T08:00:00+05:00` to preview a specific scheduled day without running discovery.

## Reliability checks and recovery

`npm run preflight` returns one machine-readable report for the Node runtime, bundled workbook dependency, local config version, twelve-sheet tracker contract, stable candidate evidence, five-variant PDF/DOCX resume inventory, search terms, eligibility registry, writable private directories, and pending recovery markers. Failed checks block discovery; warnings remain visible.

Local config version 4 adds reliability settings while older versions remain readable. `npm run upgrade-config` previews every change without writing. Apply only with `npm run upgrade-config -- --apply`; the upgrader saves the prior config under the ignored state directory, initializes missing generic support files and private directories without overwriting anything, then atomically replaces the config.

`npm run dry-run -- --input state/RUN.json` validates a proposed discovery payload against an isolated workbook copy and verifies that the live workbook hash is unchanged. If a writer previously failed, `npm run pending` reports its marker checksum, age, failure summary, and exact recovery steps without deleting it. Extraction for replay is explicit and remains inside the private state directory.

## Tracker

The local workbook has `Dashboard`, `Search Config`, `Leads`, `Applications`, `Scan Log`, `Run Log`, `Form Runs`, `Query Metrics`, `Eligibility Review`, `Lead Monitor`, `Application Outcomes`, and `Action Dashboard`. `Search Config` is authoritative for budgets, scoring, thresholds, and alert limits. `Form Runs` stores compact inspection summaries while full answers remain in private local packets. `Query Metrics` records deterministic discovery-funnel counts for every attributed query attempt. `Eligibility Review` is a persistent inbox for strong roles whose eligibility or candidate evidence still needs a human decision; its Status and Resolution fields remain user-controlled. `Lead Monitor` stores the latest source-backed snapshot of shortlisted and prepared roles while `Scan Log` preserves change history. `Application Outcomes` is append-only and user-confirmed. `Action Dashboard` is a derived queue for reviews, manual submissions, due follow-ups, and stale leads. There are no daily worksheets; timestamps and IDs preserve history.

## Manual and scheduled runs

- Manual: open the project in Codex and say `Run $job-search now`.
- Lead actions: `shortlist L-…`, `dismiss L-…`, `prepare L-…`, or `applied L-…`.
- Application intelligence: `tailor L-…`, `outcome L-…`, or `calibrate outcomes`.
- Form help: prepare the lead, open the application page in a supported browser, then say `form L-…`.
- Scheduled: create a Codex scheduled task for this project and ask it to run `$job-search`. Each user creates their own schedule; schedules are not stored in this repository.

Local scheduled work requires the computer and Codex desktop to be running.

## Public LinkedIn discovery

Run `npm run queries` to preview the exact discovery plan. It allocates the workbook's search budget across role families and produces a mix of public LinkedIn and canonical employer/ATS queries. LinkedIn discovery uses short title-only Boolean searches with exact phrases and uppercase `OR`, plus a seven-day freshness window by default and explicit remote or relocation lanes. Skills, technical context, exclusions, country eligibility, sponsorship, and relocation are evaluated after discovery so public indexing is not over-constrained.

Finder agents may read public LinkedIn job-detail pages without signing in. They record the query ID and LinkedIn job ID, classify unavailable or closed pages as expired, and resolve an employer or public ATS listing before judging whenever possible. The workflow never automates an authenticated LinkedIn session or submits an application.

Query-plan v4 supplies a deterministic public-source adapter registry for Ashby, Greenhouse, Workable, Lever, and SmartRecruiters. Adapters identify canonical hosts and published job IDs from public URLs only; they do not use private APIs, authenticated sessions, access-control bypasses, or submission endpoints. Listing status and eligibility always require page evidence and are never inferred from the URL.

Every new run records one attempt per generated query and attributes each discovery or scan event back to it. The updater persists query-level yields in `Query Metrics` and returns a funnel summary that distinguishes an adequate no-match run from no discoveries, partial query coverage, or insufficient deep evaluation.

`npm run recommend-budgets` reads only the rolling private run archives and compares conservative per-role utility after a minimum sample. It can recommend moving at most one query while preserving the total budget. Recommendations never apply themselves: the separate atomic writer requires `npm run apply-budget -- --recommendation state/RECOMMENDATION.json --approve QBUD-…` with the exact generated ID and rejects stale or modified evidence.

Each discovery payload also records the exact query plan, screening filters, relevant configuration, and evidence-snapshot identifiers. The updater stores immutable private input/result archives with a canonical replay hash. `npm run replay -- --input state/runs/RUN-ID.input.json` normalizes one run, while `npm run compare-runs -- --before-run RUN-A --after-run RUN-B --state-dir state` explains query, filter, evidence, count, and candidate-decision changes without rerunning searches or modifying the tracker.

## Eligibility evidence and lead monitoring

Run `npm run eligibility` to validate and preview the candidate-local eligibility registry. Entries cover hiring countries, remote regions, sponsorship, relocation, or work authorization and require a conservative scope, HTTPS citation, observation date, expiry date, confidence, and optional expiring human override. Only fresh, in-scope entries may be referenced. Stale or conflicting evidence never automatically rejects a job; conflicts go to `Eligibility Review`.

The weekly monitoring workflow gives `change_monitor` only `Shortlisted` and `Moved to Applications` roles. `npm run monitor -- --workbook Job_Application_Tracker.xlsx --input state/MONITOR.json --eligibility-registry profile/eligibility-evidence.json --state-dir state` atomically compares closure, location, work model, description, compensation, and eligibility. It records the latest snapshot in `Lead Monitor`, appends every check to `Scan Log`, and stops preparation for unavailable listings without regressing later application stages.

## Priority markets and company watchlists

Priority markets receive dedicated country-level LinkedIn searches while configured city aliases are included in canonical employer/ATS searches. The query builder still honors the workbook's maximum-search limit; increasing LinkedIn coverage replaces canonical queries instead of adding unbounded work.

The default template includes a Friday [Hiring Without Whiteboards](https://github.com/poteto/hiring-without-whiteboards) watchlist. It is a company and interview-process directory, not a vacancy feed. The finder checks at most the configured number of matching companies, follows public career links, and returns only active canonical vacancies. Directory interview details are stored as an explicitly unscored Notes signal and must be reverified during the application process.

## Useful commands

```sh
npm run config
npm run preflight
npm run upgrade-config
npm run pending
npm run dry-run -- --input state/RUN.json
npm run queries
npm run eligibility
npm run calibrate-judge
npm run recommend-budgets
npm test
npm run create-tracker
npm run migrate-tracker
npm run inspect -- Job_Application_Tracker.xlsx renders
npm run update -- --workbook Job_Application_Tracker.xlsx --input state/RUN.json --state-dir state
npm run monitor -- --workbook Job_Application_Tracker.xlsx --input state/MONITOR.json --eligibility-registry profile/eligibility-evidence.json --state-dir state
npm run actions -- --workbook Job_Application_Tracker.xlsx --state-dir state
npm run outcome -- --workbook Job_Application_Tracker.xlsx --input state/OUTCOME.json --state-dir state
npm run calibrate -- --workbook Job_Application_Tracker.xlsx
npm run tailor -- --input state/TAILORING.json --candidate-profile profile/candidate-profile.md --output application-packages/L-ID/tailoring.md
npm run compare-runs -- --before-run RUN-A --after-run RUN-B --state-dir state
npm run verify-public
```

## Application intelligence and operations

After `prepare L-…`, say `tailor L-…` for an advisory report. The read-only tailoring agent maps canonical job requirements and ATS keywords to stable candidate-evidence IDs, and the independent judge must approve every suggested bullet. The deterministic builder rejects unknown evidence, incomplete keyword coverage, and false approvals. It emits Markdown under the private application-packages directory but never edits the resume.

When the candidate reports a screening, interview, rejection, offer, withdrawal, acceptance, or ghosting outcome, say `outcome L-…`. Only explicitly confirmed events are recorded. The append-only history drives advisory conversion summaries by score band and resume; small samples are labeled insufficient and the system never changes weights, thresholds, queries, or resumes automatically.

`Action Dashboard` is refreshed by every supported writer and can be rebuilt with `npm run actions`. It lists work to perform manually; it never sends a follow-up, submits an application, resolves eligibility, or performs outreach.

Judge calibration uses only versioned synthetic fixtures. `npm run calibrate-judge` emits a blind packet that excludes baselines, expected ranges, and unsupported-claim traps. After `job_judge` returns one result per fixture, `npm run calibrate-judge -- --input state/JUDGE-CALIBRATION.json` checks score arithmetic, component and total ranges, required stable citations, unsupported claims, and drift from the baseline. It reports quality without changing scoring policy or candidate data.

## Application-form assistant

After `prepare L-…`, open the matching application page and say `form L-…`. The form agent inspects only the current step, extracts required-state evidence, drafts supported answers, and sends them to the independent judge. Salary, work authorization, sponsorship, relocation, sensitive demographic questions, attestations, and signatures remain manual unless the user has explicitly confirmed the exact answer.

Cover letters follow a strict gate: required fields receive a reviewed draft; optional, absent, or unclear fields do not. The workflow produces copy-ready responses but never populates the form, uploads files, advances a stateful step, or submits.

After manual submission, say `applied L-…`. The tracker records the date and follow-up without claiming that the agent submitted anything.

## Public-repository boundary

The repository contains only reusable code, schemas, templates, tests, project agents, and the generic skill. Git ignores the local configuration, live workbook, candidate profile, resumes, state, application packages, renders, PDFs, Word files, and spreadsheets. A pre-commit hook rejects those paths and common private-data patterns if they are staged accidentally.

Run `npm run install-skill` after pulling skill changes. It installs the generic skill into the current user's Codex skill directory.

GitHub CI runs the dependency-free contract suite on Node 20, 22, and 24. The full workbook integration suite remains a release gate in Codex because `@oai/artifact-tool` is a bundled private workspace dependency rather than a public npm dependency.

## Roadmap

See [ROADMAP.md](ROADMAP.md) for planned reliability, search-quality, ingestion, notification, and service-mode work.

## Releases

Releases follow [Semantic Versioning](https://semver.org/). See [CHANGELOG.md](CHANGELOG.md) for version history.

## License

Licensed under the [MIT License](LICENSE).
