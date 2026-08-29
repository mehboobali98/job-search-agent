import test from "node:test";
import assert from "node:assert/strict";
import {
  ROLE_FAMILIES,
  buildBooleanKeywords,
  buildSearchPlan,
  validateSearchTerms,
} from "../scripts/search_query_lib.mjs";
import { configuredRunTiming } from "../scripts/run_timing.mjs";

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

test("derives weekday and emitted timezone from the validated local configuration", () => {
  const runDate = new Date("2026-08-28T10:00:00Z");
  const timing = configuredRunTiming({ raw: { timezone: "Pacific/Kiritimati" } }, runDate);
  assert.deepEqual(timing, { timezone: "Pacific/Kiritimati", runWeekday: "Saturday" });
  assert.throws(() => configuredRunTiming({ timezone: "Pacific/Kiritimati" }, runDate), /Configured timezone is required/);
});

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

  assert.equal(plan.version, 4);
  assert.equal(plan.query_count, 12);
  assert.equal(plan.linkedin_query_count, 7);
  assert.equal(plan.company_watchlist_query_count, 0);
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
  assert.match(remoteUrl.searchParams.get("keywords"), /"Ruby on Rails Engineer"/);
  assert.doesNotMatch(remote.keywords, /\sAND\s|\sNOT\s/);
  assert.deepEqual(remote.post_discovery_screening.skills, ["Ruby on Rails", "Rails", "PostgreSQL"]);
  assert.deepEqual(remote.post_discovery_screening.exclude_terms, ["junior", "intern", "internship", "frontend only", "mobile"]);
  assert.match(remote.public_index_query, /^site:linkedin\.com\/jobs\/view /);

  const relocation = plan.queries.find((query) => query.source === "linkedin_public" && query.lane === "relocation_recent");
  assert.equal(relocation.location, "Europe");
  assert.doesNotMatch(relocation.keywords, /relocation|sponsorship|permit/i);
  assert.deepEqual(relocation.post_discovery_screening.relocation_terms, ["relocation", "visa sponsorship", "work permit"]);
  assert.equal(new URL(relocation.search_url).searchParams.has("f_WT"), false);
  assert.deepEqual(plan.canonical_source_adapters.map((adapter) => adapter.id), [
    "ashby", "greenhouse", "workable", "lever", "smartrecruiters",
  ]);
  const canonical = plan.queries.find((query) => query.source === "canonical_web");
  assert.equal(canonical.source_adapters.length, 5);
  assert.match(canonical.web_query, /site:boards\.greenhouse\.io/);
  assert.match(canonical.source_rules.join(" "), /Never use private APIs/);
});

test("retains detailed Boolean syntax for canonical employer and ATS searches", () => {
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

test("reserves explicit UAE and Saudi market lanes without exceeding the search budget", () => {
  const terms = termsFixture();
  terms.linkedin_public.query_share = 0.67;
  terms.linkedin_public.remote_locations = ["Worldwide", "Pakistan"];
  terms.linkedin_public.priority_market_locations = [
    { location: "United Arab Emirates", city_aliases: ["Dubai", "Abu Dhabi"] },
    { location: "Saudi Arabia", city_aliases: ["Riyadh", "Jeddah"] },
  ];
  const plan = buildSearchPlan({
    rawTerms: terms,
    roleQueryBudget: {
      "Backend / Platform": 6,
      "Staff / Principal / Tech Lead": 2,
      "Applied AI / LLM": 2,
      "Developer Productivity / AI Enablement": 1,
      "Full-stack / Product": 1,
    },
    targetGeography: "Worldwide remote, Pakistan, UAE, Saudi Arabia, and relocation",
    runWeekday: "Wednesday",
  });

  assert.equal(plan.query_count, 12);
  assert.equal(plan.linkedin_query_count, 8);
  assert.deepEqual(
    plan.queries.filter((query) => query.lane === "priority_market_recent").map((query) => query.location),
    ["United Arab Emirates", "Saudi Arabia"],
  );
  const uae = plan.queries.find((query) => query.location === "United Arab Emirates");
  const saudi = plan.queries.find((query) => query.location === "Saudi Arabia");
  assert.deepEqual(uae.post_discovery_screening.city_aliases, ["Dubai", "Abu Dhabi"]);
  assert.deepEqual(saudi.post_discovery_screening.city_aliases, ["Riyadh", "Jeddah"]);
  assert.equal(new URL(uae.search_url).searchParams.has("f_WT"), false);
  assert.ok(plan.queries.some((query) => query.source === "linkedin_public" && query.location === "Pakistan"));
  const canonical = plan.queries.find((query) => query.source === "canonical_web");
  assert.match(canonical.web_query, /"United Arab Emirates"/);
  assert.match(canonical.web_query, /Dubai/);
  assert.match(canonical.web_query, /"Saudi Arabia"/);
  assert.match(canonical.web_query, /Riyadh/);
});

test("replaces one Friday canonical query with a bounded company watchlist", () => {
  const terms = termsFixture();
  terms.linkedin_public.query_share = 0.67;
  terms.company_watchlists = [{
    id: "hiring-without-whiteboards",
    enabled: true,
    name: "Hiring Without Whiteboards",
    url: "https://raw.githubusercontent.com/poteto/hiring-without-whiteboards/main/README.md",
    finder: "backend_finder",
    role_family: "Backend / Platform",
    weekday: "Friday",
    max_companies_per_run: 5,
    market_terms: ["UAE", "Saudi Arabia", "Pakistan", "Remote"],
    interview_process_signal: "Listed by Hiring Without Whiteboards; verify the current process",
  }];
  const roleQueryBudget = {
    "Backend / Platform": 6,
    "Staff / Principal / Tech Lead": 2,
    "Applied AI / LLM": 2,
    "Developer Productivity / AI Enablement": 1,
    "Full-stack / Product": 1,
  };
  const thursday = buildSearchPlan({ rawTerms: terms, roleQueryBudget, targetGeography: "Configured", runWeekday: "Thursday" });
  const friday = buildSearchPlan({ rawTerms: terms, roleQueryBudget, targetGeography: "Configured", runWeekday: "Friday" });

  assert.equal(thursday.query_count, 12);
  assert.equal(thursday.company_watchlist_query_count, 0);
  assert.equal(friday.query_count, 12);
  assert.equal(friday.company_watchlist_query_count, 1);
  assert.equal(friday.queries.filter((query) => query.source === "canonical_web").length, thursday.queries.filter((query) => query.source === "canonical_web").length - 1);
  const watchlist = friday.queries.find((query) => query.source === "company_watchlist");
  assert.equal(watchlist.finder, "backend_finder");
  assert.equal(watchlist.filters.max_companies_per_run, 5);
  assert.match(watchlist.source_rules.join(" "), /never a vacancy or lead by itself/);
  assert.match(watchlist.source_rules.join(" "), /currently active canonical vacancy/);
  for (const role of ROLE_FAMILIES) {
    assert.equal(friday.queries.filter((query) => query.role_family === role).length, roleQueryBudget[role]);
  }
});

test("rejects malformed or pre-composed Boolean search terms", () => {
  const wildcard = termsFixture();
  wildcard.role_families["Backend / Platform"].titles[0] = "Backend*";
  assert.throws(() => validateSearchTerms(wildcard), /unsupported Boolean syntax/);

  const composed = termsFixture();
  composed.role_families["Backend / Platform"].skills[0] = "Ruby OR Rails";
  assert.throws(() => validateSearchTerms(composed), /raw terms/);

  const insecureWatchlist = termsFixture();
  insecureWatchlist.company_watchlists = [{
    id: "example",
    name: "Example",
    url: "http://example.test/watchlist",
    market_terms: ["Remote"],
    interview_process_signal: "Example signal",
  }];
  assert.throws(() => validateSearchTerms(insecureWatchlist), /must use https/);
});
