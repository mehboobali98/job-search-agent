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

Status: delivered across v1.2.0 and v1.9.0.

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
- Evaluation fixtures for blind judge calibration, eligibility decisions, unsupported claims, and score drift are implemented in v1.9.0.
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
- Deterministic query-budget recommendations based on rolling evidence are implemented in v1.9.0; configuration changes require an exact explicit approval ID.
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

Status: released in v1.8.0.

- Append-only, user-confirmed application outcomes and advisory conversion calibration by score band and resume, with explicit small-sample warnings and no automatic policy mutation.
- Claim-safe tailoring reports with complete ATS keyword coverage, stable candidate-evidence citations, gaps, prohibited claims, and independent judge approval.
- Private deterministic run archives, canonical replay hashes, and read-only comparison of queries, filters, configuration, evidence, counts, and candidate decisions.
- A derived `Action Dashboard` for eligibility reviews, manual submissions, due follow-ups, and stale leads; every listed external action remains manual.

## v1.9 — Reliability and adaptive search guidance

Status: released in v1.9.0, with compatibility fixes in v1.9.1.

- Guided dependency, twelve-sheet tracker, candidate-profile, eligibility, and resume-inventory validation for fresh clones.
- Isolated dry-run discovery payloads, checksummed pending-update recovery guidance, and explicitly applied versioned configuration upgrades with private backups.
- Blind synthetic judge-calibration fixtures and component/total score-drift reports tied to stable job and candidate evidence.
- Rolling evidence-based, one-query budget recommendations with a separate atomic writer that requires the exact user-approved recommendation ID.
- Portable continuous integration across Node.js 20, 22, and 24, with the bundled workbook suite retained as a local release gate.
- Referenced private role-detail sheets and existing bold-formatted evidence IDs are accepted without weakening the core tracker or evidence contracts.

## v2 — Opt-in ingestion and notifications

Status: Gmail ingestion released in v2.0.0, historical tracker import released in v2.1.0, notification preferences released in v2.2.0, bounded authenticated live connector support released in v2.3.0, read-only delivery-health monitoring released in v2.4.0, provider-status reconciliation released in v2.5.0, native Slack rendering released in v2.6.0, network-free private capability import with catalog-to-binding drift inspection released in v2.7.0, sanitized catalog-history comparison released in v2.8.0, and read-only catalog-to-profile authoring plans released in v2.9.0. Remaining items are exploratory.

- Optional Gmail job-alert ingestion is implemented with a transport-neutral versioned batch, read-only connector contract, synthetic and private batch inputs, sanitized provenance, explicit classifications, tracker-aware deduplication, preview-by-default behavior, and atomic apply recovery.
- Configurable digest destinations are implemented with a versioned privacy-minimized digest, local private-file delivery, and an adapter-neutral connector outbox. A separately disabled HTTPS JSON bearer consumer adds private hash-bound profiles, exact destination allowlisting, explicit send approval, bounded deterministic retries, stable idempotency keys, sanitized receipts, and redacted recovery without changing the outbox contract. Backward-compatible profile version 2 additionally supports deterministic Slack Block Kit rendering with a private hash-bound target.
- Historical tracker import is implemented with read-only `.xlsx` sources, a versioned mapping contract, privacy-safe previews, deterministic validation and duplicate reconciliation, current-tracker-wins conflict policy, and atomic explicit apply with recovery.
- Quiet hours and bounded per-channel score, item, and resume preferences are implemented; user-defined schedules remain future work.
- A separate provider-status boundary previews and imports sanitized status bindings, requires exact `NSTAT-…` approval plus explicit `--probe` for one authenticated read-only HTTPS attempt, validates a strict connector-neutral response, writes only sanitized observations, and recovers without automatic retry or notification delivery.
- Read-only delivery-health monitoring validates bounded private outbox, sanitized receipt/provider-observation, and redacted recovery artifacts; classifies confirmed, rejected, unknown, deferred, queued, and stale requests; reports only opaque identifiers and hashed artifact references; and never loads profiles or credentials, invokes a connector, writes state, or retries delivery.
- Network-free connector discovery imports a strict capability export produced outside the repository, removes account identifiers, target labels, and native targets, and persists only an exact-approved private catalog of deterministic target hashes and supported operations/renderers. It never authenticates, invokes a connector, changes a profile, or sends.
- Read-only catalog-to-binding drift inspection compares only sanitized private artifacts, recognizes exact hash-bound native-target compatibility, fails closed on connection/channel/renderer/target drift, and requires manual review where version-1 or adapter-neutral bindings intentionally lack a target hash. Reports omit target hashes and never authorize delivery.
- Read-only catalog-history comparison detects semantic target and capability changes across two sanitized imports while ignoring export/catalog identity churn. It requires the same connection and chronological ordering, replaces target IDs/hashes with opaque comparison references, writes nothing, and never authorizes delivery.
- Read-only catalog-to-profile planning requires an exact sanitized target, configured connector destination, and explicit renderer. It emits only a disabled version-2 authoring plan with safe bounded policy defaults and manual-input requirements, preserves adapter-neutral target uncertainty, and never creates a profile, issues an approval, or authorizes delivery.
- Provider-specific OAuth refresh, live account enumeration/export adapters, private profile generation/editing, and additional connector-native renderers remain future work and must preserve the private profile, exact approval, and sanitized outbox/status boundaries.

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
