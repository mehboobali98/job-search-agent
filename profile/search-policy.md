# Search policy

These are the V1 defaults. At run time, the workbook `Search Config` sheet is authoritative for limits, thresholds, role allocations, and policy rows. The ignored `.job-search.local.json` file is authoritative for the candidate's timezone, target geography, and artifact paths. Export both with `scripts/export_search_config.mjs` and pass the result to every finder and the judge. The seven scoring maxima remain the fixed V1 rubric.

## Schedule and limits

- Run every weekday at 08:00 in the configured candidate timezone.
- Use at most 12 targeted searches per run.
- Normalize at most 40 unique candidates.
- Deeply evaluate at most 20 candidates.
- Judge at most 10 preliminary candidates scoring 70 or higher.
- Alert on at most 5 judged jobs scoring 80 or higher with Medium or High confidence.

## Role allocation

| Profile | Allocation |
|---|---:|
| Backend / Platform | 50% |
| Staff / Principal / Tech Lead | 20% |
| Applied AI / LLM | 15% |
| Developer Productivity / AI Enablement | 10% |
| Full-stack / Product | 5% |

Backend and leadership searches belong to `backend_finder`. AI, developer-productivity, and selective full-stack searches belong to `ai_product_finder`.

## Geography

Include:

- genuinely worldwide remote roles;
- roles explicitly open to the candidate's configured country or region;
- international roles with stated relocation or work-permit sponsorship;
- strong roles where sponsorship is unclear but plausible, marked `Unclear`.

Suppress:

- roles explicitly limited to residents of an unsupported country;
- roles requiring existing local work authorization when sponsorship is unavailable;
- remote roles restricted to countries outside the configured geography with no relocation path.

## Sources

Prefer employer career pages and canonical ATS listings. Public aggregators may be used to discover a role, but the canonical listing should be opened before judging whenever possible.

Query-plan v4 supplies the recognized public ATS adapter registry for Ashby, Greenhouse, Workable, Lever, and SmartRecruiters. Use it only to identify canonical hosts, normalize public URLs, and extract published job IDs. Record the adapter and an evidence-backed source status in retained packets. Never use private APIs, authenticated sessions, access-control bypasses, or application submission endpoints, and never infer listing activity or eligibility from URL shape.

Public LinkedIn discovery is supported through the deterministic plan produced by `npm run queries`. LinkedIn queries are deliberately broad and title-focused, using straight-quoted title phrases with uppercase `OR`, parentheses, date freshness, location, and remote-work filters. Skills, technical context, exclusions, seniority, country eligibility, sponsorship, and relocation are applied after a vacancy is discovered; do not add them back into the public discovery query. Finder agents may read public job-detail pages without signing in. They must record the query ID and LinkedIn job ID, reject 404/410 or no-longer-accepting pages, and resolve the employer or ATS listing before judging whenever it exists. A LinkedIn-only lead cannot receive High source confidence under the canonical-source policy.

Candidate-local priority markets receive dedicated country-level LinkedIn lanes. Their configured city aliases are added to canonical employer/ATS discovery and post-discovery screening, while the LinkedIn title query itself remains broad. The query plan must stay within the workbook's maximum-search budget.

Public company directories may be configured as bounded weekly watchlists. A directory entry is only a company seed and never proves that a vacancy exists. The finder must follow the public careers link, inspect at most the configured company cap, and return only active canonical vacancies that pass the normal screening rules. Interview-process information from a directory is recorded in Notes as an unscored, potentially stale signal; it does not affect eligibility, confidence, or fit scoring.

Do not automate authenticated LinkedIn use, bypass access controls, populate forms, or submit applications.

## Scoring

| Component | Maximum |
|---|---:|
| Core responsibilities | 25 |
| Technical fit and transferability | 20 |
| Seniority and scope | 15 |
| Strength of verified evidence | 15 |
| Domain and product fit | 10 |
| Location, sponsorship, and work model | 10 |
| Compensation alignment | 5 |

Unknown compensation receives 3/5. There is no hard compensation floor.

Recommendation bands: 90-100 Immediate priority; 80-89 Strong match; 70-79 Review; 60-69 Stretch/watchlist; below 60 Suppressed.

## Alert repetition

Do not alert a previously alerted job unless it crosses 80, eligibility improves, or a material description change moves the judged score by at least 5 points. On Fridays, recheck active shortlisted leads and mark closed listings expired.
