// 利用量メータリングと署名付き月次レポート。
// メーター = イベント取り込み時に更新されるカウンタ（counters_daily / counters_total）。
// 明細の生イベントと突合でき、レポートは SHA-256 のハッシュ連鎖 + ライセンスキー署名（HMAC）で改ざん検知できる。
// 送信するのは集計値だけ（生イベントや閲覧者情報は送らない）。

function canonical(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const keys = Object.keys(v).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function hmacHex(key, text) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(text));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
}

export function prevMonthOf(dateStr) {
  const [y, m] = dateStr.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

// period = "YYYY-MM"（JST の暦月）。カウンタの日次行からその月の内訳を作る。
export async function buildUsageReport(repo, period, deploymentId) {
  const totalsRows = await repo.listCountersTotal();
  const meta = new Map(totalsRows.map(r => [r.campaign_id, r]));
  const daily = await repo.listCountersDaily(`${period}-01`, `${period}-32`);
  const byCampaign = new Map();
  for (const d of daily) {
    const m = meta.get(d.campaign_id) || { tenant_id: "unknown", zone_id: "unknown" };
    const key = d.campaign_id;
    if (!byCampaign.has(key)) byCampaign.set(key, { tenant_id: m.tenant_id, zone_id: m.zone_id, campaign_id: key, imp: 0, click: 0 });
    const row = byCampaign.get(key);
    row.imp += d.imp; row.click += d.click;
  }
  const breakdown = [...byCampaign.values()].sort((a, b) => a.campaign_id.localeCompare(b.campaign_id));
  const totals = breakdown.reduce((s, r) => ({ imp: s.imp + r.imp, click: s.click + r.click }), { imp: 0, click: 0 });
  const prev = await repo.getLatestReportBefore(period, "monthly");
  return {
    version: 1,
    kind: "monthly",
    deployment_id: deploymentId || "unknown",
    period,
    generated_at: Date.now(),
    prev_hash: prev ? prev.hash : "",
    totals,
    breakdown,
  };
}

// day = "YYYY-MM-DD"（JST）。その日のカウンタだけを集計する日次チェックポイント。
export async function buildDailyCheckpoint(repo, day, deploymentId) {
  const totalsRows = await repo.listCountersTotal();
  const meta = new Map(totalsRows.map(r => [r.campaign_id, r]));
  const nextDay = new Date(Date.parse(`${day}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  const daily = await repo.listCountersDaily(day, nextDay);
  const byCampaign = new Map();
  for (const d of daily) {
    const m = meta.get(d.campaign_id) || { tenant_id: "unknown", zone_id: "unknown" };
    if (!byCampaign.has(d.campaign_id)) byCampaign.set(d.campaign_id, { tenant_id: m.tenant_id, zone_id: m.zone_id, campaign_id: d.campaign_id, imp: 0, click: 0 });
    const row = byCampaign.get(d.campaign_id);
    row.imp += d.imp; row.click += d.click;
  }
  const breakdown = [...byCampaign.values()].sort((a, b) => a.campaign_id.localeCompare(b.campaign_id));
  const totals = breakdown.reduce((s, r) => ({ imp: s.imp + r.imp, click: s.click + r.click }), { imp: 0, click: 0 });
  const prev = await repo.getLatestReportBefore(day, "daily");
  return {
    version: 1,
    kind: "daily",
    deployment_id: deploymentId || "unknown",
    period: day,
    generated_at: Date.now(),
    prev_hash: prev ? prev.hash : "",
    totals,
    breakdown,
  };
}

export async function signReport(report, licenseKey) {
  const hash = await sha256Hex(canonical(report));
  const signature = licenseKey ? await hmacHex(licenseKey, hash) : null;
  return { ...report, hash, signature };
}

async function deliver(env, repo, core) {
  const kind = core.kind || "monthly";
  const signed = await signReport(core, env.LICENSE_KEY || "");
  let sentAt = null;
  if (env.REPORT_ENDPOINT) {
    const res = await fetch(env.REPORT_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(signed),
    });
    if (!res.ok) throw new Error(`レポート送信に失敗しました（${res.status}）`);
    sentAt = Date.now();
  }
  await repo.saveReport({ period: core.period, kind, deployment_id: signed.deployment_id, payload: signed, hash: signed.hash, sent_at: sentAt });
  return { report: signed, sent: !!sentAt, reused: false };
}

// 生成 → 署名 → 保存 → （REPORT_ENDPOINT があれば）送信。同じ期間は冪等（再生成しない）。
export async function sendUsageReport(env, repo, period, { force = false } = {}) {
  const existing = await repo.getReport(period, "monthly");
  if (existing && !force) return { report: existing.payload, sent: !!existing.sent_at, reused: true };
  return deliver(env, repo, await buildUsageReport(repo, period, env.DEPLOYMENT_ID || "unknown"));
}

export async function sendDailyCheckpoint(env, repo, day, { force = false } = {}) {
  const existing = await repo.getReport(day, "daily");
  if (existing && !force) return { report: existing.payload, sent: !!existing.sent_at, reused: true };
  return deliver(env, repo, await buildDailyCheckpoint(repo, day, env.DEPLOYMENT_ID || "unknown"));
}

// 受信側の検証: ハッシュ再計算 + 署名照合 + 前月との連鎖確認
export async function verifyReport(report, licenseKey, prevReport) {
  const { hash, signature, ...core } = report;
  const recomputed = await sha256Hex(canonical(core));
  if (recomputed !== hash) return { ok: false, reason: "ハッシュ不一致（内容が改ざんされています）" };
  if (licenseKey) {
    const expected = await hmacHex(licenseKey, hash);
    if (expected !== signature) return { ok: false, reason: "署名不一致（ライセンスキーが違うか、署名が偽造されています）" };
  }
  if (prevReport && report.prev_hash !== prevReport.hash) return { ok: false, reason: "前月レポートとの連鎖が切れています" };
  if (!prevReport && report.prev_hash) return { ok: false, reason: "前月レポートが必要です（連鎖の起点ではありません）" };
  return { ok: true };
}
