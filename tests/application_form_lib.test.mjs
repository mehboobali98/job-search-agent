import test from "node:test";
import assert from "node:assert/strict";
import {
  applicationFormSummary,
  validateApplicationFormPacket,
} from "../scripts/application_form_lib.mjs";

function basePacket() {
  return {
    schema_version: 1,
    form: {
      agent: "application_form_agent",
      status: "Completed",
      form_id: "FORM-20260101-TEST-STEP1",
      lead_id: "L-TEST-001",
      captured_at: "2026-01-01T10:00:00Z",
      canonical_job_url: "https://jobs.example.test/fixture-role",
      form_url: "https://apply.example.test/fixture-role",
      ats: "Example ATS",
      page_scope: "Current Step",
      step: { index: 1, total: null, title: "Application" },
      fields: [
        {
          field_id: "rails_experience",
          label: "Describe your Rails experience",
          input_type: "textarea",
          required: true,
          required_evidence: "required attribute",
          classification: "experience",
          options: [],
          character_limit: 500,
          proposed_status: "Ready",
          proposed_response: "I have five years of production Rails experience.",
          evidence_ids: ["E-BE-01"],
          confidence: "High",
          user_confirmed: false,
          notes: null,
        },
        {
          field_id: "salary",
          label: "Monthly salary expectation",
          input_type: "text",
          required: true,
          required_evidence: "visible required marker",
          classification: "salary",
          options: [],
          character_limit: null,
          proposed_status: "Needs User Input",
          proposed_response: null,
          evidence_ids: [],
          confidence: "Low",
          user_confirmed: false,
          notes: "Candidate must confirm the amount.",
        },
      ],
      cover_letter: {
        detected: false,
        field_id: null,
        label: null,
        requirement: "Absent",
        requirement_evidence: "No cover-letter field found on this step",
        input_type: "none",
        accepted_types: [],
        proposed_status: "Not Drafted",
        proposed_text: null,
        evidence_ids: [],
        notes: null,
      },
      submission_control: { detected: true, label: "Submit application", interacted: false },
      notes: null,
    },
    review: {
      agent: "job_judge",
      status: "Completed",
      reviewed_at: "2026-01-01T10:05:00Z",
      fields: [
        {
          field_id: "rails_experience",
          decision: "Accepted",
          final_response: "I have five years of production Rails experience.",
          supported_evidence_ids: ["E-BE-01"],
          unsupported_evidence: false,
          unsupported_details: null,
          notes: null,
        },
        {
          field_id: "salary",
          decision: "Needs User Input",
          final_response: null,
          supported_evidence_ids: [],
          unsupported_evidence: false,
          unsupported_details: null,
          notes: "Confirm the amount.",
        },
      ],
      cover_letter: {
        decision: "Not Applicable",
        final_text: null,
        supported_evidence_ids: [],
        unsupported_evidence: false,
        unsupported_details: null,
        document_path: null,
        notes: null,
      },
      notes: null,
    },
  };
}

test("validates reviewed form answers and recomputes the summary", () => {
  const packet = validateApplicationFormPacket(basePacket());
  assert.deepEqual(applicationFormSummary(packet), {
    fields: 2,
    ready: 1,
    needs_input: 1,
    manual: 0,
    not_applicable: 0,
    cover_letter_requirement: "Absent",
    cover_letter_status: "Not present",
    review_status: "Needs User Input",
  });
});

test("rejects an optional cover-letter draft", () => {
  const packet = basePacket();
  packet.form.cover_letter = {
    detected: true,
    field_id: "cover_letter",
    label: "Cover letter (optional)",
    requirement: "Optional",
    requirement_evidence: "Label says optional",
    input_type: "textarea",
    accepted_types: [],
    proposed_status: "Ready",
    proposed_text: "A draft that should not exist.",
    evidence_ids: ["E-BE-01"],
    notes: null,
  };
  assert.throws(() => validateApplicationFormPacket(packet), /must not be drafted/);
});

test("rejects sensitive fields that the agent tries to answer", () => {
  const packet = basePacket();
  packet.form.fields[1] = {
    ...packet.form.fields[1],
    field_id: "demographic",
    label: "Demographic information",
    classification: "sensitive_demographic",
    proposed_status: "Ready",
    proposed_response: "Inferred answer",
    evidence_ids: ["E-FAKE"],
  };
  packet.review.fields[1] = {
    ...packet.review.fields[1],
    field_id: "demographic",
    decision: "Accepted",
    final_response: "Inferred answer",
    supported_evidence_ids: ["E-FAKE"],
  };
  assert.throws(() => validateApplicationFormPacket(packet), /must remain manual/);
});

test("rejects accepted answers with unsupported evidence", () => {
  const packet = basePacket();
  packet.review.fields[0].unsupported_evidence = true;
  packet.review.fields[0].unsupported_details = "The duration is not supported.";
  assert.throws(() => validateApplicationFormPacket(packet), /cannot be accepted/);
});

test("requires a document for a required cover-letter upload", () => {
  const packet = basePacket();
  packet.form.cover_letter = {
    detected: true,
    field_id: "cover_letter",
    label: "Cover letter",
    requirement: "Required",
    requirement_evidence: "required attribute",
    input_type: "file",
    accepted_types: [".docx", ".pdf"],
    proposed_status: "Ready",
    proposed_text: "Evidence-backed required cover letter.",
    evidence_ids: ["E-BE-01"],
    notes: null,
  };
  packet.review.cover_letter = {
    decision: "Accepted",
    final_text: "Evidence-backed required cover letter.",
    supported_evidence_ids: ["E-BE-01"],
    unsupported_evidence: false,
    unsupported_details: null,
    document_path: null,
    notes: null,
  };
  assert.throws(() => validateApplicationFormPacket(packet), /document_path is required/);
});

test("preserves line breaks in textarea answers and required cover letters", () => {
  const packet = basePacket();
  const answer = "First paragraph.\n\nSecond paragraph.\nFinal line.";
  const letter = "Dear Hiring Team,\n\nI build reliable backend systems.\n\nBest,\nCandidate";
  packet.form.fields[0].proposed_response = answer;
  packet.review.fields[0].final_response = answer;
  packet.form.cover_letter = {
    detected: true,
    field_id: "cover_letter",
    label: "Cover letter",
    requirement: "Required",
    requirement_evidence: "required attribute",
    input_type: "textarea",
    accepted_types: [],
    proposed_status: "Ready",
    proposed_text: letter,
    evidence_ids: ["E-BE-01"],
    notes: null,
  };
  packet.review.cover_letter = {
    decision: "Accepted",
    final_text: letter,
    supported_evidence_ids: ["E-BE-01"],
    unsupported_evidence: false,
    unsupported_details: null,
    document_path: null,
    notes: null,
  };
  const validated = validateApplicationFormPacket(packet);
  assert.equal(validated.form.fields[0].proposed_response, answer);
  assert.equal(validated.review.fields[0].final_response, answer);
  assert.equal(validated.form.cover_letter.proposed_text, letter);
  assert.equal(validated.review.cover_letter.final_text, letter);
});

test("counts a detected optional cover letter as not applicable", () => {
  const packet = basePacket();
  packet.form.cover_letter = {
    detected: true,
    field_id: "cover_letter",
    label: "Cover letter (optional)",
    requirement: "Optional",
    requirement_evidence: "Label says optional",
    input_type: "textarea",
    accepted_types: [],
    proposed_status: "Not Drafted",
    proposed_text: null,
    evidence_ids: [],
    notes: null,
  };
  const validated = validateApplicationFormPacket(packet);
  const summary = applicationFormSummary(validated);
  assert.equal(summary.fields, 3);
  assert.equal(summary.ready + summary.needs_input + summary.manual + summary.not_applicable, summary.fields);
  assert.equal(summary.not_applicable, 1);
});

test("retains duplicate option labels from third-party forms", () => {
  const packet = basePacket();
  packet.form.fields[0].input_type = "select";
  packet.form.fields[0].options = ["Other", "Other"];
  const validated = validateApplicationFormPacket(packet);
  assert.deepEqual(validated.form.fields[0].options, ["Other", "Other"]);
});
