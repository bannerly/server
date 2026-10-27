// ローカル用リポジトリ（JSONファイル）。repo-d1.mjs と同一インターフェース。
import { jstParts } from "./deliver.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DATA_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data-prod.json");

export function newId(prefix) {
  return `${prefix}-${Math.random().toString(16).slice(2, 10)}${Date.now().toString(16).slice(-4)}`;
}

function seed() {
  const now = Date.now();
  const d = new Date(now), y = new Date(now - 86400000), f = new Date(now + 30 * 86400000);
  const iso = x => x.toISOString().slice(0, 10);
  return {
    tenants: [
      { id: "demo-portal", name: "デモポータル", created_at: now },
      { id: "demo-store", name: "提携店舗B", created_at: now },
    ],
    users: [],
    zones: [
      { id: "portal-top", tenant_id: "demo-portal", name: "ポータル上部バナー", width: 728, height: 90,
        backfill_html: `<div style="width:728px;height:90px;background:#eee;display:flex;align-items:center;justify-content:center;font-family:sans-serif;color:#666;">（バックフィル枠: GAMタグをここに設定）</div>`, created_at: now },
      { id: "shop-side", tenant_id: "demo-store", name: "店舗ページ サイド", width: 300, height: 250,
        backfill_html: `<div style="width:300px;height:250px;background:#eee;display:flex;align-items:center;justify-content:center;font-family:sans-serif;color:#666;">（バックフィル枠）</div>`, created_at: now },
    ],
    advertisers: [
      { id: "adv-izakaya", tenant_id: "demo-portal", name: "提携居酒屋チェーン（デモ）", contact_email: "", created_at: now },
      { id: "adv-self", tenant_id: "demo-portal", name: "自社（ハウス広告）", contact_email: "", created_at: now },
      { id: "adv-cafe", tenant_id: "demo-store", name: "近隣カフェ（デモ）", contact_email: "", created_at: now },
    ],
    campaigns: [
      { id: "cmp-contract", tenant_id: "demo-portal", advertiser_id: "adv-izakaya", zone_id: "portal-top",
        name: "提携店キャンペーン（Contract）", type: "contract", starts_at: iso(y), ends_at: iso(f),
        goal_impressions: 100000, freq_cap_per_day: 0, weight: 3, daily_cap: 0, regions: [], hours: "", weekdays: [], active: true, created_at: now },
      { id: "cmp-remnant", tenant_id: "demo-portal", advertiser_id: "adv-self", zone_id: "portal-top",
        name: "自社告知（Remnant）", type: "remnant", starts_at: iso(y), ends_at: "2099-12-31",
        goal_impressions: 0, freq_cap_per_day: 0, weight: 1, daily_cap: 0, regions: [], hours: "", weekdays: [], active: true, created_at: now },
      { id: "cmp-shop", tenant_id: "demo-store", advertiser_id: "adv-cafe", zone_id: "shop-side",
        name: "カフェ告知（Contract）", type: "contract", starts_at: iso(y), ends_at: iso(f),
        goal_impressions: 0, freq_cap_per_day: 0, weight: 1, daily_cap: 0, regions: [], hours: "", weekdays: [], active: true, created_at: now },
    ],
    banners: [
      { id: "bn-contract", tenant_id: "demo-portal", campaign_id: "cmp-contract", review_status: "approved", review_note: "",
        html: `<div style="width:728px;height:90px;background:#ffe9b8;display:flex;align-items:center;justify-content:center;font-family:sans-serif;font-size:20px;">契約広告: 提携居酒屋チェーン</div>`,
        link_url: "https://example.com/izakaya", created_at: now },
      { id: "bn-remnant", tenant_id: "demo-portal", campaign_id: "cmp-remnant", review_status: "approved", review_note: "",
        html: `<div style="width:728px;height:90px;background:#dff3e4;display:flex;align-items:center;justify-content:center;font-family:sans-serif;font-size:20px;">自社告知: 自社サービス先行登録</div>`,
        link_url: "https://example.com/daiko", created_at: now },
      { id: "bn-shop", tenant_id: "demo-store", campaign_id: "cmp-shop", review_status: "approved", review_note: "",
        html: `<div style="width:300px;height:250px;background:#fde2e2;display:flex;align-items:center;justify-content:center;font-family:sans-serif;font-size:18px;">近隣カフェの広告</div>`,
        link_url: "https://example.com/cafe", created_at: now },
    ],
    plans: [
      { id: "plan-standard", name: "スタンダード", price_monthly: 20000, goal_impressions: 40000, description: "事業者向け標準枠（目標impは仮置き・要確定）" },
      { id: "plan-premium", name: "プレミアム", price_monthly: 50000, goal_impressions: 120000, description: "提携店舗・エリア面の優先枠（目標impは仮置き・要確定）" },
      { id: "plan-top", name: "トップ", price_monthly: 100000, goal_impressions: 300000, description: "トップ面の看板枠（目標impは仮置き・要確定）" },
    ],
    orders: [],
    events: [],
    counters_total: [],
    counters_daily: [],
    reports: [],
    stats_hourly: [],
    deliveries: {},
    snapshots: {},
  };
}

export class LocalRepo {
  load() {
    try { return JSON.parse(fs.readFileSync(DATA_PATH, "utf8")); }
    catch { const s = seed(); fs.writeFileSync(DATA_PATH, JSON.stringify(s, null, 2)); return s; }
  }
  save(db) { fs.writeFileSync(DATA_PATH, JSON.stringify(db, null, 2)); }

  async listTenants() { return this.load().tenants; }
  async createTenant(t) { const db = this.load(); db.tenants.push(t); this.save(db); return t; }
  async getTenant(id) { return this.load().tenants.find(t => t.id === id) || null; }
  async updateTenant(id, patch) { const db = this.load(); const t = db.tenants.find(x => x.id === id); if (t) Object.assign(t, patch); this.save(db); return t; }
  async createUser(u) { const db = this.load(); db.users.push(u); this.save(db); return u; }
  async listUsers() { return this.load().users; }
  async getUserByTokenHash(hash) { return this.load().users.find(u => u.token_hash && u.token_hash === hash) || null; }
  async listZones() { return this.load().zones; }
  async getZone(id) { return this.load().zones.find(z => z.id === id) || null; }
  async createZone(z) { const db = this.load(); db.zones.push(z); this.save(db); return z; }
  async listAdvertisers(tenantId) { const a = this.load().advertisers; return tenantId ? a.filter(x => x.tenant_id === tenantId) : a; }
  async createAdvertiser(a) { const db = this.load(); db.advertisers.push(a); this.save(db); return a; }
  async getAdvertiser(id) { return this.load().advertisers.find(x => x.id === id) || null; }
  async listCampaigns() { return this.load().campaigns; }
  async listCampaignsByZone(zoneId) { return this.load().campaigns.filter(c => c.zone_id === zoneId); }
  async getCampaign(id) { return this.load().campaigns.find(c => c.id === id) || null; }
  async createCampaign(c) { const db = this.load(); db.campaigns.push(c); this.save(db); return c; }
  async updateCampaign(id, patch) { const db = this.load(); const c = db.campaigns.find(x => x.id === id); if (c) Object.assign(c, patch); this.save(db); return c; }
  async listBanners() { return this.load().banners; }
  async listBannersByCampaign(cid) { return this.load().banners.filter(b => b.campaign_id === cid); }
  async getBanner(id) { return this.load().banners.find(b => b.id === id) || null; }
  async createBanner(b) { const db = this.load(); db.banners.push(b); this.save(db); return b; }
  async setBannerReview(id, status, note = "") { const db = this.load(); const b = db.banners.find(x => x.id === id); if (b) { b.review_status = status; b.review_note = note; } this.save(db); return b; }
  async listPlans() { return this.load().plans; }
  async createPlan(p) { const db = this.load(); db.plans.push(p); this.save(db); return p; }
  async getPlan(id) { return this.load().plans.find(p => p.id === id) || null; }
  async listOrders() { return this.load().orders; }
  async createOrder(o) { const db = this.load(); db.orders.push(o); this.save(db); return o; }
  async getOrder(id) { return this.load().orders.find(o => o.id === id) || null; }
  async updateOrder(id, patch) { const db = this.load(); const o = db.orders.find(x => x.id === id); if (o) Object.assign(o, patch); this.save(db); return o; }
  async insertEvent(e) {
    const db = this.load();
    db.events.push(e);
    db.counters_total = db.counters_total || [];
    db.counters_daily = db.counters_daily || [];
    let t = db.counters_total.find(x => x.campaign_id === e.campaign_id);
    if (!t) { t = { campaign_id: e.campaign_id, tenant_id: e.tenant_id, zone_id: e.zone_id, imp: 0, click: 0 }; db.counters_total.push(t); }
    const day = jstParts(e.ts).date;
    let d = db.counters_daily.find(x => x.campaign_id === e.campaign_id && x.day === day);
    if (!d) { d = { campaign_id: e.campaign_id, day, imp: 0, click: 0 }; db.counters_daily.push(d); }
    if (e.kind === "imp") { t.imp++; d.imp++; } else if (e.kind === "click") { t.click++; d.click++; }
    this.save(db);
    return e;
  }
  async listEvents() { return this.load().events; }
  async listEventsInRange(startTs, endTs) { return this.load().events.filter(e => e.ts >= startTs && e.ts < endTs); }
  async getImpCounts(campaignId, dateStr) {
    const db = this.load();
    const t = (db.counters_total || []).find(x => x.campaign_id === campaignId);
    const d = (db.counters_daily || []).find(x => x.campaign_id === campaignId && x.day === dateStr);
    return { total: t ? t.imp : 0, today: d ? d.imp : 0 };
  }
  async rebuildCounters() {
    const db = this.load();
    db.counters_total = [];
    db.counters_daily = [];
    for (const e of db.events) {
      let t = db.counters_total.find(x => x.campaign_id === e.campaign_id);
      if (!t) { t = { campaign_id: e.campaign_id, tenant_id: e.tenant_id, zone_id: e.zone_id, imp: 0, click: 0 }; db.counters_total.push(t); }
      const day = jstParts(e.ts).date;
      let d = db.counters_daily.find(x => x.campaign_id === e.campaign_id && x.day === day);
      if (!d) { d = { campaign_id: e.campaign_id, day, imp: 0, click: 0 }; db.counters_daily.push(d); }
      if (e.kind === "imp") { t.imp++; d.imp++; } else if (e.kind === "click") { t.click++; d.click++; }
    }
    this.save(db);
    return db.counters_total.length;
  }
  async getCount(campaignId, dateStr = null, partsFn) {
    let imp = 0;
    for (const e of this.load().events) {
      if (e.campaign_id !== campaignId || e.kind !== "imp") continue;
      if (dateStr && partsFn(e.ts).date !== dateStr) continue;
      imp++;
    }
    return imp;
  }
  async listCountersTotal() { return this.load().counters_total || []; }
  async listCountersDaily(fromDay, toDay) { return (this.load().counters_daily || []).filter(r => r.day >= fromDay && r.day < toDay); }
  async getReport(period, kind = "monthly") { return (this.load().reports || []).find(r => r.period === period && (r.kind || "monthly") === kind) || null; }
  async getLatestReportBefore(period, kind = "monthly") {
    const rs = (this.load().reports || []).filter(r => r.period < period && (r.kind || "monthly") === kind).sort((a, b) => a.period.localeCompare(b.period));
    return rs.length ? rs[rs.length - 1] : null;
  }
  async saveReport(rec) {
    const db = this.load();
    db.reports = db.reports || [];
    const i = db.reports.findIndex(r => r.period === rec.period && (r.kind || "monthly") === (rec.kind || "monthly"));
    if (i >= 0) db.reports[i] = rec; else db.reports.push(rec);
    this.save(db);
    return rec;
  }
  async upsertStatsHourly(row) {
    const db = this.load();
    const ex = db.stats_hourly.find(s => s.hour === row.hour && s.campaign_id === row.campaign_id);
    if (ex) { ex.imp = row.imp; ex.click = row.click; } else db.stats_hourly.push(row);
    this.save(db);
  }
  async listStatsHourly() { return this.load().stats_hourly; }
  async putSnapshot(zoneId, snap) { const db = this.load(); db.snapshots[zoneId] = snap; this.save(db); }
  async getSnapshot(zoneId) { return this.load().snapshots[zoneId] || null; }
  async putDelivery(token, d) { const db = this.load(); db.deliveries[token] = d; this.save(db); }
  async getDelivery(token) { return this.load().deliveries[token] || null; }
  async markDeliveryCounted(token) { const db = this.load(); const d = db.deliveries[token]; if (d) d.counted = true; this.save(db); }
}
