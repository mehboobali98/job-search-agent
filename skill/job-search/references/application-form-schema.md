# Application-form packet schema

The orchestrator combines a read-only form-agent result and an independent judge review, then passes the exact JSON envelope to `scripts/record_form_packet.mjs`.

```json
{
  "schema_version": 1,
  "form": {
    "agent": "application_form_agent",
    "status": "Completed",
    "form_id": "FORM-YYYYMMDD-LEAD-STEP1",
    "lead_id": "L-…",
    "captured_at": "ISO-8601",
    "canonical_job_url": "Applications.Job Posting URL",
    "form_url": "live application-page URL",
    "ats": "Workable",
    "page_scope": "Current Step",
    "step": { "index": 1, "total": null, "title": "Application" },
    "fields": [
      {
        "field_id": "stable-page-field-id",
        "label": "Visible field label",
        "input_type": "text|textarea|email|tel|number|url|date|select|radio|checkbox|file|other",
        "required": true,
        "required_evidence": "required attribute and visible asterisk",
        "classification": "identity|contact|experience|technical|motivation|salary|availability|location|work_authorization|sponsorship|relocation|sensitive_demographic|legal_attestation|signature|resume_upload|other",
        "options": [],
        "character_limit": null,
        "proposed_status": "Ready|Needs User Input|Do Not Answer|Not Applicable",
        "proposed_response": "",
        "evidence_ids": [],
        "confidence": "High|Medium|Low",
        "user_confirmed": false,
        "notes": null
      }
    ],
    "cover_letter": {
      "detected": false,
      "field_id": null,
      "label": null,
      "requirement": "Required|Optional|Absent|Unclear",
      "requirement_evidence": "No cover-letter field is present on the inspected step",
      "input_type": "textarea|file|none|Unclear",
      "accepted_types": [],
      "proposed_status": "Ready|Needs User Input|Not Drafted",
      "proposed_text": null,
      "evidence_ids": [],
      "notes": null
    },
    "submission_control": { "detected": true, "label": "Submit application", "interacted": false },
    "notes": null
  },
  "review": {
    "agent": "job_judge",
    "status": "Completed",
    "reviewed_at": "ISO-8601",
    "fields": [
      {
        "field_id": "stable-page-field-id",
        "decision": "Accepted|Rewritten|Needs User Input|Do Not Answer|Not Applicable",
        "final_response": null,
        "supported_evidence_ids": [],
        "unsupported_evidence": false,
        "unsupported_details": null,
        "notes": null
      }
    ],
    "cover_letter": {
      "decision": "Not Applicable",
      "final_text": null,
      "supported_evidence_ids": [],
      "unsupported_evidence": false,
      "unsupported_details": null,
      "document_path": null,
      "notes": null
    },
    "notes": null
  }
}
```

Rules enforced by the deterministic validator:

- Every extracted field has exactly one judge result.
- Ready answers require evidence IDs and accepted or rewritten final text.
- Unsupported claims cannot be accepted.
- Sensitive, legal, and signature fields remain manual.
- Salary, availability, location, authorization, sponsorship, and relocation cannot be Ready without explicit user confirmation.
- Optional, absent, or unclear cover letters contain no draft or evidence IDs.
- Textarea responses and cover letters preserve paragraph and line breaks.
- A required file-upload cover letter needs a safe relative DOCX or PDF path inside that lead's directory under the configured application-packages directory.
- The form agent must report `submission_control.interacted: false`.
