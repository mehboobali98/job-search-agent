import { allocateLargestRemainder } from "./job_tracker_lib.mjs";

export function readSearchBudget(workbook) {
  const sheet = workbook.worksheets.getItem("Search Config");
  const maximumSearches = Number(sheet.getRange("B6").values[0][0]);
  const allocations = Object.fromEntries(sheet.getRange("D5:E9").values.map(([role, weight]) => [String(role), Number(weight)]));
  return {
    maximum_searches: maximumSearches,
    allocations,
    role_query_budget: allocateLargestRemainder(maximumSearches, allocations),
  };
}
