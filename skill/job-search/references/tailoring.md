# Claim-safe tailoring

For `tailor L-…`, require a prepared application and the exact `Applications.Resume Version`. Supply the canonical job description and hash, selected resume, and configured candidate profile to the read-only `tailoring_agent`. Send its report to `job_judge` without a proposed approval decision. The judge independently audits every bullet against its cited candidate-evidence IDs.

Pass the combined schema-version-1 packet to `scripts/build_tailoring_report.mjs`. The deterministic builder rejects unknown evidence IDs, incomplete ATS keyword coverage, unsupported bullets, and false approvals. Store the resulting Markdown under the configured private application-packages directory. A tailoring report is advisory: it never edits a resume, populates a form, submits an application, or sends outreach.
