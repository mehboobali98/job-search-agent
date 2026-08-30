# Changelog

All notable changes to this project will be documented here.

The project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [2.6.0] - 2026-08-31

### Added

- Add backward-compatible private connector profile and sanitized binding version 2 contracts with per-destination `adapter_neutral_json_v1` or `slack_blocks_v1` rendering.
- Add deterministic bounded Slack Block Kit rendering over the unchanged sanitized connector-outbox request, with the native target retained only in the ignored private profile and represented in approved bindings by a hash.

### Changed

- Route connector previews and sends through the selected renderer while keeping credentials, endpoints, native targets, and rendered payloads out of previews, receipts, recovery markers, diagnostics, and public files.
- Preserve profile/binding version 1 behavior, configuration version 6, exact `NAPP-…` send approval, destination allowlisting, idempotency, bounded retries, and the adapter-neutral delivery-request contract.

## [2.5.0] - 2026-08-31

### Added

- Add a separate disabled-by-default authenticated provider-status boundary with private version-1 status profiles, exact sanitized `NSTATCON-…` binding imports, preview-by-default request plans, and one-attempt probes requiring explicit `--probe` plus exact `NSTAT-…` approval.
- Add strict provider response validation, append-only sanitized status observations, atomic persistence, and redacted pending recovery that can commit a confirmed observation without another network call.

### Changed

- Upgrade new private delivery-health reports to schema version 2 so read-only inspection can reconcile sanitized provider observations and status-probe recovery markers without reading profiles, endpoints, credentials, request items, response bodies, or candidate artifacts.
- Extend pending recovery, public privacy verification, CI, documentation, and the reusable skill while keeping configuration version 6 and the existing delivery request/send contracts unchanged.

## [2.4.0] - 2026-08-30

### Added

- Add a versioned privacy-minimized notification delivery-health report and read-only `npm run notify-health` inspector over bounded connector outbox requests, sanitized receipts, and redacted recovery markers.
- Add deterministic confirmed, rejected, unknown, deferred, queued, and stale classifications, hashed invalid/orphaned artifact references, strict conflict detection, and synthetic no-write coverage.

### Changed

- Centralize connector recovery-marker validation so live dispatch and health inspection share one strict contract, and extend CI, privacy verification, documentation, and the reusable skill for private health reports.
- Keep local configuration at version 6 while preserving versions 1 through 5; delivery-health thresholds are bounded inspection arguments and the maintainer's private version-5 configuration requires no migration.

## [2.3.0] - 2026-08-30

### Added

- Add an authenticated HTTPS JSON bearer connector runtime that consumes only the existing sanitized connector-outbox contract and requires a separate explicit `--send` plus the request's exact `NAPP-…` approval.
- Add private version-1 connector profiles, exact destination allowlisting, deterministic sanitized binding imports, bounded timeouts and request/response sizes, fixed retry schedules, stable idempotency keys, and redirect rejection.
- Add sanitized delivery receipts and redacted connector recovery markers, including confirmed-delivery receipt recovery without resending and synthetic transport coverage with no live account access.

### Changed

- Extend public privacy verification, pending recovery, CI contracts, documentation, roadmap, and the reusable skill so connector profiles, endpoints, credentials, bindings, receipts, request payloads, and candidate artifacts cannot enter the public tree.
- Keep local configuration at version 6: connector endpoints and credential sources live only in ignored private profiles, so versions 1 through 5 remain readable and no private config migration is required.

## [2.2.0] - 2026-08-30

### Added

- Add versioned, transport-neutral job-digest and notification-delivery request contracts built only from updater-returned alerts.
- Add disabled-by-default notification preferences with bounded destinations, per-channel score/item/resume controls, deterministic quiet-hour deferral, exact approval IDs, and privacy-minimized local previews.
- Add atomic private local-file and connector-outbox request creation, idempotency, redacted pending recovery, a connector capability boundary, and synthetic failure-recovery coverage.

### Changed

- Upgrade new local configurations to version 6 while preserving read compatibility for versions 1 through 5, and extend preflight, config export, privacy verification, CI contracts, documentation, roadmap, and the reusable job-search skill.

## [2.1.0] - 2026-08-30

### Added

- Add preview-by-default historical `.xlsx` import with compatible-tracker auto-mapping and a strict version-1 mapping contract for other workbook layouts.
- Add deterministic source/tracker duplicate reconciliation, explicit malformed/duplicate/conflict/limit classifications, privacy-safe hashed row references, and current-tracker-wins merge policy.
- Add verified atomic `--apply`, idempotent run logging, hash-checked pending recovery, bounded source limits, and synthetic workbook coverage for failure preservation and replay.

### Changed

- Extend public-repository privacy guards, CI contracts, reusable skill guidance, pending-marker inspection, README, and roadmap for private historical imports.

## [2.0.0] - 2026-08-30

### Added

- Add opt-in, disabled-by-default Gmail job-alert ingestion through a versioned transport-neutral message batch and sanitized discovery-proposal contract.
- Add plain-text and HTML link/metadata extraction, tracked-link unwrapping, existing canonical-source normalization, deterministic batch and tracker deduplication, and explicit malformed, unsupported, duplicate, stale, expired, extraction-failure, and limit classifications.
- Add a strict Gmail connector boundary limited to `gmail.readonly` message list/get operations, with no credential requirement for setup or tests and no send, delete, modify, label, archive, trash, or outreach capability.
- Add preview-by-default private imports, explicit atomic `--apply`, idempotent proposal storage, sanitized pending recovery, and public-repository protections for mail exports and real email addresses.
- Add synthetic fixtures and focused coverage for text, HTML, multiple/tracked links, privacy redaction, limits, idempotency, tracker reconciliation, and forced failure recovery.

### Changed

- Upgrade new local configurations to version 5 with bounded freshness, query, message, link, and sender-allowlist settings while retaining read compatibility for versions 1 through 4.
- Extend discovery attribution with the optional `gmail_alert_finder`; all accepted alert seeds still require public canonical verification, blind judging, and the existing deterministic tracker writer.
- Update the reusable skill, schemas, setup and upgrade guidance, roadmap, privacy verification, preflight, portable suite, and release documentation for the v2 ingestion boundary.

## [1.9.1] - 2026-08-30

### Fixed

- Accept tracker detail sheets only when they are referenced by the `Leads`, `Applications`, or `Scan Log` tables, preserving private role-detail worksheets without permitting unrelated schema drift.
- Recognize stable candidate-evidence IDs in either code or bold Markdown so existing valid profiles pass preflight without evidence rewrites.
- Report core and referenced-detail sheet counts separately in successful preflight results.

## [1.9.0] - 2026-08-30

### Added

- Add one guided preflight report for runtime dependencies, config freshness, the complete tracker contract, candidate evidence, resume inventory, search terms, eligibility evidence, private directories, and pending recovery state.
- Add read-only config-upgrade previews, explicit atomic upgrades with private backups and non-overwriting support-artifact initialization, isolated discovery dry-runs, and checksummed pending-marker inspection with guided extraction and replay commands.
- Add blind synthetic judge-calibration fixtures with deterministic eligibility, evidence-citation, unsupported-claim, arithmetic, score-range, and component/total drift checks.
- Add rolling per-role query-utility recommendations and a separate atomic workbook writer that accepts only an unchanged recommendation with the exact explicit approval ID.
- Add a portable CI matrix for Node.js 20, 22, and 24 while retaining the bundled workbook integration suite as a local release gate.

### Changed

- Upgrade new local configurations to schema version 4 with reliability controls while preserving read compatibility for versions 1 through 3.
- Preserve optional role-family attribution in query attempts and private run diagnostics so new evidence can support adaptive guidance without changing the public tracker schema.
- Extend the reusable skill, project agents, schemas, setup guide, privacy boundary, and recovery guidance for the v1.9 reliability workflow.

## [1.8.0] - 2026-08-29

### Added

- Add append-only, user-confirmed `Application Outcomes` tracking and advisory conversion calibration that never mutates scoring policy.
- Add a read-only `tailoring_agent`, complete ATS keyword coverage, stable candidate-evidence citations, independent judge review, and a deterministic claim-safe Markdown report builder.
- Add private deterministic discovery-run archives, canonical replay hashes, and read-only comparison across queries, filters, configuration, evidence, counts, and candidate decisions.
- Add a derived `Action Dashboard` for eligibility reviews, manual submissions, due follow-ups, and stale leads.

### Changed

- Refresh the action queue after every supported tracker writer and add both new sheets to fresh trackers and safe migrations.
- Extend the job-search skill, judge task modes, run schema, public documentation, and application operations for v1.8 workflows.

## [1.7.0] - 2026-08-29

### Added

- Add a candidate-local, cited, expiring eligibility-evidence registry with conservative scopes, freshness states, HTTPS citations, confidence, and expiring human overrides.
- Add deterministic registry assessment that ignores stale or out-of-scope entries and routes active conflicts to `Eligibility Review` without automatically rejecting roles.
- Add the read-only `change_monitor` agent and atomic `monitor_leads.mjs` workflow for closure, location, work-model, description, compensation, and eligibility changes.
- Add a migratable `Lead Monitor` tracker sheet for latest source-backed snapshots while preserving material change history in `Scan Log`.

### Changed

- Extend candidate setup and local configuration to include private eligibility evidence, while retaining backward compatibility with earlier configuration versions.
- Extend discovery and blind judging contracts with independently selected eligibility registry evidence IDs.

## [1.6.0] - 2026-08-29

### Added

- Add query-plan v4 with deterministic, public-read-only canonical-source adapters for Ashby, Greenhouse, Workable, Lever, and SmartRecruiters.
- Add canonical URL normalization, source identification, and published job-ID extraction without private APIs, authentication, access-control bypasses, or submission endpoints.
- Add a migratable `Eligibility Review` tracker sheet that persists strong unclear, eligibility-disagreement, and unsupported-evidence cases while preserving manual status and resolution fields.

### Changed

- Have the tracker updater annotate canonical-source evidence, infer missing public ATS job IDs, upsert review cases, and resolve open reviews when later eligibility evidence becomes decisive.

## [1.5.0] - 2026-08-29

### Added

- Add backward-compatible query-attempt attribution, deterministic funnel diagnostics, thin-coverage warnings, and persistent per-query metrics.
- Add a migratable `Query Metrics` tracker sheet with query, finder, source, lane, yield, blocker, expiry, and failure measurements.

## [1.4.1] - 2026-08-27

### Fixed

- Honor the configured IANA timezone when generating search plans and expose it in query-plan output.
- Remove the row-203 tracker ceiling with table-driven dashboard formulas and append-time formatting, validation, and conditional-format rules.
- Give malformed deep-evaluation scan flags a clear per-event validation error and document the count invariant.
- Preserve lead next actions during shortlist and dismiss actions, restore native Applications table banding, and render all strengths and gaps as bullets.
- Read run limits by Search Config label, synchronize the Judge Status list, and style Friday recheck audit rows consistently.
- Clean generated workbook inspection artifacts after every workflow and ignore all deterministic temporary workbook names.

## [1.4.0] - 2026-08-26

### Added

- Add query-plan v3 priority-market lanes, including country-level public LinkedIn searches and city aliases for canonical ATS discovery.
- Add bounded weekly company-watchlist queries, with Hiring Without Whiteboards available as a reusable public seed source.
- Persist watchlist interview-process context in tracker Notes as an explicitly unscored signal.

### Changed

- Increase the reusable template's LinkedIn share while preserving the configured 12-search ceiling by replacing canonical slots rather than adding searches.

## [1.3.0] - 2026-08-26

### Changed

- Introduce query-plan v2 with broad title-focused LinkedIn searches and move technical, exclusion, country-eligibility, sponsorship, and relocation checks into post-discovery screening.

## [1.2.0] - 2026-08-26

### Added

- Deterministic reusable search-query plans with candidate-local terms, public LinkedIn Boolean searches, freshness and location filters, and canonical employer/ATS fallback lanes.
- Query provenance for finder packets and scan events, including LinkedIn query and job IDs.

### Fixed

- Allow expiry rechecks to mark newly discovered and review-stage leads as expired while preserving dismissed and already-expired terminal states.

## [1.1.1] - 2026-08-25

### Fixed

- Preserve line breaks in long-form answers and cover letters, reconcile optional cover letters in Form Runs counts, and accept duplicate third-party select labels.
- Preserve post-application stages and manual edits when recording later salary or cover-letter details.
- Reject missing CLI option values and non-`.xlsx` workbook targets before any mutation.
- Roll back staged form packets when workbook commit fails, clear stale pending markers, and keep required cover-letter files scoped to their lead.
- Remove dead alert-selection logic, avoid repeated full-table scans while appending run rows, and apply Form Runs validation to rows beyond the original template range.
- Make dashboard refreshes use verified atomic workbook replacement with a recoverable pending marker.

## [1.1.0] - 2026-08-24

### Added

- Public roadmap covering near-term reliability work and longer-term ingestion, notification, and service-mode plans.
- Read-only `application_form_agent` with independent answer review through `job_judge`.
- Strict application-form and cover-letter schemas that reject unsupported claims, sensitive-field inference, and optional cover-letter drafts.
- Private validated response packets, the `Form Runs` tracker sheet, tracker migration, and reusable form-recording scripts.
- Deterministic `applied` lead action with idempotent submission, salary, cover-letter, and follow-up tracking.

### Changed

- New tracker rows now preserve the established Arial 9, wrapped, bordered table-body convention and expose the selected resume throughout preparation.
- Public-repository validation now checks tracked and untracked working-tree files while private configuration, resumes, workbooks, state, and application packets remain ignored.

## [1.0.0] - 2026-08-24

### Added

- Parallel backend/leadership and AI/product discovery agents.
- Independent blind LLM judging with deterministic eligibility and alert gates.
- Six-sheet Excel tracker with dashboard, leads, applications, scan audit, and run health.
- Atomic workbook updates, lead actions, Friday expiry rechecks, and repeated-alert protection.
- Candidate-local configuration, profile and resume templates, and privacy-focused Git protections.
- Reusable `$job-search` skill with one-command candidate setup.
- Automated integration coverage for deduplication, eligibility, judge failures, alerts, locks, and expiry handling.
- MIT License.

[Unreleased]: https://github.com/mehboobali98/job-search-agent/compare/v2.6.0...HEAD
[2.6.0]: https://github.com/mehboobali98/job-search-agent/compare/v2.5.0...v2.6.0
[2.5.0]: https://github.com/mehboobali98/job-search-agent/compare/v2.4.0...v2.5.0
[2.4.0]: https://github.com/mehboobali98/job-search-agent/compare/v2.3.0...v2.4.0
[2.3.0]: https://github.com/mehboobali98/job-search-agent/compare/v2.2.0...v2.3.0
[2.2.0]: https://github.com/mehboobali98/job-search-agent/compare/v2.1.0...v2.2.0
[2.1.0]: https://github.com/mehboobali98/job-search-agent/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/mehboobali98/job-search-agent/compare/v1.9.1...v2.0.0
[1.9.1]: https://github.com/mehboobali98/job-search-agent/compare/v1.9.0...v1.9.1
[1.9.0]: https://github.com/mehboobali98/job-search-agent/compare/v1.8.0...v1.9.0
[1.8.0]: https://github.com/mehboobali98/job-search-agent/compare/v1.7.0...v1.8.0
[1.7.0]: https://github.com/mehboobali98/job-search-agent/compare/v1.6.0...v1.7.0
[1.6.0]: https://github.com/mehboobali98/job-search-agent/compare/v1.5.0...v1.6.0
[1.5.0]: https://github.com/mehboobali98/job-search-agent/compare/v1.4.1...v1.5.0
[1.4.1]: https://github.com/mehboobali98/job-search-agent/compare/v1.4.0...v1.4.1
[1.4.0]: https://github.com/mehboobali98/job-search-agent/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/mehboobali98/job-search-agent/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/mehboobali98/job-search-agent/compare/v1.1.1...v1.2.0
[1.1.1]: https://github.com/mehboobali98/job-search-agent/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/mehboobali98/job-search-agent/releases/tag/v1.1.0
[1.0.0]: https://github.com/mehboobali98/job-search-agent/releases/tag/v1.0.0
