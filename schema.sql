-- bannerly D1 スキーマ
CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  stripe_account_id TEXT NOT NULL DEFAULT '',
  stripe_charges_enabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  tenant_id TEXT,
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'tenant_admin',
  token_hash TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS zones (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  width INTEGER NOT NULL DEFAULT 0,
  height INTEGER NOT NULL DEFAULT 0,
  backfill_html TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS advertisers (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  contact_email TEXT DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  advertiser_id TEXT NOT NULL,
  zone_id TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'remnant',
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  goal_impressions INTEGER NOT NULL DEFAULT 0,
  freq_cap_per_day INTEGER NOT NULL DEFAULT 0,
  weight INTEGER NOT NULL DEFAULT 1,
  daily_cap INTEGER NOT NULL DEFAULT 0,
  regions TEXT NOT NULL DEFAULT '[]',
  hours TEXT NOT NULL DEFAULT '',
  weekdays TEXT NOT NULL DEFAULT '[]',
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_campaigns_zone ON campaigns(zone_id);
CREATE TABLE IF NOT EXISTS banners (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  creative_type TEXT NOT NULL DEFAULT 'html',
  html TEXT NOT NULL DEFAULT '',
  image_url TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  link_url TEXT NOT NULL DEFAULT '',
  review_status TEXT NOT NULL DEFAULT 'pending',
  review_note TEXT DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_banners_campaign ON banners(campaign_id);
CREATE INDEX IF NOT EXISTS idx_banners_review ON banners(review_status);
CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  price_monthly INTEGER NOT NULL,
  goal_impressions INTEGER NOT NULL DEFAULT 0,
  description TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  advertiser_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  zone_id TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'applied',
  campaign_id TEXT,
  payment_status TEXT NOT NULL DEFAULT 'unpaid',
  stripe_session_id TEXT NOT NULL DEFAULT '',
  stripe_invoice_id TEXT NOT NULL DEFAULT '',
  stripe_invoice_url TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS events_raw (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  zone_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  banner_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events_raw(ts);
CREATE INDEX IF NOT EXISTS idx_events_campaign ON events_raw(campaign_id);
CREATE TABLE IF NOT EXISTS counters_total (
  campaign_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  zone_id TEXT NOT NULL,
  imp INTEGER NOT NULL DEFAULT 0,
  click INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS counters_daily (
  campaign_id TEXT NOT NULL,
  day TEXT NOT NULL,
  imp INTEGER NOT NULL DEFAULT 0,
  click INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (campaign_id, day)
);
CREATE TABLE IF NOT EXISTS usage_reports (
  period TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'monthly',
  deployment_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  hash TEXT NOT NULL,
  sent_at INTEGER,
  PRIMARY KEY (period, kind)
);
CREATE TABLE IF NOT EXISTS stats_hourly (
  hour TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  zone_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  imp INTEGER NOT NULL DEFAULT 0,
  click INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (hour, campaign_id)
);
INSERT OR IGNORE INTO plans (id, name, price_monthly, goal_impressions, description) VALUES
  ('plan-standard', 'スタンダード', 20000, 40000, '事業者向け標準枠（目標impは仮置き・要確定）'),
  ('plan-premium', 'プレミアム', 50000, 120000, '提携店舗・エリア面の優先枠（目標impは仮置き・要確定）'),
  ('plan-top', 'トップ', 100000, 300000, 'トップ面の看板枠（目標impは仮置き・要確定）');
