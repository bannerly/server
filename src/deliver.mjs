// 配信判定（スナップショットに対して純粋に決める）とスナップショット構築、時間集計。
export const PRIORITY = { override: 0, contract: 1, remnant: 2 };

export function jstParts(ts = Date.now()) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", hourCycle: "h23", weekday: "short",
  });
  const p = Object.fromEntries(fmt.formatToParts(new Date(ts)).map(x => [x.type, x.value]));
  const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[p.weekday];
  return { date: `${p.year}-${p.month}-${p.day}`, hour: parseInt(p.hour, 10), weekday: wd };
}
export function hourKeyOf(ts) {
  const p = jstParts(ts);
  return `${p.date}T${String(p.hour).padStart(2, "0")}`;
}
export function today() { return jstParts().date; }

function hourInRanges(hour, spec) {
  if (!spec) return true;
  return spec.split(",").some(r => {
    const [a, b] = r.split("-").map(x => parseInt(x, 10));
    if (Number.isNaN(a) || Number.isNaN(b)) return false;
    return hour >= a && hour < b;
  });
}

function ruleMatch(c, ctx, counts) {
  if (Array.isArray(c.weekdays) && c.weekdays.length && !c.weekdays.includes(ctx.weekday)) return false;
  if (!hourInRanges(ctx.hour, c.hours || "")) return false;
  if (Array.isArray(c.regions) && c.regions.length) {
    if (!ctx.region) return false;
    if (!c.regions.map(r => String(r).toLowerCase()).includes(String(ctx.region).toLowerCase())) return false;
  }
  if (Array.isArray(c.cities) && c.cities.length) {
    if (!ctx.city) return false;
    if (!c.cities.map(r => String(r).toLowerCase()).includes(String(ctx.city).toLowerCase())) return false;
  }
  if (c.daily_cap > 0 && (counts.today || 0) >= c.daily_cap) return false;
  if (c.type === "contract" && c.goal_impressions > 0 && (counts.total || 0) >= c.goal_impressions) return false;
  return true;
}

function freqCountedOut(cookieHeader, campaign) {
  if (!campaign.freq_cap_per_day) return false;
  const m = (cookieHeader || "").match(new RegExp(`fc_${campaign.id}=(\\d+)`));
  return m && parseInt(m[1], 10) >= campaign.freq_cap_per_day;
}

function weightedPick(list) {
  const total = list.reduce((s, c) => s + (c.weight > 0 ? c.weight : 1), 0);
  let r = Math.random() * total;
  for (const c of list) { r -= (c.weight > 0 ? c.weight : 1); if (r <= 0) return c; }
  return list[list.length - 1];
}

// snapshot: { zone, campaigns: [{...campaign, banners: [...]}] }
// countsFn: async (campaign) => { total, today }
export async function pickFromSnapshot(snapshot, ctx, countsFn) {
  const t = today();
  const sorted = [...snapshot.campaigns].sort((a, b) => PRIORITY[a.type] - PRIORITY[b.type]);
  const eligible = [];
  for (const c of sorted) {
    if (!c.active || c.starts_at > t || c.ends_at < t) continue;
    const approved = (c.banners || []).filter(b => b.review_status === "approved");
    if (!approved.length) continue;
    if (freqCountedOut(ctx.cookie, c)) continue;
    const counts = await countsFn(c);
    if (!ruleMatch(c, ctx, counts)) continue;
    eligible.push({ campaign: c, banners: approved });
  }
  if (!eligible.length) return null;
  const topPrio = PRIORITY[eligible[0].campaign.type];
  const top = eligible.filter(e => PRIORITY[e.campaign.type] === topPrio);
  const chosen = weightedPick(top.map(e => e.campaign));
  const entry = top.find(e => e.campaign.id === chosen.id);
  const banner = entry.banners[Math.floor(Math.random() * entry.banners.length)];
  return { campaign: entry.campaign, banner };
}

export async function buildSnapshot(repo, zone) {
  const campaigns = await repo.listCampaignsByZone(zone.id);
  const withBanners = [];
  for (const c of campaigns) {
    withBanners.push({ ...c, banners: await repo.listBannersByCampaign(c.id) });
  }
  return { zone, campaigns: withBanners, built_at: Date.now() };
}

export async function publishAllSnapshots(repo, putSnap) {
  const zones = await repo.listZones();
  for (const z of zones) {
    await putSnap(z.id, await buildSnapshot(repo, z));
  }
  return zones.length;
}

// 指定した JST の1時間バケットを events から集計して stats_hourly へ冪等に書く
export async function aggregateHour(repo, hourKey) {
  const startTs = Date.parse(`${hourKey}:00:00+09:00`);
  const events = await repo.listEventsInRange(startTs, startTs + 3600000);
  const byCampaign = new Map();
  for (const e of events) {
    if (hourKeyOf(e.ts) !== hourKey) continue;
    const key = e.campaign_id;
    if (!byCampaign.has(key)) byCampaign.set(key, { hour: hourKey, tenant_id: e.tenant_id, zone_id: e.zone_id, campaign_id: key, imp: 0, click: 0 });
    const row = byCampaign.get(key);
    if (e.kind === "imp") row.imp++; else if (e.kind === "click") row.click++;
  }
  for (const row of byCampaign.values()) await repo.upsertStatsHourly(row);
  return byCampaign.size;
}

export function progressOf(c, impTotal) {
  if (c.type !== "contract" || !(c.goal_impressions > 0)) return { text: "—", alert: false, label: "" };
  const totalDays = Math.max(1, (Date.parse(c.ends_at) - Date.parse(c.starts_at)) / 86400000 + 1);
  const elapsedDays = Math.min(totalDays, Math.max(0, (Date.parse(today()) - Date.parse(c.starts_at)) / 86400000 + 1));
  const frac = elapsedDays / totalDays;
  const projected = frac > 0 ? Math.round(impTotal / frac) : impTotal;
  const pct = Math.min(100, Math.round((impTotal / c.goal_impressions) * 100));
  const ended = today() > c.ends_at;
  const alert = !!c.active && ((ended && impTotal < c.goal_impressions) || (!ended && projected < c.goal_impressions));
  const label = ended && impTotal < c.goal_impressions ? "未達" : "未達見込み";
  return { text: `${impTotal}/${c.goal_impressions}（${pct}%・このペースで約${projected}）`, alert, label };
}
