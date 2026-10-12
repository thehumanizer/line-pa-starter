-- สมองกลางของ PA (Cloudflare D1)

-- กันไลน์ส่ง event ซ้ำ
CREATE TABLE IF NOT EXISTS events_seen (
  event_id TEXT PRIMARY KEY,
  at INTEGER NOT NULL
);

-- กลุ่มที่บอทอยู่
CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,            -- group / room
  name TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  joined_at INTEGER NOT NULL
);

-- ชื่อคนในกลุ่ม (เก็บไว้จะได้ไม่ต้องถามไลน์ทุกครั้ง)
CREATE TABLE IF NOT EXISTS members (
  group_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  name TEXT,
  PRIMARY KEY (group_id, user_id)
);

-- ทุกข้อความในกลุ่ม
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  line_id TEXT UNIQUE,
  group_id TEXT NOT NULL,
  user_id TEXT,
  name TEXT,
  type TEXT NOT NULL,            -- text / image / file / sticker / ...
  text TEXT,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_group_at ON messages (group_id, at);
CREATE INDEX IF NOT EXISTS idx_messages_at ON messages (at);

-- บทสนทนา 1:1 ระหว่างเรากับ PA
CREATE TABLE IF NOT EXISTS pa_chat (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,            -- user / assistant
  text TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pa_chat_user ON pa_chat (user_id, id);

-- สรุปที่ PA เขียนไว้
CREATE TABLE IF NOT EXISTS digests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_msg INTEGER NOT NULL,
  to_msg INTEGER NOT NULL,
  text TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'auto',  -- auto = สรุปตอนเช้า / manual = พิมพ์ "สรุป" เอง
  at INTEGER NOT NULL
);
