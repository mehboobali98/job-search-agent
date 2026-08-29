# Eligibility evidence and lead monitoring

## Registry

The candidate-local registry is resolved from `eligibility_evidence_path` and validated by `scripts/export_eligibility_evidence.mjs`. Registry version 1 contains `entries[]`. Every entry has:

- a unique lowercase-slug `id`;
- `topic`: `Hiring country|Remote region|Sponsorship|Relocation|Work authorization`;
- `applies_to`, either `{ global: true }` or one or more exact company, location, or source scopes;
- `conclusion`: `Supports|Blocks|Unclear`, a concise statement, and an HTTPS citation;
- `observed_at`, `expires_at`, `confidence: High|Medium|Low`, and `status: Active|Superseded`;
- optional `override` with conclusion, reason, confirmation date, and expiry date.

Use only `active_entries` from the exported snapshot. An entry must be fresh and match every populated scope dimension before an agent references its ID. Expired, superseded, or out-of-scope evidence may explain uncertainty but cannot decide eligibility. Current canonical-vacancy evidence takes precedence. A registry conflict converts the candidate to `Needs Human Review`; it never automatically makes a role Ineligible. Human overrides are explicit, expiring candidate confirmations, not permission to invent policy.

Finders return `finder_eligibility_evidence_ids`. Blind the judge from those IDs while supplying the full active registry snapshot. The judge independently returns `judge_eligibility_evidence_ids`. The orchestrator combines the two lists into stable unique `eligibility_evidence_ids` on the updater candidate. Pass `--eligibility-registry` only when the configured file exists; a missing registry means the run has no reusable registry evidence.

## Lead monitoring

On the configured weekly monitoring run, select only leads whose tracker status is `Shortlisted` or `Moved to Applications`. Give `change_monitor` the exact lead IDs, canonical URLs, prior tracker values, and active registry snapshot. Require one check per supplied lead.

An active check contains lead ID, canonical URL, `listing_status: Active`, source evidence, exact location and work type, normalized job description and its matching SHA-256 hash, `{ published, text }` compensation, `eligibility`, eligibility evidence, and applicable fresh registry IDs. An unavailable check contains lead ID, canonical URL, `listing_status: Expired|Inaccessible`, and source evidence.

The orchestrator passes the complete envelope to `scripts/monitor_leads.mjs` with the workbook, state directory, and registry path when present. This is the only monitoring write path. It compares the new snapshot deterministically, updates the latest `Lead Monitor` row, appends every examination to `Scan Log`, updates current lead facts, records registry conflicts in `Eligibility Review`, and stops preparation for unavailable listings. It does not regress an application beyond `Preparing` or overwrite review Status/Resolution fields.

Report material changes separately from the normal priority digest. Include lead ID, company, role, changed fields, concise before/after summary, and canonical URL. A no-change monitoring run is successful and should be summarized compactly.
