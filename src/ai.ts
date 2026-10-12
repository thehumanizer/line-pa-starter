// ตัวเชื่อม AI แบบบางๆ — เปลี่ยนเจ้าได้ที่ AI_PROVIDER ใน wrangler.toml
import Anthropic from "@anthropic-ai/sdk";
import type { Env } from "./env";

export type Turn = { role: "user" | "assistant"; content: string };

// chat = ตอบแชท 1:1 ต้องเสร็จก่อน Cloudflare ตัดงานที่ 30 วินาที · digest = สรุป (รันในคิว/cron ได้นาน)
export type Task = "chat" | "digest";

// ระบุรุ่นให้ชัด ไม่ใช้ชื่อ -latest (รุ่นจะได้ไม่เปลี่ยนเองโดยไม่บอก)
// Claude: แชทใช้ Sonnet (ไว) · เขียนสรุปใช้ Opus (คุณภาพสูงสุด)
const DEFAULT_MODEL: Record<string, Record<Task, string>> = {
  gemini: { chat: "gemini-3.8-flash", digest: "gemini-3.8-flash" },
  claude: { chat: "claude-sonnet-5-5", digest: "claude-opus-5-5" },
};
const TIMEOUT_MS: Record<Task, number> = { chat: 22_000, digest: 300_000 };

export async function generate(env: Env, system: string, turns: Turn[], task: Task = "chat"): Promise<string> {
  const provider = (env.AI_PROVIDER || "gemini").toLowerCase();
  const model = env.AI_MODEL || DEFAULT_MODEL[provider]?.[task] || "";
  if (provider === "mock") return mock(turns);
  if (!env.AI_API_KEY) throw new Error("ยังไม่ได้ตั้ง AI_API_KEY");
  if (provider === "gemini") return gemini(env.AI_API_KEY, model, system, turns, task);
  if (provider === "claude") return claude(env.AI_API_KEY, model, system, turns, task);
  if (provider === "openai") return openaiCompatible(env, model, system, turns, task);
  throw new Error(`ไม่รู้จัก AI_PROVIDER "${provider}" (ใช้ได้: gemini, claude, openai, mock)`);
}

async function gemini(key: string, model: string, system: string, turns: Turn[], task: Task): Promise<string> {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: turns.map((t) => ({ role: t.role === "assistant" ? "model" : "user", parts: [{ text: t.content }] })),
      // รุ่น 3.x คิดก่อนตอบ และ token ที่ใช้คิดนับรวมในเพดานนี้ด้วย จึงเผื่อไว้เยอะ
      generationConfig: { maxOutputTokens: 16384 },
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS[task]),
  });
  // ไม่พิมพ์ key ลง log ไม่ว่ากรณีไหน — บอกแค่รหัสสถานะ
  if (!res.ok) throw new Error(`Gemini ตอบกลับ ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  if (!text) throw new Error("Gemini ไม่ส่งข้อความกลับมา");
  return text;
}

async function claude(key: string, model: string, system: string, turns: Turn[], task: Task): Promise<string> {
  const client = new Anthropic({ apiKey: key, timeout: TIMEOUT_MS[task], maxRetries: task === "chat" ? 0 : 2 });
  // fallbacks: "default" = ถ้าโมเดลหลักปฏิเสธ ให้ Anthropic ส่งต่อโมเดลสำรองให้เอง
  const params = {
    model,
    max_tokens: 16000,
    system,
    messages: turns,
    output_config: { effort: task === "chat" ? "low" : "medium" },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
  };
  const res = await client.beta.messages.create(params as unknown as Parameters<typeof client.beta.messages.create>[0]) as Anthropic.Beta.BetaMessage;
  if (res.stop_reason === "refusal") return "ขอโทษค่ะ เรื่องนี้ตอบให้ไม่ได้";
  return res.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
}

// เจ้าอื่นที่ใช้รูปแบบเดียวกับ OpenAI (OpenAI, DeepSeek, Typhoon ฯลฯ) — ตั้ง AI_BASE_URL และ AI_MODEL ใน wrangler.toml
async function openaiCompatible(env: Env, model: string, system: string, turns: Turn[], task: Task): Promise<string> {
  if (!env.AI_BASE_URL || !model) throw new Error("ใช้ openai ต้องตั้ง AI_BASE_URL และ AI_MODEL ใน wrangler.toml");
  const res = await fetch(`${env.AI_BASE_URL.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.AI_API_KEY}` },
    body: JSON.stringify({ model, messages: [{ role: "system", content: system }, ...turns] }),
    signal: AbortSignal.timeout(TIMEOUT_MS[task]),
  });
  if (!res.ok) throw new Error(`AI ตอบกลับ ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const text = data.choices?.[0]?.message?.content ?? "";
  if (!text) throw new Error("AI ไม่ส่งข้อความกลับมา");
  return text;
}

// โหมดทดสอบ: ไม่เรียก AI จริง ไม่เสียโควต้า
function mock(turns: Turn[]): string {
  const last = turns[turns.length - 1]?.content ?? "";
  return `(โหมดทดสอบ) ได้รับข้อความแล้ว ${last.length} ตัวอักษร\n\nถ้าเห็นข้อความนี้ แปลว่าท่อทั้งหมดต่อกันครบแล้ว เหลือแค่เปลี่ยน AI_PROVIDER เป็นของจริง`;
}
