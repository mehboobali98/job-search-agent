import test from "node:test";
import assert from "node:assert/strict";
import {
  ROLE_FAMILIES,
  buildBooleanKeywords,
  buildSearchPlan,
  validateSearchTerms,
} from "../scripts/search_query_lib.mjs";

function termsFixture() {
  return {
    version: 1,
    linkedin_public: {
      enabled: true,
      query_share: 0.5,
      freshness_days: 7,
      remote_locations: ["Worldwide"],
      relocation_locations: ["Europe", "United Kingdom"],
      relocation_terms: ["relocation", "visa sponsorship", "work permit"],
      exclude_terms: ["junior", "intern", "internship", "frontend only", "mobile"],
    },
    role_families: Object.fromEntries(ROLE_FAMILIES.map((role) => [role, {
      titles: role === "Backend / Platform"
        ? ["Senior Backend Engineer", "Ruby on Rails Engineer", "Backend Engineer", "Platform Engineer", "Senior Software Engineer"]
        : [role + " Engineer", role + " Developer"],
      skills: role === "Backend / Platform" ? ["Ruby on Rails", "Rails", "PostgreSQL"] : ["AI", "platform"],
      context: ["SaaS", "API", "production"],
    }])),
  };
}

test("builds exact-budget public LinkedIn and canonical query lanes", () => {
  const roleQueryBudget = {
    "Backend / Platform": 6,
    "Staff / Principal / Tech Lead": 2,
    "Applied AI / LLM": 2,
    "Developer Productivity / AI Enablement": 1,
    "Full-stack / Product": 1,
  };
  const plan = buildSearchPlan({
    rawTerms: termsFixture(),
    roleQueryBudget,
    targetGeography: "Worldwide remote plus credible relocation or sponsorship",
  });

  assert.equal(plan.query_count, 12);
  assert.equal(plan.linkedin_query_count, 7);
  assert.equal(plan.by_finder.backend_finder.length, 8);
  assert.equal(plan.by_finder.ai_product_finder.length, 4);
  for (const role of ROLE_FAMILIES) {
    assert.equal(plan.queries.filter((query) => query.role_family === role).length, roleQueryBudget[role]);
    assert.ok(plan.queries.some((query) => query.role_family === role && query.source === "linkedin_public"));
  }

  const remote = plan.queries.find((query) => query.source === "linkedin_public" && query.lane === "remote_recent");
  const remoteUrl = new URL(remote.search_url);
  assert.equal(remoteUrl.hostname, "www.linkedin.com");
  assert.equal(remoteUrl.pathname, "/jobs/search/");
  assert.equal(remoteUrl.searchParams.get("location"), "Worldwide");
  assert.equal(remoteUrl.searchParams.get("f_TPR"), "r604800");
  assert.equal(remoteUrl.searchParams.get("f_WT"), "2");
  assert.equal(remoteUrl.searchParams.get("sortBy"), "DD");
  assert.match(remoteUrl.searchParams.get("keywords"), /"Ruby on Rails"/);
  assert.match(remote.public_index_query, /^site:linkedin\.com\/jobs\/view /);

  const relocation = plan.queries.find((query) => query.source === "linkedin_public" && query.lane === "relocation_recent");
  assert.equal(relocation.location, "Europe");
  assert.match(relocation.keywords, /"visa sponsorship"/);
  assert.equal(new URL(relocation.search_url).searchParams.has("f_WT"), false);
});

test("uses LinkedIn-supported Boolean syntax with exact phrases and exclusions", () => {
  const keywords = buildBooleanKeywords({
    titles: ["Senior Backend Engineer", "Ruby on Rails Engineer"],
    skills: ["Ruby on Rails", "PostgreSQL"],
    context: ["SaaS", "API"],
  }, {
    relocationTerms: ["visa sponsorship", "work permit"],
    excludeTerms: ["junior", "internship"],
  });

  assert.equal(
    keywords,
    '("Senior Backend Engineer" OR "Ruby on Rails Engineer") AND ("Ruby on Rails" OR PostgreSQL) AND (SaaS OR API) AND ("visa sponsorship" OR "work permit") NOT (junior OR internship)',
  );
  assert.doesNotMatch(keywords, /[\[\]{}<>*“”]/);
});

test("rejects malformed or pre-composed Boolean search terms", () => {
  const wildcard = termsFixture();
  wildcard.role_families["Backend / Platform"].titles[0] = "Backend*";
  assert.throws(() => validateSearchTerms(wildcard), /unsupported Boolean syntax/);

  const composed = termsFixture();
  composed.role_families["Backend / Platform"].skills[0] = "Ruby OR Rails";
  assert.throws(() => validateSearchTerms(composed), /raw terms/);
});
