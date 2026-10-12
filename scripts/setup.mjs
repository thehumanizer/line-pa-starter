// ตั้งค่าบอทครั้งแรกแบบทีละขั้น: สร้างสมองกลาง → deploy → ใส่กุญแจ → ได้ลิงก์ Webhook
// ใช้: npm run setup   (รันซ้ำได้ ขั้นไหนทำแล้วจะข้ามให้)
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = async (q, def = "") => (await rl.question(def ? `${q} [${def}]: ` : `${q}: `)).trim() || def;
const step = (n, t) => console.log(`\n\x1b[32m━━ ขั้นที่ ${n}: ${t}\x1b[0m`);
const fail = (msg) => { console.error(`\n\x1b[31m✗ ${msg}\x1b[0m`); rl.close(); process.exit(1); };
const LOGIN_LOST = /not logged in|not authenticated|non-interactive environment|CLOUDFLARE_API_TOKEN/i;
const wrangler = (args, opts = {}) => {
  const r = spawnSync("npx", ["wrangler", ...args], { encoding: "utf8", shell: process.platform === "win32", ...opts });
  // ล็อกอิน Cloudflare หมดอายุกลางทาง → บอกเป็นภาษาคน แทนข้อความ error ยาวๆ ของ wrangler
  if (r.status !== 0 && LOGIN_LOST.test(`${r.stdout ?? ""}${r.stderr ?? ""}`)) {
    fail("ล็อกอิน Cloudflare หมดอายุ → พิมพ์ npx wrangler login กด Allow ในเบราว์เซอร์ แล้วรัน npm run setup ใหม่ (ขั้นที่ทำแล้วจะข้ามให้)");
  }
  return r;
};
const loggedIn = () => spawnSync("npx", ["wrangler", "whoami", "--json"], { encoding: "utf8", shell: process.platform === "win32" }).status === 0;

let toml = readFileSync("wrangler.toml", "utf8");
const DB_NAME = toml.match(/database_name\s*=\s*"([^"]+)"/)[1];

step(1, "เช็คว่าล็อกอิน Cloudflare แล้ว");
// whoami --json จบด้วย error ทุกกรณีที่ใช้งานไม่ได้ (ไม่เคยล็อกอิน / token หมดอายุ)
if (!loggedIn()) {
  console.log("ยังไม่ได้ล็อกอิน หรือล็อกอินหมดอายุ กำลังเปิดเบราว์เซอร์ให้กด Allow…");
  spawnSync("npx", ["wrangler", "login"], { stdio: "inherit", shell: process.platform === "win32" });
  if (!loggedIn()) fail("ล็อกอินไม่สำเร็จ ลองรัน npx wrangler login เองอีกครั้ง แล้วค่อย npm run setup");
}
console.log("✓ ล็อกอินแล้ว");

step(2, "ตั้งชื่อบอท");
const curName = toml.match(/^name\s*=\s*"([^"]+)"/m)[1];
const curPa = toml.match(/PA_NAME\s*=\s*"([^"]*)"/)[1];
const workerName = (await ask("ชื่อบอทบน Cloudflare (อังกฤษตัวเล็ก ไม่มีเว้นวรรค)", curName)).toLowerCase().replace(/[^a-z0-9-]/g, "-");
const paName = await ask("ชื่อ PA ของเรา", curPa);
const queueName = `${workerName}-jobs`;
toml = toml.replace(/^name\s*=\s*"[^"]+"/m, `name = "${workerName}"`).replace(/PA_NAME\s*=\s*"[^"]*"/, `PA_NAME = "${paName}"`)
  .replace(/queue\s*=\s*"[^"]+"/g, `queue = "${queueName}"`);
writeFileSync("wrangler.toml", toml);
console.log(`✓ บอทชื่อ ${workerName} · PA ชื่อ ${paName}`);

step(3, "สร้างสมองกลาง (D1)");
let dbId = toml.match(/database_id\s*=\s*"([^"]+)"/)[1];
if (dbId.startsWith("00000000")) {
  const list = wrangler(["d1", "list", "--json"]);
  let found = null;
  try { found = JSON.parse(list.stdout || "[]").find?.((d) => d.name === DB_NAME); } catch { /* wrangler อาจพิมพ์คำเตือนปนมา ข้ามไปสร้างใหม่ */ }
  if (found) dbId = found.uuid;
  else {
    const out = wrangler(["d1", "create", DB_NAME]);
    dbId = (out.stdout + out.stderr).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)?.[0];
    if (!dbId) fail(`สร้าง D1 ไม่สำเร็จ:\n${out.stdout}${out.stderr}`);
  }
  toml = toml.replace(/database_id\s*=\s*"[^"]+"/, `database_id = "${dbId}"`);
  writeFileSync("wrangler.toml", toml);
}
console.log(`✓ สมองกลาง ${DB_NAME} พร้อม`);
if (wrangler(["d1", "execute", DB_NAME, "--remote", "--file=schema.sql"], { stdio: "inherit" }).status !== 0) fail("สร้างตารางใน D1 ไม่สำเร็จ");
console.log("✓ สร้างตารางเรียบร้อย");

step("3.5", "สร้างคิวงานหนัก (ใช้ตอนพิมพ์ \"สรุป\")");
const q = wrangler(["queues", "create", queueName]);
if (q.status !== 0 && !/already exists|already taken|11009/i.test(q.stdout + q.stderr)) fail(`สร้างคิวไม่สำเร็จ:\n${q.stdout}${q.stderr}`);
console.log(`✓ คิว ${queueName} พร้อม`);

step(4, "Deploy บอทขึ้น Cloudflare");
let deploy = wrangler(["deploy"]);
process.stdout.write(deploy.stdout || "");
if (deploy.status !== 0) {
  console.log("ครั้งแรก Cloudflare อาจถามชื่อ subdomain ให้ตอบตามที่ขึ้นมาได้เลย");
  deploy = wrangler(["deploy"], { stdio: "inherit" });
  if (deploy.status !== 0) fail("Deploy ไม่สำเร็จ ดูข้อความสีแดงด้านบน");
}
let workerUrl = (deploy.stdout || "").match(/https:\/\/[^\s]+\.workers\.dev/)?.[0];
if (!workerUrl) workerUrl = await ask("วางลิงก์ที่ลงท้ายด้วย .workers.dev ที่เห็นด้านบน");
workerUrl = workerUrl.replace(/\/$/, "");
console.log(`✓ บอทอยู่ที่ ${workerUrl}`);

step(5, "ใส่กุญแจ (พิมพ์แล้วจะไม่เห็นตัวอักษร เป็นเรื่องปกติ)");
const secrets = [
  ["LINE_CHANNEL_SECRET", "Channel secret (จาก LINE Developers แท็บ Basic settings)"],
  ["LINE_CHANNEL_ACCESS_TOKEN", "Channel access token (แท็บ Messaging API)"],
  ["OWNER_USER_ID", "Your user ID (ขึ้นต้นด้วย U)"],
  ["AI_API_KEY", "AI API key (Gemini หรือ Claude)"],
];
for (const [key, label] of secrets) {
  if ((await ask(`ใส่ ${label} ตอนนี้ไหม? (y = ใส่, n = ข้ามเพราะใส่ไว้แล้ว)`, "y")).toLowerCase() !== "y") continue;
  console.log(`→ วาง ${label} แล้วกด Enter`);
  if (wrangler(["secret", "put", key], { stdio: "inherit" }).status !== 0) fail(`ใส่ ${key} ไม่สำเร็จ`);
}
let exportToken = existsSync(".env.local") ? readFileSync(".env.local", "utf8").match(/EXPORT_TOKEN=(.+)/)?.[1] : null;
if (!exportToken) {
  exportToken = randomBytes(24).toString("hex");
  if (wrangler(["secret", "put", "EXPORT_TOKEN"], { input: exportToken + "\n" }).status !== 0) fail("ตั้ง EXPORT_TOKEN ไม่สำเร็จ");
}
writeFileSync(".env.local", `WORKER_URL=${workerUrl}\nEXPORT_TOKEN=${exportToken}\n`);
console.log("✓ ใส่กุญแจครบ (ไฟล์ .env.local ไว้ใช้กับ npm run sync ห้ามส่งให้ใคร)");

rl.close();

// ขั้นที่ 6: ต่อบอทเข้าไลน์ให้เลย (ตั้ง Webhook URL + ให้ไลน์ลองส่งมาจริง) — ผ่าน /admin/connect-line ของบอทเรา
step(6, "ต่อบอทเข้าไลน์ (ตั้ง Webhook URL ให้อัตโนมัติ)");
let connected = null;
for (let i = 0; i < 3 && !connected; i++) {
  if (i) await new Promise((r) => setTimeout(r, 5000)); // เพิ่งใส่กุญแจ รอให้ Cloudflare อัปเดตแป๊บ
  try {
    const res = await fetch(`${workerUrl}/admin/connect-line`, { method: "POST", headers: { Authorization: `Bearer ${exportToken}`, "Content-Type": "application/json" }, body: "{}" });
    const r = await res.json();
    if (res.ok && (r.ok || i === 2)) connected = r;
  } catch {}
}
if (connected?.ok) {
  console.log(`✓ ${connected.message}`);
  console.log(`\n\x1b[32m🎉 เสร็จแล้ว! เหลือเช็คเองอีกนิด\x1b[0m\n${connected.still_to_do.map((x, i) => `  ${i + 1}) ${x}`).join("\n")}\nแล้วทักบอทในไลน์ได้เลยค่ะ · บอทเงียบ? พิมพ์ npm run status`);
} else {
  if (connected?.message) console.log(`✗ ${connected.message}`);
  if (connected?.still_to_do) console.log(connected.still_to_do.map((x) => `  - ${x}`).join("\n"));
  console.log(`\n\x1b[33mต่อให้อัตโนมัติไม่สำเร็จ ทำเองใน LINE Developers > แท็บ Messaging API\x1b[0m
  1) Webhook URL → กด Edit แล้ววาง:  ${workerUrl}/webhook
  2) กด Verify ต้องขึ้น Success
  3) เปิดสวิตช์ Use webhook
  4) LINE OA Manager → ตั้งค่าการตอบกลับ → เปิดสวิตช์ Webhook
เช็คว่าติดตรงไหน: npm run status`);
}
