export type LogFn = (level: "info" | "warn" | "error", msg: string, extra?: unknown) => void;

const ORDER = { info: 0, warn: 1, error: 2 } as const;

/** Log JSON một dòng (dễ đẩy sang Loki/Datadog). Không bao giờ ghi nội dung tin nhắn của khách. */
export function makeLogger(min: "info" | "warn" | "error" = "info", service = "app"): LogFn {
  return (level, msg, extra) => {
    if (ORDER[level] < ORDER[min]) return;
    const line = JSON.stringify({ t: new Date().toISOString(), level, service, msg, ...(extra && typeof extra === "object" ? { extra } : {}) });
    (level === "error" ? process.stderr : process.stdout).write(line + "\n");
  };
}
