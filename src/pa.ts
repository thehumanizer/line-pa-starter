// คุยกับ PA แบบ 1:1 ในไลน์ — PA รู้เรื่องในกลุ่ม 2 วันล่าสุด + สรุปล่าสุด
import type { Env } from "./env";
import { formatTime } from "./env";
import { generate, type Turn } from "./ai";
import { chatSystem, renderMessages } from "./prompts";
import * as store from "./store";

const TWO_DAYS = 2 * 24 * 60 * 60 * 1000;

export async function chatWithPA(env: Env, userId: string, text: string): Promise<string> {
  const [history, recent, groups, digest] = await Promise.all([
    store.chatHistory(env, userId),
    store.recentMessages(env, Date.now() - TWO_DAYS),
    store.listGroups(env),
    store.lastDigest(env),
  ]);
  const today = formatTime(Date.now(), env.TIMEZONE, true);
  const context = [
    `กลุ่มที่เราฟังอยู่: ${groups.filter((g) => g.active).map((g) => g.name || "(ไม่มีชื่อ)").join(", ") || "ยังไม่มี"}`,
    digest ? `สรุปล่าสุดที่เราเขียนไว้:\n${digest.text}` : "",
    `ข้อความในกลุ่ม 2 วันล่าสุด:\n${renderMessages(env, recent, groups, 30000).text}`,
  ].filter(Boolean).join("\n\n");

  const turns: Turn[] = [
    { role: "user", content: `[ข้อมูลอ้างอิงสำหรับตอบคำถาม]\n${context}` },
    { role: "assistant", content: "รับทราบค่ะ จะใช้ข้อมูลนี้ตอบเท่านั้น" },
    ...history.map((h) => ({ role: h.role, content: h.text })),
    { role: "user", content: text },
  ];
  const answer = await generate(env, chatSystem(env, today), turns);
  await store.saveChat(env, userId, "user", text);
  await store.saveChat(env, userId, "assistant", answer);
  return answer;
}
