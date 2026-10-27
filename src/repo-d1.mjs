// D1 用リポジトリ。repo-local.mjs と同一インターフェース（戻り値の形を揃える）。
// 注意: このファイルはローカル環境では実行検証していない（初回は wrangler で要確認）。
import { jstParts, hourKeyOf } from "./deliver.mjs";
export function newId(prefix) {
  return `${prefix}-${Math.random().toString(16).slice(2, 10)}${Date.now().toString(16).slice(-4)}`;
}

const parseArr = v => { try { const a = JSON.parse(v || "[]"); return Array.isArray(a) ? a : []; } catch { return []; } };
const mapCampaign = r => r && ({ ...r, active: !!r.active, regions: parseArr(r.regions), cities: parseArr(r.cities), weekdays: parseArr(r.weekdays) });
const mapZone = r => r || null;
const mapPlan = r => r && ({ ...r, rule_regions: parseArr(r.rule_regions), rule_cities: parseArr(r.rule_cities), rule_weekdays: parseArr(r.rule_weekdays) });
const mapLineQueue = r => r && ({ ...r, available: !!r.available });
const mapLineRule = r => r && ({ ...r, active: !!r.active });

export class D1Repo {
  constructor(db) { this.db = db; }
  async all(sql, ...binds) { const { results } = await this.db.prepare(sql).bind(...binds).all(); return results; }
  async first(sql, ...binds) { return await this.db.prepare(sql).bind(...binds).first(); }
  async run(sql, ...binds) { return await this.db.prepare(sql).bind(...binds).run(); }

  async listTenants() { return this.all("SELECT * FROM tenants ORDER BY created_at"); }
  async createTenant(t) { await this.run("INSERT INTO tenants (id,name,stripe_account_id,stripe_charges_enabled,created_at) VALUES (?,?,?,?,?)", t.id, t.name, t.stripe_account_id || "", t.stripe_charges_enabled ? 1 : 0, t.created_at); return t; }
  async getTenant(id) { return this.first("SELECT * FROM tenants WHERE id=?", id); }
  async updateTenant(id, patch) {
    const cur = await this.getTenant(id); if (!cur) return null;
    const n = { ...cur, ...patch };
    await this.run("UPDATE tenants SET name=?, stripe_account_id=?, stripe_charges_enabled=?, line_channel_id=?, line_channel_secret=?, line_access_token=? WHERE id=?", n.name, n.stripe_account_id || "", n.stripe_charges_enabled ? 1 : 0, n.line_channel_id || "", n.line_channel_secret || "", n.line_access_token || "", id);
    return n;
  }
  async createUser(u) { await this.run("INSERT INTO users (id,tenant_id,email,role,token_hash,created_at) VALUES (?,?,?,?,?,?)", u.id, u.tenant_id || null, u.email, u.role || "tenant_admin", u.token_hash || "", u.created_at); return u; }
  async listUsers() { return this.all("SELECT * FROM users ORDER BY created_at"); }
  async getUserByTokenHash(hash) { return this.first("SELECT * FROM users WHERE token_hash=?", hash); }
  async listZones() { return this.all("SELECT * FROM zones ORDER BY created_at"); }
  async getZone(id) { return mapZone(await this.first("SELECT * FROM zones WHERE id=?", id)); }
  async createZone(z) { await this.run("INSERT INTO zones (id,tenant_id,name,width,height,backfill_html,created_at) VALUES (?,?,?,?,?,?,?)", z.id, z.tenant_id, z.name, z.width, z.height, z.backfill_html, z.created_at); return z; }
  async listAdvertisers(tenantId) { return tenantId ? this.all("SELECT * FROM advertisers WHERE tenant_id=?", tenantId) : this.all("SELECT * FROM advertisers"); }
  async createAdvertiser(a) { await this.run("INSERT INTO advertisers (id,tenant_id,name,contact_email,created_at) VALUES (?,?,?,?,?)", a.id, a.tenant_id, a.name, a.contact_email || "", a.created_at); return a; }
  async getAdvertiser(id) { return this.first("SELECT * FROM advertisers WHERE id=?", id); }
  async listCampaigns() { return (await this.all("SELECT * FROM campaigns ORDER BY created_at")).map(mapCampaign); }
  async listCampaignsByZone(zoneId) { return (await this.all("SELECT * FROM campaigns WHERE zone_id=?", zoneId)).map(mapCampaign); }
  async getCampaign(id) { return mapCampaign(await this.first("SELECT * FROM campaigns WHERE id=?", id)); }
  async createCampaign(c) {
    await this.run(`INSERT INTO campaigns (id,tenant_id,advertiser_id,zone_id,name,type,starts_at,ends_at,goal_impressions,freq_cap_per_day,weight,daily_cap,regions,cities,hours,weekdays,active,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      c.id, c.tenant_id, c.advertiser_id, c.zone_id, c.name, c.type, c.starts_at, c.ends_at, c.goal_impressions || 0,
      c.freq_cap_per_day || 0, c.weight || 1, c.daily_cap || 0, JSON.stringify(c.regions || []), JSON.stringify(c.cities || []), c.hours || "",
      JSON.stringify(c.weekdays || []), c.active ? 1 : 0, c.created_at);
    return c;
  }
  async updateCampaign(id, patch) {
    const cur = await this.getCampaign(id); if (!cur) return null;
    const n = { ...cur, ...patch };
    await this.run(`UPDATE campaigns SET name=?,type=?,starts_at=?,ends_at=?,goal_impressions=?,freq_cap_per_day=?,weight=?,daily_cap=?,regions=?,cities=?,hours=?,weekdays=?,active=? WHERE id=?`,
      n.name, n.type, n.starts_at, n.ends_at, n.goal_impressions || 0, n.freq_cap_per_day || 0, n.weight || 1, n.daily_cap || 0,
      JSON.stringify(n.regions || []), JSON.stringify(n.cities || []), n.hours || "", JSON.stringify(n.weekdays || []), n.active ? 1 : 0, id);
    return n;
  }
  async listBanners() { return this.all("SELECT * FROM banners ORDER BY created_at"); }
  async listBannersByCampaign(cid) { return this.all("SELECT * FROM banners WHERE campaign_id=?", cid); }
  async getBanner(id) { return this.first("SELECT * FROM banners WHERE id=?", id); }
  async createBanner(b) { await this.run("INSERT INTO banners (id,tenant_id,campaign_id,creative_type,html,image_url,title,body,link_url,review_status,review_note,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", b.id, b.tenant_id, b.campaign_id, b.creative_type || "html", b.html || "", b.image_url || "", b.title || "", b.body || "", b.link_url, b.review_status || "pending", b.review_note || "", b.created_at); return b; }
  async setBannerReview(id, status, note = "") { await this.run("UPDATE banners SET review_status=?, review_note=? WHERE id=?", status, note, id); return this.getBanner(id); }
  async listPlans() { return (await this.all("SELECT * FROM plans")).map(mapPlan); }
  async createPlan(p) { await this.run("INSERT INTO plans (id,name,price_monthly,goal_impressions,description,rule_weight,rule_freq_cap_per_day,rule_daily_cap,rule_regions,rule_cities,rule_hours,rule_weekdays) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", p.id, p.name, p.price_monthly, p.goal_impressions || 0, p.description || "", p.rule_weight || 0, p.rule_freq_cap_per_day || 0, p.rule_daily_cap || 0, JSON.stringify(p.rule_regions || []), JSON.stringify(p.rule_cities || []), p.rule_hours || "", JSON.stringify(p.rule_weekdays || [])); return p; }
  async getPlan(id) { return mapPlan(await this.first("SELECT * FROM plans WHERE id=?", id)); }
  async listOrders() { return this.all("SELECT * FROM orders ORDER BY created_at"); }
  async createOrder(o) { await this.run("INSERT INTO orders (id,tenant_id,advertiser_id,plan_id,zone_id,starts_at,ends_at,status,campaign_id,payment_status,stripe_session_id,stripe_invoice_id,stripe_invoice_url,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", o.id, o.tenant_id, o.advertiser_id, o.plan_id, o.zone_id, o.starts_at, o.ends_at, o.status || "applied", o.campaign_id || null, o.payment_status || "unpaid", o.stripe_session_id || "", o.stripe_invoice_id || "", o.stripe_invoice_url || "", o.created_at); return o; }
  async getOrder(id) { return this.first("SELECT * FROM orders WHERE id=?", id); }
  async updateOrder(id, patch) {
    const cur = await this.getOrder(id); if (!cur) return null;
    const n = { ...cur, ...patch };
    await this.run("UPDATE orders SET status=?, campaign_id=?, payment_status=?, stripe_session_id=?, stripe_invoice_id=?, stripe_invoice_url=? WHERE id=?", n.status, n.campaign_id || null, n.payment_status || "unpaid", n.stripe_session_id || "", n.stripe_invoice_id || "", n.stripe_invoice_url || "", id);
    return n;
  }
  async insertEvent(e) {
    await this.run("INSERT INTO events_raw (id,ts,kind,tenant_id,zone_id,campaign_id,banner_id) VALUES (?,?,?,?,?,?,?)", e.id, e.ts, e.kind, e.tenant_id, e.zone_id, e.campaign_id, e.banner_id);
    const day = jstParts(e.ts).date;
    const imp = e.kind === "imp" ? 1 : 0, click = e.kind === "click" ? 1 : 0;
    await this.run(`INSERT INTO counters_total (campaign_id,tenant_id,zone_id,imp,click) VALUES (?,?,?,?,?)
      ON CONFLICT(campaign_id) DO UPDATE SET imp=imp+excluded.imp, click=click+excluded.click`,
      e.campaign_id, e.tenant_id, e.zone_id, imp, click);
    await this.run(`INSERT INTO counters_daily (campaign_id,day,imp,click) VALUES (?,?,?,?)
      ON CONFLICT(campaign_id,day) DO UPDATE SET imp=imp+excluded.imp, click=click+excluded.click`,
      e.campaign_id, day, imp, click);
    return e;
  }
  async listEvents() { return this.all("SELECT * FROM events_raw ORDER BY ts"); }
  async listEventsInRange(startTs, endTs) { return this.all("SELECT * FROM events_raw WHERE ts>=? AND ts<? ORDER BY ts", startTs, endTs); }
  async getImpCounts(campaignId, dateStr) {
    const t = await this.first("SELECT imp FROM counters_total WHERE campaign_id=?", campaignId);
    const d = await this.first("SELECT imp FROM counters_daily WHERE campaign_id=? AND day=?", campaignId, dateStr);
    return { total: t ? t.imp : 0, today: d ? d.imp : 0 };
  }
  async getZoneImpStats(zoneId, days = 30) {
    const cutoff = hourKeyOf(Date.now() - days * 86400000);
    const r = await this.first("SELECT COALESCE(SUM(imp),0) AS s FROM stats_hourly WHERE zone_id=? AND hour>=?", zoneId, cutoff);
    return r ? r.s : 0;
  }
  async getZoneHourlyShares(zoneId, days = 30) {
    const cutoff = hourKeyOf(Date.now() - days * 86400000);
    const rows = await this.all("SELECT substr(hour,12,2) AS hod, COALESCE(SUM(imp),0) AS s FROM stats_hourly WHERE zone_id=? AND hour>=? GROUP BY hod", zoneId, cutoff);
    const byHour = new Array(24).fill(0);
    for (const r of rows) { const hod = parseInt(r.hod, 10); if (hod >= 0 && hod < 24) byHour[hod] = r.s; }
    const total = byHour.reduce((a, b) => a + b, 0);
    return total > 0 ? byHour.map(v => v / total) : new Array(24).fill(1 / 24);
  }
  async rebuildCounters() {
    const events = await this.listEvents();
    await this.run("DELETE FROM counters_total");
    await this.run("DELETE FROM counters_daily");
    const totals = new Map(), dailies = new Map();
    for (const e of events) {
      const tk = e.campaign_id;
      if (!totals.has(tk)) totals.set(tk, { campaign_id: tk, tenant_id: e.tenant_id, zone_id: e.zone_id, imp: 0, click: 0 });
      const day = jstParts(e.ts).date;
      const dk = `${tk}|${day}`;
      if (!dailies.has(dk)) dailies.set(dk, { campaign_id: tk, day, imp: 0, click: 0 });
      if (e.kind === "imp") { totals.get(tk).imp++; dailies.get(dk).imp++; }
      else if (e.kind === "click") { totals.get(tk).click++; dailies.get(dk).click++; }
    }
    for (const t of totals.values()) await this.run("INSERT INTO counters_total (campaign_id,tenant_id,zone_id,imp,click) VALUES (?,?,?,?,?)", t.campaign_id, t.tenant_id, t.zone_id, t.imp, t.click);
    for (const d of dailies.values()) await this.run("INSERT INTO counters_daily (campaign_id,day,imp,click) VALUES (?,?,?,?)", d.campaign_id, d.day, d.imp, d.click);
    return totals.size;
  }
  async getCount(campaignId, dateStr = null, partsFn) {
    // 本番ではイベント表からの集計（インデックス前提）。規模が大きくなれば KV カウンタへ移行する。
    const rows = await this.all("SELECT ts FROM events_raw WHERE campaign_id=? AND kind='imp'", campaignId);
    if (!dateStr) return rows.length;
    return rows.filter(r => partsFn(r.ts).date === dateStr).length;
  }
  async listCountersTotal() { return this.all("SELECT * FROM counters_total"); }
  async listCountersDaily(fromDay, toDay) { return this.all("SELECT * FROM counters_daily WHERE day>=? AND day<? ORDER BY day", fromDay, toDay); }
  async getReport(period, kind = "monthly") { const r = await this.first("SELECT * FROM usage_reports WHERE period=? AND kind=?", period, kind); return r ? { ...r, payload: JSON.parse(r.payload) } : null; }
  async getLatestReportBefore(period, kind = "monthly") { const r = await this.first("SELECT * FROM usage_reports WHERE period<? AND kind=? ORDER BY period DESC LIMIT 1", period, kind); return r ? { ...r, payload: JSON.parse(r.payload) } : null; }
  async saveReport(rec) {
    await this.run(`INSERT INTO usage_reports (period,kind,deployment_id,payload,hash,sent_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(period,kind) DO UPDATE SET payload=excluded.payload, hash=excluded.hash, sent_at=excluded.sent_at`,
      rec.period, rec.kind || "monthly", rec.deployment_id, JSON.stringify(rec.payload), rec.hash, rec.sent_at);
    return rec;
  }
  async upsertStatsHourly(row) {
    await this.run(`INSERT INTO stats_hourly (hour,tenant_id,zone_id,campaign_id,imp,click) VALUES (?,?,?,?,?,?)
      ON CONFLICT(hour,campaign_id) DO UPDATE SET imp=excluded.imp, click=excluded.click`,
      row.hour, row.tenant_id, row.zone_id, row.campaign_id, row.imp, row.click);
  }
  async listStatsHourly() { return this.all("SELECT * FROM stats_hourly ORDER BY hour"); }
  async listLineQueues(tenantId) { const rows = tenantId ? await this.all("SELECT * FROM line_queues WHERE tenant_id=? ORDER BY created_at", tenantId) : await this.all("SELECT * FROM line_queues ORDER BY created_at"); return rows.map(mapLineQueue); }
  async createLineQueue(q) { await this.run("INSERT INTO line_queues (id,tenant_id,name,advertiser_id,area,available,created_at) VALUES (?,?,?,?,?,?,?)", q.id, q.tenant_id, q.name, q.advertiser_id || "", q.area || "", q.available ? 1 : 0, q.created_at); return q; }
  async getLineQueue(id) { return mapLineQueue(await this.first("SELECT * FROM line_queues WHERE id=?", id)); }
  async updateLineQueue(id, patch) {
    const cur = await this.getLineQueue(id); if (!cur) return null;
    const n = { ...cur, ...patch };
    await this.run("UPDATE line_queues SET name=?, advertiser_id=?, area=?, available=? WHERE id=?", n.name, n.advertiser_id || "", n.area || "", n.available ? 1 : 0, id);
    return n;
  }
  async listLineRouteRules(tenantId) { const rows = tenantId ? await this.all("SELECT * FROM line_route_rules WHERE tenant_id=? ORDER BY priority, created_at", tenantId) : await this.all("SELECT * FROM line_route_rules ORDER BY priority, created_at"); return rows.map(mapLineRule); }
  async createLineRouteRule(r) { await this.run("INSERT INTO line_route_rules (id,tenant_id,queue_id,priority,campaign_id,area,hours,keywords,active,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)", r.id, r.tenant_id, r.queue_id, r.priority || 100, r.campaign_id || "", r.area || "", r.hours || "", r.keywords || "", r.active ? 1 : 0, r.created_at); return r; }
  async deleteLineRouteRule(id) { await this.run("DELETE FROM line_route_rules WHERE id=?", id); }
  async getLineThreadByUser(tenantId, userId) { return this.first("SELECT * FROM line_threads WHERE tenant_id=? AND line_user_id=?", tenantId, userId); }
  async createLineThread(t) { await this.run("INSERT INTO line_threads (id,tenant_id,line_user_id,queue_id,status,campaign_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)", t.id, t.tenant_id, t.line_user_id, t.queue_id || "", t.status || "open", t.campaign_id || "", t.created_at, t.updated_at); return t; }
  async getLineThread(id) { return this.first("SELECT * FROM line_threads WHERE id=?", id); }
  async listLineThreads(tenantId) { return this.all("SELECT * FROM line_threads WHERE tenant_id=? ORDER BY updated_at DESC", tenantId); }
  async updateLineThread(id, patch) {
    const cur = await this.getLineThread(id); if (!cur) return null;
    const n = { ...cur, ...patch };
    await this.run("UPDATE line_threads SET queue_id=?, status=?, campaign_id=?, updated_at=? WHERE id=?", n.queue_id || "", n.status || "open", n.campaign_id || "", n.updated_at, id);
    return n;
  }
  async createLineMessage(m) { await this.run("INSERT INTO line_messages (id,thread_id,tenant_id,direction,msg_type,body,ts,created_at) VALUES (?,?,?,?,?,?,?,?)", m.id, m.thread_id, m.tenant_id, m.direction || "in", m.msg_type || "text", m.body || "", m.ts, m.created_at); return m; }
  async listLineMessages(threadId) { return this.all("SELECT * FROM line_messages WHERE thread_id=? ORDER BY ts", threadId); }
  async getLineAttribution(tenantId, userId) { return this.first("SELECT * FROM line_attribution WHERE tenant_id=? AND line_user_id=?", tenantId, userId); }
  async setLineAttribution(tenantId, userId, campaignId) {
    await this.run(`INSERT INTO line_attribution (tenant_id,line_user_id,campaign_id,updated_at) VALUES (?,?,?,?)
      ON CONFLICT(tenant_id,line_user_id) DO UPDATE SET campaign_id=excluded.campaign_id, updated_at=excluded.updated_at`,
      tenantId, userId, campaignId, Date.now());
  }
  // スナップショットと配信トークンは KV 側で扱うため、D1 では未使用（worker が分岐）
  async putSnapshot() { throw new Error("snapshot is stored in KV"); }
  async getSnapshot() { return null; }
  async putDelivery() { throw new Error("delivery token is stored in KV"); }
  async getDelivery() { return null; }
  async markDeliveryCounted() {}
}
