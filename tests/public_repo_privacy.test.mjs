import assert from "node:assert/strict";
import test from "node:test";
import { isBlockedPublicPath, publicContentViolations } from "../scripts/public_repo_privacy.mjs";

test("private email exports and candidate artifacts are blocked from the public repository", () => {
  for (const name of [
    "gmail-imports/private.json", "job-alert-imports/batch.json", "email-imports/export.json",
    "historical-imports/old-tracker.json", "tracker-imports/mapping.json", "private-history.xlsx",
    "mailbox.eml", "archive.mbox", "mail-export.zip", "profile/candidate-profile.md", "profile/resumes/private.pdf", "state/private.json",
  ]) assert.equal(isBlockedPublicPath(name), true, name);
  assert.equal(isBlockedPublicPath("fixtures/job-alert-batch.synthetic.json"), false);
  assert.equal(isBlockedPublicPath("schemas/job-alert-batch.v1.schema.json"), false);
});

test("real email addresses are rejected while reserved synthetic domains remain usable", () => {
  assert.deepEqual(publicContentViolations("Contact alerts@example.test for synthetic data."), []);
  const privateAddress = ["private.person", "private.example.biz"].join("@");
  assert.ok(publicContentViolations("Contact " + privateAddress).includes("email address"));
});

test("raw message batches are rejected outside the synthetic fixture namespace", () => {
  const rawBatch = JSON.stringify({
    schema_version: 1,
    transport: { provider: "gmail", access_mode: "read_only" },
    messages: [{ from: "alerts@example.test", text_body: "private body" }],
  });
  assert.ok(publicContentViolations(rawBatch, { fileName: "batch.json" }).includes("private job-alert message batch"));
  assert.equal(publicContentViolations(rawBatch, { fileName: "fixtures/synthetic.json" }).includes("private job-alert message batch"), false);
});
