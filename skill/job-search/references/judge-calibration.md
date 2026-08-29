# Judge calibration

Judge calibration is a read-only quality check built from synthetic public fixtures. It never uses the configured candidate profile, resumes, workbook, run history, or live job data, and it never rewrites scoring policy.

Run `npm run calibrate-judge` to produce a blind packet. Give that packet unchanged to `job_judge` with `task_mode: calibration`. The judge must return:

```json
{
  "schema_version": 1,
  "calibration_id": "the exact packet calibration_id",
  "results": [
    {
      "fixture_id": "one supplied fixture ID",
      "listing_status": "Active | Expired | Inaccessible",
      "eligibility": "Eligible | Unclear | Ineligible",
      "scores": {
        "responsibilities": 0,
        "technical": 0,
        "seniority": 0,
        "evidence": 0,
        "domain": 0,
        "location": 0,
        "compensation": 0
      },
      "final_score": 0,
      "cited_evidence_ids": [],
      "strengths": [],
      "gaps": [],
      "unsupported_evidence": false
    }
  ]
}
```

Return exactly one result for every fixture. Cite only IDs supplied in that fixture. Job requirements are not candidate evidence. Do not infer listing activity, eligibility, technologies, scale, metrics, or production experience.

Save the judge envelope to a private temporary or state file, then run `npm run calibrate-judge -- --input <results.json>`. The deterministic evaluator checks listing and eligibility decisions, component and total ranges, exact arithmetic, required citations, unsupported-claim traps, and drift from the versioned baseline. A failed fixture is diagnostic; it does not alter weights, thresholds, queries, resumes, or any candidate record.
