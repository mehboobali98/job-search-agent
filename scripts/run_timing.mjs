export function configuredRunTiming(config, runDate) {
  const timezone = String(config?.raw?.timezone ?? "").trim();
  if (!timezone) throw new Error("Configured timezone is required");
  return {
    timezone,
    runWeekday: new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: timezone }).format(runDate),
  };
}
