import { Counter, Rate, Trend } from "k6/metrics";

export const heartbeatDuration = new Trend("heartbeat_duration", true);
export const heartbeatFailed = new Rate("heartbeat_failed");
export const submissionDuration = new Trend("submission_duration", true);
export const submissionUnexpectedFailed = new Rate("submission_unexpected_failed");
export const sessionInitDuration = new Trend("session_init_duration", true);
export const publicFetchDuration = new Trend("public_message_fetch_duration", true);
export const listenerCountDuration = new Trend("listener_count_duration", true);
export const acceptedSubmissions = new Counter("accepted_submissions");
export const intentionalRateLimits = new Counter("intentional_rate_limit_rejections");
export const unexpectedSubmissionRejections = new Counter("unexpected_submission_rejections");
export const queuedPrivateVisible = new Counter("queued_private_visible_to_sender");
export const visibilityLeak = new Counter("visibility_leak");
export const duplicatePublicDelivery = new Counter("duplicate_public_delivery");
export const pageLoadDuration = new Trend("page_load_duration", true);
export const audioProbeDuration = new Trend("audio_probe_duration", true);
export const queueWorkerDuration = new Trend("queue_worker_duration", true);
export const queueDiagnosticsDuration = new Trend("queue_diagnostics_duration", true);
