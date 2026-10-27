// 料金（プラン月額）→ 配信ルールの自動化。
// プランに明示ルール（rule_*）があればそれを優先し、未指定の項目だけ価格帯から補う。
// 注文承認時にキャンペーンへ展開され、スナップショット経由でエッジへ配られる。
export function tierForPrice(priceMonthly) {
  const p = priceMonthly || 0;
  if (p >= 100000) return { name: "トップ", weight: 10, freqCapPerDay: 10, pacing: 1.5 };
  if (p >= 50000) return { name: "プレミアム", weight: 5, freqCapPerDay: 5, pacing: 1.3 };
  if (p >= 20000) return { name: "スタンダード", weight: 2, freqCapPerDay: 3, pacing: 1.15 };
  return { name: "ライト", weight: 1, freqCapPerDay: 2, pacing: 1.0 };
}

const asArray = v => (Array.isArray(v) ? v : []);
const posInt = v => (parseInt(v, 10) > 0 ? parseInt(v, 10) : 0);

export function periodDays(order) {
  const s = Date.parse((order && order.starts_at) || "");
  const e = Date.parse((order && order.ends_at) || "");
  if (!Number.isFinite(s) || !Number.isFinite(e) || e < s) return 30;
  return Math.max(1, Math.round((e - s) / 86400000) + 1);
}

// plan + order → キャンペーンに載せるルール一式
export function effectivePlanRules(plan = {}, order = {}) {
  const tier = tierForPrice(plan.price_monthly);
  const goal = plan.goal_impressions || 0;
  const autoDailyCap = goal > 0 ? Math.ceil((goal / periodDays(order)) * tier.pacing) : 0;
  return {
    tier: tier.name,
    goal_impressions: goal,
    weight: posInt(plan.rule_weight) || tier.weight,
    freq_cap_per_day: posInt(plan.rule_freq_cap_per_day) || tier.freqCapPerDay,
    daily_cap: posInt(plan.rule_daily_cap) || autoDailyCap,
    regions: asArray(plan.rule_regions),
    cities: asArray(plan.rule_cities),
    hours: plan.rule_hours || "",
    weekdays: asArray(plan.rule_weekdays),
  };
}

// 枠の直近30日実績に対するプラン目標の実現可能性（販売・承認時の警告用）
export function assessFeasibility(plan = {}, order = {}, zoneImp30d = 0) {
  const goal = plan.goal_impressions || 0;
  if (!goal) return { level: "none", capacity: 0, ratio: 0 };
  if (!zoneImp30d) return { level: "unknown", capacity: 0, ratio: 0 };
  const capacity = Math.floor((zoneImp30d / 30) * periodDays(order));
  const ratio = capacity > 0 ? goal / capacity : Infinity;
  const level = ratio > 1 ? "over" : ratio > 0.7 ? "tight" : "ok";
  return { level, capacity, ratio };
}

export function rulesSummary(r) {
  return [
    `区分:${r.tier}`,
    `重み:${r.weight}`,
    r.daily_cap ? `日次上限:${r.daily_cap}` : null,
    r.freq_cap_per_day ? `FC/日:${r.freq_cap_per_day}` : null,
    r.regions && r.regions.length ? `地域:${r.regions.join("/")}` : null,
    r.cities && r.cities.length ? `市:${r.cities.join("/")}` : null,
    r.hours ? `時間:${r.hours}` : null,
    r.weekdays && r.weekdays.length ? `曜日:${r.weekdays.join("/")}` : null,
  ].filter(Boolean).join(" / ");
}
