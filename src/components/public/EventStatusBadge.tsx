import type { EventStatus } from "@/types/event";

const colors: Record<EventStatus, { background: string; color: string }> = {
  draft: { background: "#f3f4f6", color: "#6b7280" },
  upcoming: { background: "#fef3c7", color: "#92400e" },
  live: { background: "#dcfce7", color: "#15803d" },
  finished: { background: "#f3f4f6", color: "#6b7280" },
};

export default function EventStatusBadge({ status }: { status: EventStatus }) {
  return (
    <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.05em", padding: "2px 10px", borderRadius: 999, ...colors[status] }}>
      {status.toUpperCase()}
    </span>
  );
}
