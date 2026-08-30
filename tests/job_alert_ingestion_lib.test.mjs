import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  assertSanitizedJobAlertProposal,
  ingestJobAlertBatch,
  JOB_ALERT_CLASSIFICATIONS,
  unwrapTrackedJobUrl,
  validateJobAlertBatchEnvelope,
} from "../scripts/job_alert_ingestion_lib.mjs";

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const NOW = "2026-08-30T08:00:00Z";

function config(overrides = {}) {
  return {
    enabled: true,
    read_only: true,
    query: "label:fictional-alerts newer_than:7d",
    freshness_hours: 168,
    max_messages: 50,
    max_links_per_message: 20,
    sender_allowlist: ["notifications.example.test"],
    ...overrides,
  };
}

function message(overrides = {}) {
  return {
    message_id: "synthetic-message-1",
    received_at: "2026-08-30T07:00:00Z",
    from: "Fictional Alerts <alerts@notifications.example.test>",
    subject: "Fictional role",
    text_body: "Company: Fictional Systems\nRole: Senior Backend Engineer\nLocation: Worldwide remote\nhttps://jobs.ashbyhq.com/fictional/role-1",
    ...overrides,
  };
}

function batch(messages, overrides = {}) {
  return {
    schema_version: 1,
    batch_id: "synthetic-batch-1",
    transport: { provider: "gmail", access_mode: "read_only", query: "label:fictional-alerts newer_than:7d" },
    retrieved_at: NOW,
    messages,
    ...overrides,
  };
}

test("extracts text metadata, unwraps tracked URLs, and uses canonical adapters", () => {
  const tracked = "https://www.google.com/url?q=https%3A%2F%2Fjob-boards.greenhouse.io%2Ffictional%2Fjobs%2F12345%3Futm_source%3Dmail";
  assert.equal(unwrapTrackedJobUrl(tracked), "https://job-boards.greenhouse.io/fictional/jobs/12345?utm_source=mail");
  const result = ingestJobAlertBatch(batch([message({
    text_body: `Company: Fictional Systems\nRole: Staff Platform Engineer\nLocation: Riyadh, Saudi Arabia\nWork type: Hybrid\nPosted: 2026-08-29\n${tracked}`,
  })]), { config: config(), now: NOW });
  assert.equal(result.proposed_candidates.length, 1);
  assert.deepEqual(result.proposed_candidates[0], {
    discovery_query_id: result.query_attempt.query_id,
    finder: "gmail_alert_finder",
    discovery_source: "gmail_job_alert",
    source: "Gmail job alert",
    company: "Fictional Systems",
    title: "Staff Platform Engineer",
    location: "Riyadh, Saudi Arabia",
    work_type: "Hybrid",
    posted_date: "2026-08-29",
    canonical_url: "https://job-boards.greenhouse.io/fictional/jobs/12345",
    canonical_source_adapter: "greenhouse",
    job_id: "12345",
    requires_public_verification: true,
    requires_judge: true,
    provenance: {
      transport: "gmail",
      batch_id: "synthetic-batch-1",
      message_ref: result.proposed_candidates[0].provenance.message_ref,
      received_at: "2026-08-30T07:00:00.000Z",
      link_index: 0,
      body_retained: false,
    },
  });
});

test("extracts multiple HTML links and classifies non-job links", () => {
  const result = ingestJobAlertBatch(batch([message({
    text_body: "",
    html_body: `<html><body>
      <article><p>Company: One Example</p><p>Location: Remote</p><a href="https://jobs.ashbyhq.com/one-example/role-a?utm_source=alert">Principal Engineer</a></article>
      <article><p>Company: Two Example</p><a href='https://careers.example.test/jobs/role-b?ref=mail'>Applied AI Engineer</a></article>
      <footer><a href="https://alerts.example.test/unsubscribe">Unsubscribe</a></footer>
    </body></html>`,
  })]), { config: config(), now: NOW });
  assert.equal(result.proposed_candidates.length, 2);
  assert.deepEqual(result.proposed_candidates.map((item) => item.canonical_url), [
    "https://jobs.ashbyhq.com/one-example/role-a",
    "https://careers.example.test/jobs/role-b",
  ]);
  assert.equal(result.diagnostics.classification_counts.unsupported_link, 1);
});

test("classifies malformed, disallowed, stale, extraction-failure, expired, and unsupported messages", () => {
  const messages = [
    { received_at: NOW, from: "alerts@notifications.example.test", text_body: "https://jobs.ashbyhq.com/example/malformed" },
    message({ message_id: "disallowed", from: "alerts@outside.example.test" }),
    message({ message_id: "stale", received_at: "2026-08-01T00:00:00Z" }),
    message({ message_id: "no-links", text_body: "A fictional alert without a URL." }),
    message({ message_id: "expired", text_body: "This position has expired.\nhttps://jobs.ashbyhq.com/example/expired-role" }),
    message({ message_id: "unsupported", text_body: "https://alerts.example.test/preferences" }),
  ];
  const result = ingestJobAlertBatch(batch(messages), { config: config(), now: NOW });
  assert.equal(result.proposed_candidates.length, 0);
  assert.deepEqual(new Set(result.classifications.map((item) => item.code)), new Set([
    JOB_ALERT_CLASSIFICATIONS.MALFORMED_MESSAGE,
    JOB_ALERT_CLASSIFICATIONS.SENDER_NOT_ALLOWED,
    JOB_ALERT_CLASSIFICATIONS.STALE_MESSAGE,
    JOB_ALERT_CLASSIFICATIONS.EXTRACTION_FAILURE,
    JOB_ALERT_CLASSIFICATIONS.EXPIRED_LISTING,
    JOB_ALERT_CLASSIFICATIONS.UNSUPPORTED_LINK,
  ]));
});

test("deduplicates within the batch and against tracker identities", () => {
  const first = message({ message_id: "first" });
  const second = message({ message_id: "second", text_body: "https://jobs.ashbyhq.com/fictional/role-1?utm_source=duplicate" });
  let result = ingestJobAlertBatch(batch([first, second]), { config: config(), now: NOW });
  assert.equal(result.proposed_candidates.length, 1);
  assert.equal(result.diagnostics.classification_counts.duplicate_in_batch, 1);

  result = ingestJobAlertBatch(batch([first]), {
    config: config(), now: NOW,
    existingIdentityKeys: new Set(["url:https://jobs.ashbyhq.com/fictional/role-1"]),
  });
  assert.equal(result.proposed_candidates.length, 0);
  assert.equal(result.diagnostics.classification_counts.duplicate_in_tracker, 1);
});

test("enforces message and per-message link limits deterministically", () => {
  const first = message({
    message_id: "limited-first",
    text_body: "https://jobs.ashbyhq.com/example/one\nhttps://jobs.ashbyhq.com/example/two",
  });
  const second = message({ message_id: "limited-second" });
  const result = ingestJobAlertBatch(batch([first, second]), {
    config: config({ max_messages: 1, max_links_per_message: 1 }), now: NOW,
  });
  assert.equal(result.proposed_candidates.length, 1);
  assert.equal(result.diagnostics.classification_counts.limit_exceeded, 2);
});

test("sanitizes provenance and private text and is idempotent", async () => {
  const privateAddress = ["private.person", "private.example.biz"].join("@");
  const fixture = JSON.parse(await fs.readFile(path.join(projectRoot, "fixtures/job-alert-batch.synthetic.json"), "utf8"));
  fixture.messages[0].text_body = fixture.messages[0].text_body.replace(
    "Company: Northstar Example Labs",
    "Company: Northstar Example Labs contact " + privateAddress,
  );
  fixture.messages[0].subject = "Private subject for " + privateAddress;
  const fixtureConfig = config({ query: fixture.transport.query });
  const first = ingestJobAlertBatch(fixture, { config: fixtureConfig, now: NOW });
  const second = ingestJobAlertBatch(fixture, { config: fixtureConfig, now: NOW });
  assert.equal(first.proposal_id, second.proposal_id);
  assert.deepEqual(first, second);
  const serialized = JSON.stringify(assertSanitizedJobAlertProposal(first));
  assert.equal(serialized.includes(privateAddress), false);
  assert.doesNotMatch(serialized, /Private subject/);
  assert.doesNotMatch(serialized, /synthetic-message-text-1/);
  assert.doesNotMatch(serialized, /text_body|html_body/);
});

test("rejects malformed envelopes and disabled configurations", () => {
  assert.throws(() => validateJobAlertBatchEnvelope({}), /schema_version/);
  assert.throws(() => validateJobAlertBatchEnvelope(batch([], { batch_id: "private batch with spaces" })), /opaque alphanumeric slug/);
  assert.throws(() => validateJobAlertBatchEnvelope({ ...batch([]), unexpected: true }), /Unsupported job-alert batch field/);
  assert.throws(() => ingestJobAlertBatch(batch([message()]), { config: config({ enabled: false }), now: NOW }), /disabled/);
  assert.throws(() => ingestJobAlertBatch(batch([message()], {
    transport: { provider: "imap", access_mode: "read_only", query: config().query },
  }), { config: config(), now: NOW }), /provider gmail/);
  assert.throws(() => ingestJobAlertBatch(batch([message()], {
    transport: { provider: "gmail", access_mode: "read_only", query: "newer_than:30d" },
  }), { config: config(), now: NOW }), /does not match/);
  const malformedField = ingestJobAlertBatch(batch([message({ private_header: "must not pass" })]), { config: config(), now: NOW });
  assert.equal(malformedField.diagnostics.classification_counts.malformed_message, 1);
});
