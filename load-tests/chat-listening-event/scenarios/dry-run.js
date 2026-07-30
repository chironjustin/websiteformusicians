import { check } from "k6";
import { buildConfig, printConfig } from "../lib/config.js";
import { makeSummary } from "../lib/summary.js";
import { getEvent, loadPublicPage } from "../lib/supabase.js";

const config = buildConfig("dry-run", { vus: 1, duration: "1s", writeScenario: false, largeScenario: false });
printConfig(config, { dryRun: true, writes: "none" });

export const options = {
  vus: 1,
  iterations: 1,
  thresholds: {
    checks: ["rate>0.99"],
    http_req_failed: ["rate<0.01"],
  },
};

export default function() {
  loadPublicPage(config);
  const event = getEvent(config);
  check(event || {}, {
    "dry-run target event exists": value => Boolean(value?.id),
    "dry-run event id matches": value => value?.id === config.eventId,
  });
  console.log(JSON.stringify({
    dryRun: true,
    eventId: config.eventId,
    eventStatus: event?.status,
    startsAt: event?.starts_at,
    endsAt: event?.ends_at,
    autoPublishEnabled: event?.auto_publish_enabled,
    queuePaused: event?.queue_paused,
    estimatedLargeTestWarning: "10k scenarios are not run by dry-run. Review Supabase/Vercel limits before setting confirmation variables.",
  }, null, 2));
}

export const handleSummary = makeSummary(config);
