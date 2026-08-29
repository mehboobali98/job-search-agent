# Roadmap

This roadmap describes the intended direction of the project. Priorities may change as real usage and evidence improve the design; a listed item is not a delivery promise.

## Product principles

- Keep candidate evidence private and local by default.
- Never invent candidate experience or submit applications automatically.
- Keep discovery and judging agents read-only.
- Preserve a single deterministic write boundary for tracker updates.
- Prefer canonical employer sources and auditable decisions.
- Make partial failures visible instead of silently dropping jobs.

## v1.0 — Reusable local workflow

Status: released.

- Parallel discovery for backend/leadership and AI/product role families.
- Independent blind LLM judging with deterministic eligibility and alert gates.
- Six-sheet Excel tracker, atomic updates, lead actions, and Friday expiry checks.
- Candidate-local setup, reusable Codex skill, privacy guard, and integration tests.

## v1.1 — Application assistance

Status: released.

- Read-only application-form inspection with evidence-backed response drafting and independent review.
- Required-only cover-letter detection and generation, with optional and ambiguous fields deliberately skipped.
- Private form packets, compact `Form Runs` tracking, multi-step reinspection, and a deterministic `applied` action.
- Consistent tracker-row formatting and explicit resume guidance through the preparation workflow.

## v1.2 — Onboarding and reliability

Status: planned.

- Guided dependency and workspace setup for a fresh clone.
- Candidate-profile and resume-inventory validation before the first search.
- Dry-run mode that produces a proposed run payload without changing the tracker.
- Clearer run diagnostics, recovery instructions, and pending-update handling.
- Versioned local configuration with safe upgrade checks.
- Continuous integration across supported Node.js versions.

## v1.3 — Search and evaluation quality

Status: partially delivered in v1.3.0.

- Reusable candidate-local query packs with broad title-first public LinkedIn searches and post-discovery fit screening are implemented; the first deterministic public ATS adapters shipped in v1.6.0.
- Better source-health, freshness, canonicalization, and description-change signals.
- Evaluation fixtures for judge calibration, eligibility disagreements, and score drift.
- Explainable score breakdowns with tighter links between job evidence and candidate evidence IDs.
- Search-quality metrics that support evidence-based query and threshold tuning.

## v1.4 — Priority markets and curated company discovery

Status: released in v1.4.0.

- Dedicated, budget-preserving priority-market lanes with country searches and city aliases.
- Explicit UAE and Saudi Arabia coverage in the maintainer's candidate-local configuration.
- Bounded weekly company-watchlist sources that require active canonical vacancies.
- Unscored interview-process signals recorded in tracker Notes with freshness caveats.
- Additional public-source adapters remain future work and must preserve the canonical-source and access-control policies established in v1.6.0.

## v1.5 — Search observability and recall

Status: partially delivered in v1.5.0.

- Search-funnel diagnostics from attempted query through discovery, deduplication, deep evaluation, judging, eligibility, and alerting are implemented.
- Persistent per-query and per-source effectiveness metrics, including duplicate, blocker, expiry, and priority-lead yields, are implemented.
- Explicit thin-coverage and no-discovery signals are implemented so an empty digest is never presented as evidence that no suitable jobs exist.
- Deterministic query-budget recommendations based on rolling evidence remain planned; configuration changes will remain user-controlled.
- Deterministic public ATS adapters for Ashby, Greenhouse, Workable, Lever, and SmartRecruiters are implemented in v1.6.0; additional adapters remain evidence-driven future work.

## v1.6 — Eligibility review inbox

Status: released in v1.6.0.

- A persistent, idempotent review inbox for strong roles blocked by unclear eligibility, finder/judge disagreement, or unsupported candidate evidence is implemented. User-entered review status and resolution are preserved.

## v1.7 — Eligibility evidence and change monitoring

Status: released in v1.7.0.

- A candidate-local, cited, expiring eligibility-evidence registry for hiring countries, remote regions, sponsorship, relocation, and work authorization, with scoped and expiring human overrides.
- Conservative registry matching that excludes stale, superseded, and out-of-scope evidence and routes conflicts to human review instead of auto-rejecting roles.
- Weekly source-backed monitoring for shortlisted and prepared roles, including closure, location, work model, description, compensation, and eligibility changes.
- A latest-snapshot `Lead Monitor` sheet with append-only material-change history in `Scan Log` and preparation-safe closure handling.

## v1.8 — Application intelligence and operations

Status: planned.

- Outcome-driven calibration across applications, screenings, interviews, and rejections without automatically rewriting scoring policy.
- Claim-safe tailoring reports with ATS keyword coverage, evidence-backed bullet selection, gaps, and prohibited unsupported claims.
- Deterministic run replay and comparison explaining changes in queries, filters, evidence, and decisions.
- An action dashboard for reviews, manual submissions, follow-ups, stale leads, and unresolved eligibility questions.

## v2 — Opt-in ingestion and notifications

Status: exploratory.

- Gmail job-alert ingestion as an optional discovery source.
- Configurable digest destinations and external notification adapters.
- Historical tracker import with validation and duplicate reconciliation.
- User-defined schedules, quiet hours, and per-channel alert preferences.

## v3 — Service mode

Status: exploratory.

- Always-on scheduler and policy-compliant public-source crawler.
- Database-backed history, API, and web dashboard.
- Source adapter health monitoring and queued retries.
- Strictly isolated multi-candidate deployments.
- Operational observability, backups, and deployment documentation.

## Explicit non-goals

- Automatic job applications or application submission.
- Automatic recruiter outreach or candidate impersonation.
- Authenticated scraping that bypasses a source's access controls or terms.
- Candidate claims inferred from job descriptions or unsupported evidence.

## Contributing

Open an [issue](https://github.com/mehboobali98/job-search-agent/issues) for bugs, proposals, or roadmap feedback. A useful proposal explains the user problem, privacy impact, deterministic behavior, failure handling, and how the change can be tested.
