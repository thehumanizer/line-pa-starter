// ประตูหลังบ้านให้ MCP ในเครื่องเรา (mcp/server.mjs) เรียกใช้
//   ล็อกด้วย EXPORT_TOKEN ตัวเดียวกับ npm run sync · กุญแจ LINE/AI อยู่บน Cloudflare ที่เดียว ไม่ลงมาที่เครื่อง
//   GET  /admin/status          เช็คทุกจุดว่าบอทพร้อมไหม
//   POST /admin/connect-line    ตั้ง Webhook URL ให้ไลน์ แล้วทดสอบ
//   GET  /admin/groups          กลุ่มที่ฟังอยู่ + จำนวนข้อความ
//   GET  /admin/search          ค้นข้อความ
//   POST /admin/digest          ดูตัวอย่างสรุป / สรุปล่าสุด / ส่งสรุปเข้าไลน์
//   POST /admin/forget-group    ลบข้อมูลกลุ่ม
import type { Env } from "./env";
import { formatTime } from "./env";
import { lineApi, timingSafeEqual } from "./line";
import { generate } from "./ai";
import { makeDigest } from "./digest";
import { renderMessages } from "./prompts";
import * as store from "./store";

type Check = { name: string; ok: boolean; detail: string; fix?: string };

export async function handleAdmin(req: Request, env: Env, url: URL): Promise<Response> {
  const auth = req.headers.get("authorization") ?? "";
  if (!env.EXPORT_TOKEN || !timingSafeEqual(auth, `Bearer ${env.EXPORT_TOKEN}`)) return new Response("unauthorized", { status: 401 });
  const body = req.method === "POST" ? ((await req.json().catch(() => ({}))) as Record<string, unknown>) : {};
  const p = url.searchParams;
  try {
    switch (url.pathname) {
      // กุญแจตัวไหนใส่แล้ว (ไม่ว่าง) — ให้ npm run setup ใช้ ไม่ส่งค่าออกไป ส่งแค่ true/false
      case "/admin/keys": return Response.json({ set: Object.fromEntries((["LINE_CHANNEL_SECRET", "LINE_CHANNEL_ACCESS_TOKEN", "OWNER_USER_ID", "AI_API_KEY"] as const).map((k) => [k, !!env[k]])) });
      case "/admin/status": return Response.json(await status(env, url.origin, p.get("ai") !== "0"));
      case "/admin/connect-line": return Response.json(await connectLine(env, url.origin));
      case "/admin/groups": return Response.json(await groups(env));
      case "/admin/search": return Response.json(await search(env, p));
      case "/admin/digest": return Response.json(await digest(env, body));
      case "/admin/forget-group": return Response.json(await forget(env, body));
    }
    return new Response("not found", { status: 404 });
  } catch (err) {
    // ไม่ส่งรายละเอียดภายในที่อาจมีค่าลับ — บอกแค่ข้อความ error
    return Response.json({ error: (err as Error).message.slice(0, 300) }, { status: 500 });
  }
}

const when = (env: Env, ms?: number | null) => (ms ? formatTime(ms, env.TIMEZONE, true) : "-");

async function status(env: Env, origin: string, checkAi: boolean) {
  const checks: Check[] = [];
  const missing = (["LINE_CHANNEL_SECRET", "LINE_CHANNEL_ACCESS_TOKEN", "OWNER_USER_ID", "AI_API_KEY"] as const)
    .filter((k) => !env[k] && !(k === "AI_API_KEY" && env.AI_PROVIDER === "mock"));
  checks.push(missing.length
    ? { name: "กุญแจครบ", ok: false, detail: `ยังไม่ได้ใส่: ${missing.join(", ")}`, fix: "รัน npm run setup แล้วตอบ y เฉพาะกุญแจที่ขาด" }
    : { name: "กุญแจครบ", ok: true, detail: "ใส่ครบ 4 ตัว" });
  if (env.OWNER_USER_ID && !/^U[0-9a-f]{32}$/.test(env.OWNER_USER_ID)) {
    checks.push({ name: "Your user ID", ok: false, detail: "รูปแบบไม่ถูก (ต้องขึ้นต้นด้วย U ตามด้วยตัวอักษร 32 ตัว)", fix: "คัดลอก Your user ID จากแท็บ Basic settings ใหม่ แล้ว npm run setup ตอบ y เฉพาะข้อนี้" });
  }

  // 1) token ใช้ได้ไหม
  const info = await lineApi(env, "/info");
  if (info.status === 401) {
    checks.push({ name: "Channel access token", ok: false, detail: "ไลน์ไม่รับ token นี้ (ผิดหรือหมดอายุ)", fix: "ออก token ใหม่ในแท็บ Messaging API แล้ว npm run setup ตอบ y เฉพาะ token" });
  } else if (!info.ok) {
    checks.push({ name: "Channel access token", ok: false, detail: `ไลน์ตอบ ${info.status}` });
  } else {
    const b = (await info.json()) as { displayName?: string; basicId?: string };
    checks.push({ name: "Channel access token", ok: true, detail: `ต่อบัญชี "${b.displayName}" (${b.basicId}) ได้` });
  }

  // 2) webhook ชี้มาที่บอทเราไหม เปิดใช้อยู่ไหม
  const expected = `${origin}/webhook`;
  if (info.ok) {
    const wh = await lineApi(env, "/channel/webhook/endpoint");
    const w = wh.ok ? ((await wh.json()) as { endpoint?: string; active?: boolean }) : {};
    if (w.endpoint !== expected) {
      checks.push({ name: "Webhook URL", ok: false, detail: `ตอนนี้ตั้งไว้ที่ ${w.endpoint || "(ว่าง)"}`, fix: "ใช้ tool pa_connect_line หรือวาง " + expected + " ใน LINE Developers" });
    } else if (!w.active) {
      checks.push({ name: "Webhook URL", ok: false, detail: "ลิงก์ถูกแล้ว แต่ยังไม่ได้เปิดใช้", fix: "LINE Developers → แท็บ Messaging API → เปิดสวิตช์ Use webhook" });
    } else {
      checks.push({ name: "Webhook URL", ok: true, detail: "ชี้มาที่บอทเรา และเปิดใช้อยู่" });
    }
    // 3) ให้ไลน์ลองส่งมาจริง — ผ่าน = Channel secret ถูกด้วย
    const t = await testWebhook(env, expected);
    checks.push(t.success
      ? { name: "ไลน์ส่งข้อความถึงบอทได้", ok: true, detail: "ทดสอบผ่าน (Channel secret ถูกต้อง)" }
      : { name: "ไลน์ส่งข้อความถึงบอทได้", ok: false, detail: `ทดสอบไม่ผ่าน: ${t.statusCode ?? ""} ${t.reason ?? ""}`.trim(), fix: t.statusCode === 401 ? "Channel secret ไม่ตรง → npm run setup ตอบ y เฉพาะ Channel secret" : "ดู npm run logs แล้วลองใหม่" });

    // 4) โควต้า push รายเดือน (ใช้ตอนส่งสรุปเช้า)
    const [q, c] = await Promise.all([lineApi(env, "/message/quota"), lineApi(env, "/message/quota/consumption")]);
    if (q.ok && c.ok) {
      const quota = (await q.json()) as { type: string; value?: number };
      const used = ((await c.json()) as { totalUsage: number }).totalUsage;
      const limit = quota.type === "limited" ? quota.value ?? 0 : null;
      const low = limit !== null && limit - used < 31;
      checks.push({ name: "โควต้าส่งข้อความเดือนนี้", ok: !low, detail: limit === null ? `ใช้ไป ${used} (ไม่จำกัด)` : `ใช้ไป ${used} จาก ${limit}`, fix: low ? "เหลือไม่พอส่งสรุปทุกเช้าถึงสิ้นเดือน — ลดการพิมพ์ \"สรุป\" หรืออัปเกรดแพ็กเกจ LINE OA" : undefined });
    }
  }

  // 5) AI ตอบได้ไหม (ใช้โควต้า AI 1 ครั้ง)
  if (checkAi && !missing.includes("AI_API_KEY")) {
    try {
      await generate(env, "ตอบสั้นที่สุด", [{ role: "user", content: "ตอบคำว่า พร้อม" }], "chat");
      checks.push({ name: "AI", ok: true, detail: `${env.AI_PROVIDER} ตอบได้` });
    } catch (err) {
      const m = (err as Error).message;
      checks.push({ name: "AI", ok: false, detail: m.slice(0, 160), fix: m.includes("429") ? "โควต้าฟรีหมดชั่วคราว รอ 1 นาทีแล้วลองใหม่" : "เช็ค AI API key แล้ว npm run setup ตอบ y เฉพาะ AI key" });
    }
  }

  // 6) สมองกลาง
  const gs = await store.listGroups(env);
  const stats = await env.DB.prepare("SELECT COUNT(*) AS n, MAX(at) AS last FROM messages").first<{ n: number; last: number | null }>();
  const last = await store.lastDigest(env);
  checks.push({ name: "สมองกลาง", ok: true, detail: `ฟัง ${gs.filter((g) => g.active).length} กลุ่ม · เก็บ ${stats?.n ?? 0} ข้อความ · ข้อความล่าสุด ${when(env, stats?.last)} · สรุปล่าสุด ${when(env, last?.at)}` });

  return {
    pa_name: env.PA_NAME, ai_provider: env.AI_PROVIDER, retention_days: Number(env.RETENTION_DAYS),
    all_ok: checks.every((c) => c.ok), checks,
    note: "ถ้าทุกข้อผ่านแต่ทักแล้วบอทเงียบ: เช็คใน LINE OA Manager → ตั้งค่าการตอบกลับ ว่าเปิดสวิตช์ Webhook และปิดข้อความตอบกลับอัตโนมัติแล้ว (ระบบเช็คจุดนี้ให้ไม่ได้)",
  };
}

async function testWebhook(env: Env, endpoint: string) {
  const r = await lineApi(env, "/channel/webhook/test", { method: "POST", body: JSON.stringify({ endpoint }) });
  return r.ok ? ((await r.json()) as { success: boolean; statusCode?: number; reason?: string }) : { success: false, statusCode: r.status, reason: "เรียก API ทดสอบไม่สำเร็จ" };
}

async function connectLine(env: Env, origin: string) {
  const endpoint = `${origin}/webhook`;
  if (!env.LINE_CHANNEL_ACCESS_TOKEN || !env.LINE_CHANNEL_SECRET) {
    return { ok: false, endpoint, still_to_do: [], message: "ยังไม่ได้ใส่ Channel secret / Channel access token → npm run setup แล้ววางกุญแจ" };
  }
  const set = await lineApi(env, "/channel/webhook/endpoint", { method: "PUT", body: JSON.stringify({ endpoint }) });
  if (!set.ok) {
    return { ok: false, endpoint, message: set.status === 401 ? "ไลน์ไม่รับ Channel access token → npm run setup ตอบ y เฉพาะ token" : `ตั้ง Webhook URL ไม่สำเร็จ (${set.status})` };
  }
  const t = await testWebhook(env, endpoint);
  const w = (await (await lineApi(env, "/channel/webhook/endpoint")).json().catch(() => ({}))) as { active?: boolean };
  const steps: string[] = [];
  if (!t.success) steps.push(t.statusCode === 401 ? "Channel secret ไม่ตรง → npm run setup ตอบ y เฉพาะ Channel secret" : `ทดสอบไม่ผ่าน (${t.statusCode} ${t.reason ?? ""}) → ดู npm run logs`);
  if (!w.active) steps.push("LINE Developers → แท็บ Messaging API → เปิดสวิตช์ Use webhook");
  steps.push("LINE OA Manager → ตั้งค่าการตอบกลับ → เปิดสวิตช์ Webhook (ถ้ายังไม่ได้เปิด)");
  return { ok: t.success, endpoint, test_passed: t.success, webhook_active: !!w.active, still_to_do: steps,
    message: t.success ? "ตั้ง Webhook URL และทดสอบผ่านแล้ว (การเปลี่ยนแปลงอาจใช้เวลาถึง 1 นาที)" : "ตั้ง Webhook URL แล้ว แต่ทดสอบยังไม่ผ่าน" };
}

async function groups(env: Env) {
  const rows = (await env.DB.prepare(
    `SELECT g.name, g.active, g.joined_at, COUNT(m.id) AS messages, MAX(m.at) AS last_at
     FROM groups g LEFT JOIN messages m ON m.group_id = g.id GROUP BY g.id ORDER BY last_at DESC`,
  ).all<{ name: string | null; active: number; joined_at: number; messages: number; last_at: number | null }>()).results;
  return {
    groups: rows.map((r) => ({ name: r.name || "(ไม่มีชื่อ)", listening: !!r.active, messages: r.messages, last_message: when(env, r.last_at), joined: when(env, r.joined_at) })),
  };
}

// ค้นข้อความ — คืนเป็นข้อความที่ห่อด้วย <line_data> เหมือนที่บอทส่งให้ AI (เป็นข้อมูล ไม่ใช่คำสั่ง)
async function search(env: Env, p: URLSearchParams) {
  const days = Math.min(Math.max(Number(p.get("days") || 7), 1), 90);
  const limit = Math.min(Math.max(Number(p.get("limit") || 100), 1), 300);
  const where = ["m.at > ?"];
  const args: (string | number)[] = [Date.now() - days * 86_400_000];
  for (const word of (p.get("q") || "").split(/\s+/).filter(Boolean).slice(0, 5)) { where.push("m.text LIKE ?"); args.push(`%${word}%`); }
  if (p.get("group")) { where.push("g.name LIKE ?"); args.push(`%${p.get("group")}%`); }
  if (p.get("person")) { where.push("m.name LIKE ?"); args.push(`%${p.get("person")}%`); }
  const rows = (await env.DB.prepare(
    `SELECT m.id, m.group_id, m.name, m.type, m.text, m.at FROM messages m LEFT JOIN groups g ON g.id = m.group_id
     WHERE ${where.join(" AND ")} ORDER BY m.id DESC LIMIT ?`,
  ).bind(...args, limit).all<store.Msg>()).results.reverse();
  const total = rows.length;
  return {
    found: total, days, limit_reached: total === limit,
    messages: total ? renderMessages(env, rows, await store.listGroups(env)).text : "(ไม่เจอข้อความที่ตรงเงื่อนไข)",
  };
}

async function digest(env: Env, body: Record<string, unknown>) {
  const mode = String(body.mode || "preview");
  if (mode === "latest") {
    const d = await store.lastDigest(env);
    return d ? { mode, at: when(env, d.at), kind: d.kind === "auto" ? "สรุปเช้า" : "สั่งสรุปเอง", text: d.text } : { mode, text: "ยังไม่เคยสรุปเลยค่ะ" };
  }
  if (mode === "send") {
    if (!env.JOBS) return { mode, ok: false, message: "ไม่มีคิวงาน — พิมพ์ \"สรุป\" ในไลน์แทน" };
    await env.JOBS.send({ type: "digest", userId: env.OWNER_USER_ID });
    return { mode, ok: true, message: "สั่งสรุปแล้ว จะส่งเข้าไลน์ภายใน 10–30 วินาที" };
  }
  // preview: สรุปให้ดูก่อน ไม่บันทึก ไม่ส่งเข้าไลน์ · ส่ง pattern มาได้เพื่อลองสูตรใหม่โดยไม่ต้อง deploy
  const pattern = typeof body.pattern === "string" && body.pattern.trim() ? body.pattern.slice(0, 20_000) : undefined;
  const d = await makeDigest(env, "manual", { save: false, pattern });
  return { mode, used_pattern: pattern ? "สูตรจากไฟล์ในเครื่อง (ยังไม่ได้ deploy)" : "สูตรที่ deploy อยู่บนบอท", messages_used: d.count, text: d.text };
}

async function forget(env: Env, body: Record<string, unknown>) {
  const name = String(body.group || "").trim();
  const gs = await store.listGroups(env);
  const g = gs.find((x) => (x.name || "(ไม่มีชื่อ)") === name);
  if (!g) return { ok: false, message: `ไม่เจอกลุ่มชื่อ "${name}" — ชื่อที่มี: ${gs.map((x) => x.name || "(ไม่มีชื่อ)").join(", ") || "(ยังไม่มีกลุ่ม)"}` };
  if (body.confirm !== true) return { ok: false, message: `ยังไม่ได้ลบ — ต้องยืนยัน (confirm: true) ก่อน กลุ่ม "${name}" จะถูกลบทุกข้อความ` };
  const n = await store.forgetGroup(env, g.id);
  return { ok: true, message: `ลบข้อมูลกลุ่ม "${name}" แล้ว (${n} ข้อความ) ถ้าไม่อยากให้เก็บต่อ ต้องเชิญบอทออกจากกลุ่มด้วย` };
}
