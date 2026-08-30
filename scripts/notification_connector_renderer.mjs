import { validateNotificationDeliveryRequest } from "./notification_delivery_lib.mjs";

export const NOTIFICATION_CONNECTOR_RENDERERS = Object.freeze([
  "adapter_neutral_json_v1",
  "slack_blocks_v1",
]);

const RENDERERS = new Set(NOTIFICATION_CONNECTOR_RENDERERS);

function slackText(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function slackLink(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "%3C")
    .replaceAll(">", "%3E");
}

function slackItem(item) {
  const lines = [
    `*${slackText(item.role)}* at *${slackText(item.company)}*`,
    `Score: *${item.score}* · Eligibility: ${slackText(item.eligibility)}${item.location ? ` · ${slackText(item.location)}` : ""}`,
  ];
  if (item.primary_strength) lines.push(`Strength: ${slackText(item.primary_strength)}`);
  if (item.primary_risk) lines.push(`Risk: ${slackText(item.primary_risk)}`);
  if (item.best_resume) lines.push(`Resume: ${slackText(item.best_resume)}`);
  if (item.posted_date) lines.push(`Posted: ${slackText(item.posted_date)}`);
  lines.push(`<${slackLink(item.canonical_url)}|View canonical job> · Lead \`${slackText(item.lead_id)}\``);
  const text = lines.join("\n");
  if (text.length > 3_000) throw new Error("Slack renderer produced a section above the 3000-character limit");
  return { type: "section", text: { type: "mrkdwn", text } };
}

function renderSlackBlocks(request, target) {
  if (typeof target !== "string" || !target) throw new Error("Slack rendering requires an approved private target");
  const blocks = [{
    type: "header",
    text: { type: "plain_text", text: "Job search digest", emoji: false },
  }];
  request.items.forEach((item, index) => {
    blocks.push(slackItem(item));
    if (index < request.items.length - 1) blocks.push({ type: "divider" });
  });
  if (blocks.length > 50) throw new Error("Slack renderer exceeded the 50-block limit");
  return {
    channel: target,
    text: `Job search digest: ${request.items.length} approved role${request.items.length === 1 ? "" : "s"}`,
    blocks,
  };
}

export function renderNotificationConnectorRequest(request, destinationPolicy = null) {
  validateNotificationDeliveryRequest(request);
  const renderer = destinationPolicy?.rendering?.renderer ?? "adapter_neutral_json_v1";
  if (!RENDERERS.has(renderer)) throw new Error("Notification connector renderer is unsupported");
  const target = destinationPolicy?.rendering?.target ?? null;
  let payload;
  if (renderer === "adapter_neutral_json_v1") {
    if (target !== null) throw new Error("Adapter-neutral rendering cannot include a native target");
    payload = request;
  } else {
    if (request.destination.channel !== "slack") throw new Error("Slack rendering requires a Slack destination");
    payload = renderSlackBlocks(request, target);
  }
  const body = JSON.stringify(payload);
  return {
    renderer,
    native_rendering: renderer !== "adapter_neutral_json_v1",
    body,
    body_bytes: Buffer.byteLength(body),
    target_included_in_network_payload: target !== null,
  };
}
