# Application outcomes and calibration

Use this workflow only when the user explicitly reports an application outcome. Resolve the prepared application from the configured tracker and do not infer an outcome from elapsed time, a missing reply, or a job-page change.

Create a schema-version-1 JSON event with a unique `event_id`, exact `lead_id`, ISO-8601 `occurred_at`, `outcome: Applied|Screening|Interview|Rejected|Offer|Withdrawn|Accepted|Ghosted`, the matching pipeline `stage`, optional reason category and notes, and `user_confirmed: true`. Call `scripts/record_application_outcome.mjs` with the configured workbook and state directory. The writer appends one immutable event, advances but never regresses the application stage, refreshes the derived Action Dashboard, and returns advisory calibration.

Use `scripts/calibrate_outcomes.mjs` for a read-only aggregate report. Treat groups with fewer than five applications as insufficient evidence. Calibration never changes Search Config, score weights, thresholds, resumes, or query allocations automatically.
