-- WA Gateway — Supabase Table Schemas
-- Run this in your Supabase project's SQL Editor

-- ── Devices (WA sessions) ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS devices (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  number      TEXT,
  status      TEXT DEFAULT 'pending',   -- pending | connecting | connected | disconnected
  last_seen   TIMESTAMPTZ,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── Auto-Reply Rules ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS auto_reply_rules (
  id          SERIAL PRIMARY KEY,
  keyword     TEXT NOT NULL,
  response    TEXT NOT NULL,
  sender_id   TEXT DEFAULT 'All',        -- 'All' or specific device phone number
  enabled     BOOLEAN DEFAULT TRUE,
  media_url   TEXT,
  media_type  TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── Blast Logs ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS blast_logs (
  id          SERIAL PRIMARY KEY,
  device_id   TEXT REFERENCES devices(id) ON DELETE SET NULL,
  recipient   TEXT NOT NULL,
  message     TEXT NOT NULL,
  status      TEXT DEFAULT 'queued',     -- queued | sent | failed
  sent_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── Optional: Row Level Security (disable for internal-only use) ─────────────
-- If you want the API to bypass RLS, use the service role key (SUPABASE_SECRET_KEY).
-- ALTER TABLE devices DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE auto_reply_rules DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE blast_logs DISABLE ROW LEVEL SECURITY;

-- ── Optional: Seed a default auto-reply rule ─────────────────────────────────
-- INSERT INTO auto_reply_rules (keyword, response, sender_id, enabled)
-- VALUES ('halo', 'Halo! Ada yang bisa kami bantu?', 'All', TRUE);
