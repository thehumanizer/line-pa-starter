// ทางเข้าหลักของบอท
//   POST /webhook  ← ไลน์ส่งข้อความมาที่นี่
//   GET  /export   ← สคริปต์ npm run sync ดึงสมองกลางลงเครื่องเรา
//   /admin/*       ← MCP ในเครื่องเรา (mcp/server.mjs) เช็คสถานะ ค้นข้อความ ดูตัวอย่างสรุป
//   cron           ← สรุปทุกเช้าตามเวลาใน wrangler.toml
import type { Env, Job } from "./env";
import { timingSafeEqual, verifySignature, reply, push, showLoading, getGroupName, getMemberName, toBubbles } from "./line";
import * as store from "./store";
import { makeDigest } from "./digest";
import { chatWithPA } from "./pa";
import { handleAdmin } from "./admin";

type LineEvent = {
  type: string;
  webhookEventId?: string;
  replyToken?: string;
  timestamp: number;
  source: { type: "user" | "group" | "room"; userId?: string; groupId?: string; roomId?: string };
  message?: { id: string; type: string; text?: string };
};

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/" || url.pathname === "/health") return new Response(`${env.PA_NAME} พร้อมทำงานค่ะ`);

    if (url.pathname === "/webhook" && req.method === "POST") {
      const body = await req.text();
      if (!(await verifySignature(body, req.headers.get("x-line-signature"), env.LINE_CHANNEL_SECRET))) {
        return new Response("invalid signature", { status: 401 });
      }
      const { events = [] } = JSON.parse(body) as { events?: LineEvent[] };
      // ตอบไลน์ 200 ทันที แล้วค่อยทำงานต่อเบื้องหลัง — ทำทีละ event ลำดับข้อความจะได้ไม่สลับ
      ctx.waitUntil((async () => {
        for (const e of events) await handleEvent(env, e).catch((err) => console.error("event error:", err?.message ?? err));
      })());
      return new Response("ok");
    }

    if (url.pathname === "/export" && req.method === "GET") return exportBrain(req, env);
    if (url.pathname.startsWith("/admin/")) return handleAdmin(req, env, url);
    return new Response("not found", { status: 404 });
  },

  // งานในคิว: ไม่ติดเพดาน 30 วินาทีแบบตอนตอบไลน์
  async queue(batch: MessageBatch<Job>, env: Env): Promise<void> {
    for (const m of batch.messages) {
      if (m.body.type !== "digest") continue;
      let text: string;
      try {
        text = (await makeDigest(env, "manual")).text;
      } catch (err) {
        text = `ขอโทษค่ะ สรุปไม่สำเร็จ 😵 (${(err as Error).message.slice(0, 120)})`;
      }
      await push(env, m.body.userId, toBubbles(text));
    }
  },

  async scheduled(_c: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil((async () => {
      const d = await makeDigest(env, "auto");
      // กลุ่มเงียบก็ยังทักสั้นๆ เจ้าของจะได้รู้ว่าบอทยังทำงานอยู่
      const msg = d.count > 0 ? `☀️ สรุปเช้านี้\n\n${d.text}` : "☀️ อรุณสวัสดิ์ค่ะ เมื่อวานกลุ่มที่เราฟังอยู่เงียบ ไม่มีอะไรต้องตามค่ะ";
      await push(env, env.OWNER_USER_ID, toBubbles(msg));
      const purged = await store.purgeOld(env, Number(env.RETENTION_DAYS));
      if (purged) console.log(`ลบข้อความเก่ากว่า ${env.RETENTION_DAYS} วัน: ${purged} ข้อความ`);
    })().catch((err) => console.error("digest error:", err?.message ?? err)));
  },
};

async function handleEvent(env: Env, e: LineEvent): Promise<void> {
  if (e.webhookEventId && !(await store.markSeen(env, e.webhookEventId))) return; // ไลน์ส่งซ้ำ
  const src = e.source;

  // ---------- ในกลุ่ม: ฟังอย่างเดียว ไม่ตอบ ----------
  if (src.type === "group" || src.type === "room") {
    const groupId = (src.groupId ?? src.roomId)!;
    if (e.type === "join") {
      const name = src.type === "group" ? await getGroupName(env, groupId) : null;
      await store.upsertGroup(env, groupId, src.type, name);
      if (env.JOIN_NOTICE === "on" && e.replyToken) {
        await reply(env, e.replyToken, [
          `สวัสดีค่ะ เรา ${env.PA_NAME} ผู้ช่วยส่วนตัวของเจ้าของบัญชีนี้ค่ะ 🙏`,
          "เราจะเก็บข้อความในกลุ่มนี้ไว้เพื่อสรุปงานให้เจ้าของบัญชีเท่านั้น จะไม่ตอบหรือส่งต่อให้ใคร ถ้าไม่สะดวกให้เราอยู่ เชิญเราออกจากกลุ่มได้เลยค่ะ",
        ]);
      }
      return;
    }
    if (e.type === "leave") return store.setGroupActive(env, groupId, false);
    if (e.type === "message" && e.message) {
      if (!(await store.getGroup(env, groupId))) {
        await store.upsertGroup(env, groupId, src.type, src.type === "group" ? await getGroupName(env, groupId) : null);
      }
      let name: string | null = null;
      if (src.userId) {
        name = await store.getMember(env, groupId, src.userId);
        if (!name) {
          name = await getMemberName(env, src.type, groupId, src.userId);
          if (name) await store.saveMember(env, groupId, src.userId, name);
        }
      }
      await store.saveMessage(env, {
        lineId: e.message.id, groupId, userId: src.userId, name,
        type: e.message.type, text: e.message.type === "text" ? e.message.text ?? "" : null, at: e.timestamp,
      });
    }
    return;
  }

  // ---------- แชท 1:1 ----------
  if (src.type !== "user" || !src.userId || !e.replyToken) return;
  const isOwner = src.userId === env.OWNER_USER_ID;

  if (e.type === "follow") {
    await reply(env, e.replyToken, [isOwner ? `สวัสดีค่ะ เรา ${env.PA_NAME} เอง พร้อมทำงานแล้วค่ะ ✨` : `สวัสดีค่ะ บัญชีนี้เป็นผู้ช่วยส่วนตัว ยังตอบคนอื่นไม่ได้นะคะ 🙏`]);
    return;
  }
  if (e.type !== "message" || e.message?.type !== "text") return;

  // คนอื่นที่ไม่ใช่เจ้าของ ห้ามถามข้อมูลในสมองกลางเด็ดขาด
  if (!isOwner) {
    await reply(env, e.replyToken, ["ขอโทษค่ะ บัญชีนี้เป็นผู้ช่วยส่วนตัว ตอบได้เฉพาะเจ้าของบัญชีเท่านั้นค่ะ 🙏"]);
    return;
  }

  const text = (e.message.text ?? "").trim();
  await showLoading(env, src.userId);
  let answer: string;
  try {
    if (text === "กลุ่ม") {
      const groups = (await store.listGroups(env)).filter((g) => g.active);
      answer = groups.length ? `ตอนนี้เราฟังอยู่ ${groups.length} กลุ่มค่ะ\n\n${groups.map((g) => `- ${g.name || "(ไม่มีชื่อ)"}`).join("\n")}` : "ยังไม่ได้อยู่ในกลุ่มไหนเลยค่ะ ลองเชิญเราเข้ากลุ่มดูนะคะ";
    } else if (text === "สรุป") {
      // สรุปอาจนานเกิน 30 วินาที → ส่งไปทำในคิว แล้วค่อยส่งผลตามมา
      if (env.JOBS) {
        await env.JOBS.send({ type: "digest", userId: src.userId });
        answer = "รับทราบค่ะ กำลังสรุปให้ เสร็จแล้วจะส่งตามมานะคะ ⏳";
      } else {
        answer = (await makeDigest(env, "manual")).text;
      }
    } else if (text.startsWith("ลบกลุ่ม ")) {
      const name = text.slice("ลบกลุ่ม ".length).trim();
      const g = (await store.listGroups(env)).find((x) => x.name === name);
      answer = g
        ? `ลบข้อมูลกลุ่ม "${name}" แล้วค่ะ (${await store.forgetGroup(env, g.id)} ข้อความ) ถ้าไม่อยากให้เก็บต่อ อย่าลืมเชิญเราออกจากกลุ่มด้วยนะคะ`
        : `ไม่เจอกลุ่มชื่อ "${name}" ค่ะ พิมพ์ "กลุ่ม" เพื่อดูชื่อที่ถูกต้อง`;
    } else {
      answer = await chatWithPA(env, src.userId, text);
    }
  } catch (err) {
    console.error("pa error:", (err as Error).message);
    answer = `ขอโทษค่ะ ตอนนี้เราคิดไม่ออก 😵 (${(err as Error).message.slice(0, 120)})`;
  }
  // reply token ใช้ได้ไม่นาน ถ้าตอบไม่ทันให้ส่งแบบ push แทน
  const bubbles = toBubbles(answer);
  if (!(await reply(env, e.replyToken, bubbles))) await push(env, src.userId, bubbles);
}

// ให้ npm run sync ดึงข้อมูลลงเครื่อง (ต้องมี EXPORT_TOKEN ถูกต้องเท่านั้น)
async function exportBrain(req: Request, env: Env): Promise<Response> {
  const auth = req.headers.get("authorization") ?? "";
  if (!env.EXPORT_TOKEN || !timingSafeEqual(auth, `Bearer ${env.EXPORT_TOKEN}`)) return new Response("unauthorized", { status: 401 });
  const url = new URL(req.url);
  const after = Number(url.searchParams.get("after") ?? 0);
  const afterDigest = Number(url.searchParams.get("after_digest") ?? 0);
  const [groups, messages, digests] = await Promise.all([
    store.listGroups(env),
    store.messagesAfter(env, after, 2000),
    store.digestsAfter(env, afterDigest),
  ]);
  return Response.json({ groups, messages, digests, more: messages.length === 2000 });
}
