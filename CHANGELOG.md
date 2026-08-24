# Changelog

All notable changes to this project will be documented here.

The project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/mehboobali98/job-search-agent/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/mehboobali98/job-search-agent/releases/tag/v1.1.0
[1.0.0]: https://github.com/mehboobali98/job-search-agent/releases/tag/v1.0.0
