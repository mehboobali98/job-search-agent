# Changelog

All notable changes to this project will be documented here.

The project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/mehboobali98/job-search-agent/compare/v1.4.1...HEAD
[1.4.1]: https://github.com/mehboobali98/job-search-agent/compare/v1.4.0...v1.4.1
[1.4.0]: https://github.com/mehboobali98/job-search-agent/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/mehboobali98/job-search-agent/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/mehboobali98/job-search-agent/compare/v1.1.1...v1.2.0
[1.1.1]: https://github.com/mehboobali98/job-search-agent/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/mehboobali98/job-search-agent/releases/tag/v1.1.0
[1.0.0]: https://github.com/mehboobali98/job-search-agent/releases/tag/v1.0.0
