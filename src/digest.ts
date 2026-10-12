// สรุปข้อความในกลุ่มตั้งแต่สรุปครั้งก่อน
import type { Env } from "./env";
import { formatTime } from "./env";
import { generate } from "./ai";
import { digestSystem, renderMessages } from "./prompts";
import * as store from "./store";

export type DigestResult = { text: string; count: number };

const MAX_MESSAGES = 1500; // กันสรุปทีเดียวยาวเกิน (เปิดบอททิ้งไว้หลายวัน / ติด limit ของ AI ฟรี)

// kind "auto" = สรุปตอนเช้า (เลื่อนจุดเริ่มรอบถัดไป) · "manual" = พิมพ์ "สรุป" เอง (ไม่กระทบสรุปตอนเช้า)
// opts.save = false → สรุปให้ดูเฉยๆ ไม่บันทึก (MCP ดูตัวอย่าง) · opts.pattern = ลองสูตรสรุปใหม่
export async function makeDigest(env: Env, kind: "auto" | "manual", opts: { save?: boolean; pattern?: string } = {}): Promise<DigestResult> {
  const prev = await store.lastDigest(env, "auto");
  let msgs = await store.messagesAfter(env, prev?.to_msg ?? 0, 100000);
  if (msgs.length === 0) return { text: "ยังไม่มีข้อความใหม่ในกลุ่มตั้งแต่สรุปเช้าครั้งก่อนค่ะ", count: 0 };
  const skipped = Math.max(0, msgs.length - MAX_MESSAGES);
  if (skipped) msgs = msgs.slice(-MAX_MESSAGES);

  const groups = await store.listGroups(env);
  const today = formatTime(Date.now(), env.TIMEZONE, true);
  const data = renderMessages(env, msgs, groups);
  const previous = prev ? `สรุปครั้งก่อน (ใช้ดูว่างานไหนยังค้าง):\n${prev.text}\n\n` : "";
  const note = skipped ? `(มีข้อความเก่ากว่านี้อีก ${skipped} ข้อความที่ไม่ได้ใส่มา เพราะยาวเกิน ให้บอกเจ้านายด้วย)\n` : "";
  const text = await generate(env, digestSystem(env, today, opts.pattern), [
    { role: "user", content: `${previous}${note}ข้อความใหม่จากกลุ่มไลน์ ${msgs.length} ข้อความ:\n${data.text}\n\nสรุปตามรูปแบบที่กำหนด` },
  ], "digest");
  if (opts.save !== false) await store.saveDigest(env, msgs[0].id, msgs[msgs.length - 1].id, text, kind);
  return { text, count: msgs.length };
}
