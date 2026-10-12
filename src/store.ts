// อ่าน/เขียนสมองกลาง (D1)
import type { Env } from "./env";
import { now } from "./env";

export type Msg = { id: number; group_id: string; name: string | null; type: string; text: string | null; at: number };
export type Group = { id: string; kind: string; name: string | null; active: number; joined_at: number };
export type Digest = { id: number; from_msg: number; to_msg: number; text: string; kind: string; at: number };

// true = เพิ่งเห็นครั้งแรก, false = เคยเห็นแล้ว (ไลน์ส่งซ้ำ)
export async function markSeen(env: Env, eventId: string): Promise<boolean> {
  const r = await env.DB.prepare("INSERT OR IGNORE INTO events_seen (event_id, at) VALUES (?, ?)").bind(eventId, now()).run();
  return (r.meta.changes ?? 0) > 0;
}

export async function getGroup(env: Env, id: string): Promise<Group | null> {
  return env.DB.prepare("SELECT * FROM groups WHERE id = ?").bind(id).first<Group>();
}

export async function upsertGroup(env: Env, id: string, kind: string, name: string | null): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO groups (id, kind, name, active, joined_at) VALUES (?, ?, ?, 1, ?)
     ON CONFLICT(id) DO UPDATE SET active = 1, name = COALESCE(excluded.name, groups.name)`,
  ).bind(id, kind, name, now()).run();
}

export async function setGroupActive(env: Env, id: string, active: boolean): Promise<void> {
  await env.DB.prepare("UPDATE groups SET active = ? WHERE id = ?").bind(active ? 1 : 0, id).run();
}

export async function listGroups(env: Env): Promise<Group[]> {
  return (await env.DB.prepare("SELECT * FROM groups ORDER BY joined_at").all<Group>()).results;
}

export async function getMember(env: Env, groupId: string, userId: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT name FROM members WHERE group_id = ? AND user_id = ?").bind(groupId, userId).first<{ name: string }>();
  return row?.name ?? null;
}

export async function saveMember(env: Env, groupId: string, userId: string, name: string): Promise<void> {
  await env.DB.prepare("INSERT OR REPLACE INTO members (group_id, user_id, name) VALUES (?, ?, ?)").bind(groupId, userId, name).run();
}

export async function saveMessage(env: Env, m: { lineId: string; groupId: string; userId?: string; name: string | null; type: string; text: string | null; at: number }): Promise<void> {
  await env.DB.prepare("INSERT OR IGNORE INTO messages (line_id, group_id, user_id, name, type, text, at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(m.lineId, m.groupId, m.userId ?? null, m.name, m.type, m.text, m.at).run();
}

export async function messagesAfter(env: Env, afterId: number, limit = 2000): Promise<Msg[]> {
  return (await env.DB.prepare("SELECT id, group_id, name, type, text, at FROM messages WHERE id > ? ORDER BY id LIMIT ?").bind(afterId, limit).all<Msg>()).results;
}

export async function recentMessages(env: Env, sinceMs: number, limit = 300): Promise<Msg[]> {
  const rows = (await env.DB.prepare("SELECT id, group_id, name, type, text, at FROM messages WHERE at > ? ORDER BY id DESC LIMIT ?").bind(sinceMs, limit).all<Msg>()).results;
  return rows.reverse();
}

// kind = "auto" → สรุปตอนเช้าล่าสุด (ใช้เป็นจุดเริ่มของรอบถัดไป) · ไม่ใส่ → สรุปล่าสุดแบบไหนก็ได้
export async function lastDigest(env: Env, kind?: "auto" | "manual"): Promise<Digest | null> {
  return kind
    ? env.DB.prepare("SELECT * FROM digests WHERE kind = ? ORDER BY id DESC LIMIT 1").bind(kind).first<Digest>()
    : env.DB.prepare("SELECT * FROM digests ORDER BY id DESC LIMIT 1").first<Digest>();
}

export async function saveDigest(env: Env, fromMsg: number, toMsg: number, text: string, kind: "auto" | "manual"): Promise<void> {
  await env.DB.prepare("INSERT INTO digests (from_msg, to_msg, text, kind, at) VALUES (?, ?, ?, ?, ?)").bind(fromMsg, toMsg, text, kind, now()).run();
}

// ลบข้อความเก่ากว่า N วัน (นโยบายเก็บข้อมูล) — คืนจำนวนที่ลบ
export async function purgeOld(env: Env, days: number): Promise<number> {
  if (!(days > 0)) return 0;
  const cutoff = now() - days * 24 * 60 * 60 * 1000;
  const r = await env.DB.batch([
    env.DB.prepare("DELETE FROM messages WHERE at < ?").bind(cutoff),
    env.DB.prepare("DELETE FROM pa_chat WHERE at < ?").bind(cutoff),
    env.DB.prepare("DELETE FROM digests WHERE at < ?").bind(cutoff),
    env.DB.prepare("DELETE FROM events_seen WHERE at < ?").bind(now() - 7 * 24 * 60 * 60 * 1000),
  ]);
  return r[0].meta.changes ?? 0;
}

// ลบทุกอย่างของกลุ่มหนึ่ง (เมื่อมีคนขอให้ลบ หรือเลิกฟังกลุ่มนั้น)
export async function forgetGroup(env: Env, groupId: string): Promise<number> {
  const r = await env.DB.batch([
    env.DB.prepare("DELETE FROM messages WHERE group_id = ?").bind(groupId),
    env.DB.prepare("DELETE FROM members WHERE group_id = ?").bind(groupId),
    env.DB.prepare("DELETE FROM groups WHERE id = ?").bind(groupId),
  ]);
  return r[0].meta.changes ?? 0;
}

export async function digestsAfter(env: Env, afterId: number): Promise<Digest[]> {
  return (await env.DB.prepare("SELECT * FROM digests WHERE id > ? ORDER BY id").bind(afterId).all<Digest>()).results;
}

export async function chatHistory(env: Env, userId: string, turns = 10): Promise<{ role: "user" | "assistant"; text: string }[]> {
  const rows = (await env.DB.prepare("SELECT role, text FROM pa_chat WHERE user_id = ? ORDER BY id DESC LIMIT ?").bind(userId, turns * 2).all<{ role: "user" | "assistant"; text: string }>()).results;
  return rows.reverse();
}

export async function saveChat(env: Env, userId: string, role: "user" | "assistant", text: string): Promise<void> {
  await env.DB.prepare("INSERT INTO pa_chat (user_id, role, text, at) VALUES (?, ?, ?, ?)").bind(userId, role, text, now()).run();
}
