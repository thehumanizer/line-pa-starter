// ทุกอย่างที่คุยกับ LINE Messaging API อยู่ในไฟล์นี้
import type { Env } from "./env";

const API = "https://api.line.me/v2/bot";

// ตรวจว่า request มาจากไลน์จริง (ลายเซ็น HMAC-SHA256 ด้วย Channel secret)
export async function verifySignature(body: string, signature: string | null, secret: string): Promise<boolean> {
  if (!signature || !secret) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));
  return timingSafeEqual(expected, signature);
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ใช้ร่วมกับ src/admin.ts (เช็คสถานะ ตั้ง webhook) — path ต่อจาก /v2/bot
export const lineApi = (env: Env, path: string, init: RequestInit = {}) => call(env, path, init);

async function call(env: Env, path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(API + path, {
    ...init,
    headers: { Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  if (!res.ok) console.error(`LINE ${path} -> ${res.status} ${await res.clone().text()}`);
  return res;
}

const asMessages = (bubbles: string[]) => bubbles.map((text) => ({ type: "text", text }));

// ตอบกลับ (ฟรี ไม่นับโควต้า) — ใช้ได้ครั้งเดียว และต้องตอบภายในเวลาสั้นๆ
export async function reply(env: Env, replyToken: string, bubbles: string[]): Promise<boolean> {
  const res = await call(env, "/message/reply", { method: "POST", body: JSON.stringify({ replyToken, messages: asMessages(bubbles) }) });
  return res.ok;
}

// ส่งหาเองโดยไม่ต้องรอให้ถาม (นับโควต้ารายเดือนของ LINE OA)
export async function push(env: Env, to: string, bubbles: string[]): Promise<boolean> {
  const res = await call(env, "/message/push", { method: "POST", body: JSON.stringify({ to, messages: asMessages(bubbles) }) });
  return res.ok;
}

// จุดสามจุดระหว่างรอ AI คิด (ใช้ได้เฉพาะแชท 1:1)
export async function showLoading(env: Env, userId: string): Promise<void> {
  await call(env, "/chat/loading/start", { method: "POST", body: JSON.stringify({ chatId: userId, loadingSeconds: 30 }) });
}

export async function getGroupName(env: Env, groupId: string): Promise<string | null> {
  const res = await call(env, `/group/${groupId}/summary`);
  if (!res.ok) return null;
  const data = (await res.json()) as { groupName?: string };
  return data.groupName ?? null;
}

export async function getMemberName(env: Env, kind: string, groupId: string, userId: string): Promise<string | null> {
  const res = await call(env, `/${kind}/${groupId}/member/${userId}`);
  if (!res.ok) return null;
  const data = (await res.json()) as { displayName?: string };
  return data.displayName ?? null;
}

// แตกข้อความยาวเป็น bubble สั้นๆ (ไลน์รับได้สูงสุด 5 bubble ต่อครั้ง)
export function toBubbles(text: string, max = 5): string[] {
  const clean = text.replace(/\*\*/g, "").replace(/^#{1,6}\s*/gm, "").trim();
  let parts = clean.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) parts = ["(ไม่มีข้อความ)"];
  if (parts.length > max) parts = [...parts.slice(0, max - 1), parts.slice(max - 1).join("\n\n")];
  return parts.map((p) => (p.length > 4900 ? p.slice(0, 4900) + "…" : p));
}
