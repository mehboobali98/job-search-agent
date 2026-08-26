export const ROLE_FAMILIES = [
  "Backend / Platform",
  "Staff / Principal / Tech Lead",
  "Applied AI / LLM",
  "Developer Productivity / AI Enablement",
  "Full-stack / Product",
];

export const FINDER_BY_ROLE = {
  "Backend / Platform": "backend_finder",
  "Staff / Principal / Tech Lead": "backend_finder",
  "Applied AI / LLM": "ai_product_finder",
  "Developer Productivity / AI Enablement": "ai_product_finder",
  "Full-stack / Product": "ai_product_finder",
};

const CANONICAL_ATS_SITES = [
  "jobs.ashbyhq.com",
  "job-boards.greenhouse.io",
  "jobs.lever.co",
  "apply.workable.com",
  "jobs.smartrecruiters.com",
];

const FINDERS = new Set(Object.values(FINDER_BY_ROLE));

function requiredString(value, label) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(label + " must be a non-empty string");
  return text;
}

function stringList(value, label, { allowEmpty = false } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throw new Error(label + " must be " + (allowEmpty ? "an array" : "a non-empty array"));
  }
  const result = value.map((item, index) => requiredString(item, label + "[" + index + "]"));
  if (new Set(result.map((item) => item.toLowerCase())).size !== result.length) {
    throw new Error(label + " contains duplicate terms");
  }
  for (const term of result) {
    if (/[\[\]{}<>*“”]/.test(term)) {
      throw new Error(label + " contains LinkedIn-unsupported Boolean syntax: " + term);
    }
    if (/\b(?:AND|OR|NOT)\b/.test(term)) {
      throw new Error(label + " entries must be raw terms, not Boolean expressions: " + term);
    }
    if (term.includes('"')) throw new Error(label + " entries must not contain quotation marks: " + term);
  }
  return result;
}

function priorityMarketList(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("linkedin_public.priority_market_locations must be an array");
  const markets = value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("linkedin_public.priority_market_locations[" + index + "] must be an object");
    }
    return {
      location: requiredString(entry.location, "linkedin_public.priority_market_locations[" + index + "].location"),
      city_aliases: stringList(
        entry.city_aliases ?? [],
        "linkedin_public.priority_market_locations[" + index + "].city_aliases",
        { allowEmpty: true },
      ),
    };
  });
  if (new Set(markets.map((entry) => entry.location.toLowerCase())).size !== markets.length) {
    throw new Error("linkedin_public.priority_market_locations contains duplicate locations");
  }
  return markets;
}

function watchlistList(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("company_watchlists must be an array");
  const watchlists = value.map((entry, index) => {
    const label = "company_watchlists[" + index + "]";
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(label + " must be an object");
    }
    const id = requiredString(entry.id, label + ".id");
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) throw new Error(label + ".id must be a lowercase slug");
    const url = requiredString(entry.url, label + ".url");
    let parsedUrl;
    try { parsedUrl = new URL(url); } catch { throw new Error(label + ".url must be a valid URL"); }
    if (parsedUrl.protocol !== "https:") throw new Error(label + ".url must use https");
    const finder = requiredString(entry.finder ?? "backend_finder", label + ".finder");
    if (!FINDERS.has(finder)) throw new Error(label + ".finder is invalid");
    const roleFamily = requiredString(entry.role_family ?? "Backend / Platform", label + ".role_family");
    if (!ROLE_FAMILIES.includes(roleFamily)) throw new Error(label + ".role_family is invalid");
    const weekday = requiredString(entry.weekday ?? "Friday", label + ".weekday");
    if (!new Set(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]).has(weekday)) {
      throw new Error(label + ".weekday is invalid");
    }
    const maximum = Number(entry.max_companies_per_run ?? 5);
    if (!Number.isInteger(maximum) || maximum < 1 || maximum > 25) {
      throw new Error(label + ".max_companies_per_run must be an integer from 1 to 25");
    }
    return {
      id,
      enabled: entry.enabled !== false,
      name: requiredString(entry.name, label + ".name"),
      url,
      finder,
      role_family: roleFamily,
      weekday,
      max_companies_per_run: maximum,
      market_terms: stringList(entry.market_terms, label + ".market_terms"),
      interview_process_signal: requiredString(entry.interview_process_signal, label + ".interview_process_signal"),
    };
  });
  if (new Set(watchlists.map((entry) => entry.id)).size !== watchlists.length) {
    throw new Error("company_watchlists contains duplicate ids");
  }
  return watchlists;
}

export function validateSearchTerms(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Search terms must be a JSON object");
  if (raw.version !== 1) throw new Error("Unsupported search-terms version: " + raw.version);
  const linkedin = raw.linkedin_public;
  if (!linkedin || typeof linkedin !== "object" || Array.isArray(linkedin)) {
    throw new Error("linkedin_public configuration is required");
  }
  const queryShare = Number(linkedin.query_share);
  const freshnessDays = Number(linkedin.freshness_days);
  if (!Number.isFinite(queryShare) || queryShare < 0 || queryShare > 1) {
    throw new Error("linkedin_public.query_share must be between 0 and 1");
  }
  if (!Number.isInteger(freshnessDays) || freshnessDays < 1 || freshnessDays > 30) {
    throw new Error("linkedin_public.freshness_days must be an integer from 1 to 30");
  }

  const roleFamilies = {};
  for (const role of ROLE_FAMILIES) {
    const entry = raw.role_families?.[role];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("Missing search terms for role family: " + role);
    }
    roleFamilies[role] = {
      titles: stringList(entry.titles, role + ".titles"),
      skills: stringList(entry.skills, role + ".skills"),
      context: stringList(entry.context ?? [], role + ".context", { allowEmpty: true }),
    };
  }

  return {
    version: 1,
    linkedin_public: {
      enabled: linkedin.enabled !== false,
      query_share: queryShare,
      freshness_days: freshnessDays,
      remote_locations: stringList(linkedin.remote_locations, "linkedin_public.remote_locations"),
      priority_market_locations: priorityMarketList(linkedin.priority_market_locations),
      relocation_locations: stringList(linkedin.relocation_locations ?? [], "linkedin_public.relocation_locations", { allowEmpty: true }),
      relocation_terms: stringList(linkedin.relocation_terms ?? [], "linkedin_public.relocation_terms", { allowEmpty: true }),
      exclude_terms: stringList(linkedin.exclude_terms ?? [], "linkedin_public.exclude_terms", { allowEmpty: true }),
    },
    company_watchlists: watchlistList(raw.company_watchlists),
    role_families: roleFamilies,
  };
}

function quoteTerm(term) {
  return /^[A-Za-z0-9.#/]+$/.test(term) ? term : '"' + term + '"';
}

function expression(terms) {
  if (!terms.length) return null;
  if (terms.length === 1) return quoteTerm(terms[0]);
  return "(" + terms.map(quoteTerm).join(" OR ") + ")";
}

function rotateTerms(terms, index, maximum) {
  if (terms.length <= maximum) return terms;
  return Array.from({ length: maximum }, (_, offset) => terms[(index + offset) % terms.length]);
}

export function buildBooleanKeywords(roleTerms, { variant = 0, relocationTerms = [], excludeTerms = [] } = {}) {
  const parts = [
    expression(rotateTerms(roleTerms.titles, variant, 4)),
    expression(rotateTerms(roleTerms.skills, variant, 3)),
  ];
  const context = rotateTerms(roleTerms.context, variant, 2);
  if (context.length) parts.push(expression(context));
  if (relocationTerms.length) parts.push(expression(rotateTerms(relocationTerms, variant, 3)));
  let keywords = parts.filter(Boolean).join(" AND ");
  const exclusions = rotateTerms(excludeTerms, variant, 5);
  if (exclusions.length) keywords += " NOT " + expression(exclusions);
  return keywords;
}

export function buildTitleKeywords(roleTerms, { variant = 0 } = {}) {
  return expression(rotateTerms(roleTerms.titles, variant, 4));
}

export function buildLinkedInPublicUrl({ keywords, location, freshnessDays, remote }) {
  const url = new URL("https://www.linkedin.com/jobs/search/");
  url.searchParams.set("keywords", requiredString(keywords, "keywords"));
  url.searchParams.set("location", requiredString(location, "location"));
  url.searchParams.set("f_TPR", "r" + String(freshnessDays * 86400));
  if (remote) url.searchParams.set("f_WT", "2");
  url.searchParams.set("sortBy", "DD");
  return url.toString();
}

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function linkedInQuery({ role, finder, roleTerms, settings, index }) {
  const marketLocations = [
    ...settings.priority_market_locations.map((entry) => ({ ...entry, priority: true })),
    ...settings.relocation_locations.map((location) => ({ location, city_aliases: [], priority: false })),
  ];
  const hasRelocationLane = marketLocations.length > 0 && settings.relocation_terms.length > 0;
  const relocation = hasRelocationLane && index % 2 === 1;
  // Rotate locations once per remote/relocation pair so the first query in
  // each lane starts with the first configured location.
  const market = relocation ? marketLocations[Math.floor(index / 2) % marketLocations.length] : null;
  const location = relocation
    ? market.location
    : settings.remote_locations[Math.floor(index / 2) % settings.remote_locations.length];
  const keywords = buildTitleKeywords(roleTerms, { variant: index });
  const searchUrl = buildLinkedInPublicUrl({
    keywords,
    location,
    freshnessDays: settings.freshness_days,
    remote: !relocation,
  });
  return {
    query_id: "linkedin-" + slug(role) + "-" + String(index + 1).padStart(2, "0"),
    finder,
    role_family: role,
    source: "linkedin_public",
    lane: relocation ? (market.priority ? "priority_market_recent" : "relocation_recent") : "remote_recent",
    keywords,
    location,
    filters: {
      freshness_days: settings.freshness_days,
      workplace: relocation ? "Any" : "Remote",
      sort: "Most recent",
    },
    post_discovery_screening: {
      skills: roleTerms.skills,
      context: roleTerms.context,
      relocation_terms: relocation ? settings.relocation_terms : [],
      city_aliases: relocation ? market.city_aliases : [],
      exclude_terms: settings.exclude_terms,
    },
    search_url: searchUrl,
    public_index_query: "site:linkedin.com/jobs/view " + keywords + " " + quoteTerm(location),
    source_rules: [
      "Read only public LinkedIn job pages; never sign in or use an authenticated session.",
      "Keep the public search title-focused; apply skills, context, exclusions, country eligibility, and sponsorship rules only after discovering a vacancy.",
      "Treat a 404, 410, unrelated redirect, or explicit no-longer-accepting notice as Expired or Inaccessible.",
      "Resolve an employer or public ATS page before judging when one is available.",
    ],
  };
}

function priorityMarketTerms(settings) {
  return settings.priority_market_locations.flatMap((entry) => [entry.location, ...entry.city_aliases]);
}

function canonicalQuery({ role, finder, roleTerms, settings, index }) {
  const keywords = buildBooleanKeywords(roleTerms, {
    variant: index,
    excludeTerms: settings.exclude_terms,
  });
  const sites = "(" + CANONICAL_ATS_SITES.map((site) => "site:" + site).join(" OR ") + ")";
  const location = settings.remote_locations[index % settings.remote_locations.length];
  const marketTerms = priorityMarketTerms(settings);
  const accessTerms = ["remote", "relocation", "sponsorship", ...marketTerms];
  return {
    query_id: "canonical-" + slug(role) + "-" + String(index + 1).padStart(2, "0"),
    finder,
    role_family: role,
    source: "canonical_web",
    lane: "employer_ats_recent",
    keywords,
    location,
    filters: { freshness_days: settings.freshness_days },
    market_terms: marketTerms,
    web_query: sites + " " + keywords + " " + expression(accessTerms),
    source_rules: ["Prefer the employer or ATS listing as the canonical URL and verify that it is active."],
  };
}

function companyWatchlistQuery({ watchlist, roleTerms, index }) {
  return {
    query_id: "watchlist-" + watchlist.id + "-" + String(index + 1).padStart(2, "0"),
    finder: watchlist.finder,
    role_family: watchlist.role_family,
    source: "company_watchlist",
    lane: "weekly_company_watchlist",
    keywords: buildTitleKeywords(roleTerms),
    location: watchlist.market_terms.join(", "),
    filters: {
      weekday: watchlist.weekday,
      max_companies_per_run: watchlist.max_companies_per_run,
    },
    watchlist_name: watchlist.name,
    watchlist_url: watchlist.url,
    market_terms: watchlist.market_terms,
    interview_process_signal: watchlist.interview_process_signal,
    source_rules: [
      "Treat each directory entry only as a company seed; it is never a vacancy or lead by itself.",
      "Inspect at most the configured company limit and open only public career or ATS pages.",
      "Return a packet only for a currently active canonical vacancy that satisfies the normal eligibility and scoring rules.",
      "Record the configured interview-process signal in the candidate packet, but do not add scoring points for it.",
      "Do not rely on a directory entry as evidence that a company is currently hiring or that its interview process is unchanged.",
    ],
  };
}

export function buildSearchPlan({ rawTerms, roleQueryBudget, targetGeography, runWeekday = null }) {
  const terms = validateSearchTerms(rawTerms);
  if (!roleQueryBudget || typeof roleQueryBudget !== "object" || Array.isArray(roleQueryBudget)) {
    throw new Error("roleQueryBudget must be an object");
  }
  const queries = [];
  for (const role of ROLE_FAMILIES) {
    const budget = Number(roleQueryBudget[role] ?? 0);
    if (!Number.isInteger(budget) || budget < 0) throw new Error("Invalid query budget for " + role);
    const finder = FINDER_BY_ROLE[role];
    const linkedinCount = terms.linkedin_public.enabled && budget > 0
      ? Math.min(budget, Math.max(1, Math.round(budget * terms.linkedin_public.query_share)))
      : 0;
    for (let index = 0; index < budget; index += 1) {
      queries.push(index < linkedinCount
        ? linkedInQuery({ role, finder, roleTerms: terms.role_families[role], settings: terms.linkedin_public, index })
        : canonicalQuery({ role, finder, roleTerms: terms.role_families[role], settings: terms.linkedin_public, index }));
    }
  }
  const dueWatchlists = terms.company_watchlists.filter((entry) => entry.enabled && entry.weekday === runWeekday);
  for (let index = 0; index < dueWatchlists.length; index += 1) {
    const watchlist = dueWatchlists[index];
    const replaceIndex = queries.findLastIndex((query) => (
      query.finder === watchlist.finder
      && query.role_family === watchlist.role_family
      && query.source === "canonical_web"
    ));
    if (replaceIndex < 0) {
      throw new Error("No canonical query slot is available for company watchlist: " + watchlist.id);
    }
    queries[replaceIndex] = companyWatchlistQuery({
      watchlist,
      roleTerms: terms.role_families[watchlist.role_family],
      index,
    });
  }
  const byFinder = Object.fromEntries(["backend_finder", "ai_product_finder"].map((finder) => [
    finder,
    queries.filter((query) => query.finder === finder),
  ]));
  return {
    version: 3,
    target_geography: requiredString(targetGeography, "targetGeography"),
    run_weekday: runWeekday,
    query_count: queries.length,
    linkedin_query_count: queries.filter((query) => query.source === "linkedin_public").length,
    company_watchlist_query_count: queries.filter((query) => query.source === "company_watchlist").length,
    priority_markets: terms.linkedin_public.priority_market_locations,
    role_query_budget: Object.fromEntries(ROLE_FAMILIES.map((role) => [role, Number(roleQueryBudget[role] ?? 0)])),
    by_finder: byFinder,
    queries,
  };
}
