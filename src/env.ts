export interface Env {
  DB: D1Database;
  JOBS?: Queue<Job>; // คิวงานหนัก (สรุป) — ทำได้นานกว่า 30 วินาที
  // secrets (ตั้งด้วย npm run setup หรือ wrangler secret put)
  LINE_CHANNEL_SECRET: string;
  LINE_CHANNEL_ACCESS_TOKEN: string;
  OWNER_USER_ID: string;
  AI_API_KEY: string;
  EXPORT_TOKEN: string;
  // vars (แก้ใน wrangler.toml)
  PA_NAME: string;
  AI_PROVIDER: string;
  AI_MODEL: string;
  AI_BASE_URL?: string;
  TIMEZONE: string;
  JOIN_NOTICE: string;
  RETENTION_DAYS: string;
}

export type Job = { type: "digest"; userId: string };

export const now = () => Date.now();

export function formatTime(ms: number, tz: string, withDate = false): string {
  const opts: Intl.DateTimeFormatOptions = { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false };
  if (withDate) Object.assign(opts, { day: "numeric", month: "short" });
  return new Intl.DateTimeFormat("th-TH", opts).format(new Date(ms));
}
