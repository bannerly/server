// 管理画面（サーバー描画）。配信に効く変更のたびに helpers.publishZone を呼ぶ。
import { jstParts, today, progressOf, aggregateHour, hourKeyOf } from "./deliver.mjs";
import { sendUsageReport, sendDailyCheckpoint, prevMonthOf } from "./report.mjs";
import { effectivePlanRules, rulesSummary, assessFeasibility } from "./rules.mjs";
import { licenseStatus } from "./license.mjs";

export function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
}
function page(title, body) {
  return new Response(`<!doctype html><meta charset="utf-8"><title>${esc(title)}</title>
<body style="font-family:sans-serif;max-width:1024px;margin:24px auto;padding:0 16px;line-height:1.6;">${body}</body>`,
    { headers: { "content-type": "text/html; charset=utf-8" } });
}
const redirect = loc => new Response(null, { status: 303, headers: { location: loc } });
const parseList = (v, num = false) => String(v || "").split(",").map(s => s.trim()).filter(Boolean).map(s => num ? parseInt(s, 10) : s);
const plus30 = () => new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);

export async function handleAdmin(req, url, repo, helpers, newId, env = {}) {
  const parts = url.pathname.split("/").filter(Boolean); // ["admin", ...]
  const sub = parts[1];

  // ---------- POST: 作成・変更 ----------
  if (req.method === "POST") {
    let form;
    try { form = await req.formData(); } catch { form = new FormData(); }
    const g = k => form.get(k);

    if (sub === "tenants") {
      await repo.createTenant({ id: newId("t"), name: g("name") || "無名テナント", created_at: Date.now() });
      return redirect("/admin");
    }
    if (sub === "zones") {
      const z = await repo.createZone({
        id: newId("zone"), tenant_id: g("tenant_id"), name: g("name") || "無名の枠",
        width: parseInt(g("width") || "0", 10) || 0, height: parseInt(g("height") || "0", 10) || 0,
        backfill_html: g("backfill_html") || "", created_at: Date.now(),
      });
      await helpers.publishZone(z.id);
      return redirect("/admin");
    }
    if (sub === "advertisers") {
      await repo.createAdvertiser({ id: newId("adv"), tenant_id: g("tenant_id"), name: g("name") || "無名", contact_email: g("contact_email") || "", created_at: Date.now() });
      return redirect("/admin");
    }
    if (sub === "campaigns") {
      const zone = await repo.getZone(g("zone_id"));
      if (zone) {
        const cid = newId("cmp");
        await repo.createCampaign({
          id: cid, tenant_id: zone.tenant_id, advertiser_id: g("advertiser_id") || "", zone_id: zone.id,
          name: g("name") || "無題キャンペーン", type: g("type") || "remnant",
          starts_at: g("starts_at") || today(), ends_at: g("ends_at") || "2099-12-31",
          goal_impressions: parseInt(g("goal_impressions") || "0", 10) || 0,
          freq_cap_per_day: parseInt(g("freq_cap_per_day") || "0", 10) || 0,
          weight: parseInt(g("weight") || "1", 10) || 1, daily_cap: parseInt(g("daily_cap") || "0", 10) || 0,
          regions: parseList(g("regions")), cities: parseList(g("cities")), hours: String(g("hours") || "").trim(), weekdays: parseList(g("weekdays"), true),
          active: true, created_at: Date.now(),
        });
        if (g("html") || g("image_url") || g("title")) {
          await repo.createBanner({ id: newId("bn"), tenant_id: zone.tenant_id, campaign_id: cid, creative_type: g("creative_type") || "html", html: g("html") || "", image_url: g("image_url") || "", title: g("title") || "", body: g("body") || "", link_url: g("link_url") || "https://example.com/", review_status: "pending", review_note: "", created_at: Date.now() });
        }
        await helpers.publishZone(zone.id);
      }
      return redirect("/admin");
    }
    if (sub === "banners") {
      const c = await repo.getCampaign(g("campaign_id"));
      if (c) {
        await repo.createBanner({ id: newId("bn"), tenant_id: c.tenant_id, campaign_id: c.id, creative_type: g("creative_type") || "html", html: g("html") || "", image_url: g("image_url") || "", title: g("title") || "", body: g("body") || "", link_url: g("link_url") || "", review_status: "pending", review_note: "", created_at: Date.now() });
        await helpers.publishZone(c.zone_id);
      }
      return redirect("/admin");
    }
    if (sub === "review" && parts[2]) {
      const b = await repo.getBanner(parts[2]);
      if (b) {
        await repo.setBannerReview(b.id, g("status") === "approved" ? "approved" : "rejected", g("note") || "");
        const c = await repo.getCampaign(b.campaign_id);
        if (c) await helpers.publishZone(c.zone_id);
      }
      return redirect("/admin");
    }
    if (sub === "toggle" && parts[2]) {
      const c = await repo.getCampaign(parts[2]);
      if (c) { await repo.updateCampaign(c.id, { active: !c.active }); await helpers.publishZone(c.zone_id); }
      return redirect("/admin");
    }
    if (sub === "plans") {
      await repo.createPlan({ id: newId("plan"), name: g("name") || "無名プラン", price_monthly: parseInt(g("price_monthly") || "0", 10) || 0, goal_impressions: parseInt(g("goal_impressions") || "0", 10) || 0, description: g("description") || "",
        rule_weight: parseInt(g("rule_weight") || "0", 10) || 0, rule_freq_cap_per_day: parseInt(g("rule_freq_cap_per_day") || "0", 10) || 0, rule_daily_cap: parseInt(g("rule_daily_cap") || "0", 10) || 0,
        rule_regions: parseList(g("rule_regions")), rule_cities: parseList(g("rule_cities")), rule_hours: String(g("rule_hours") || "").trim(), rule_weekdays: parseList(g("rule_weekdays"), true) });
      return redirect("/admin");
    }
    if (sub === "orders" && !parts[2]) {
      const zone = await repo.getZone(g("zone_id"));
      if (zone) {
        await repo.createOrder({
          id: newId("ord"), tenant_id: zone.tenant_id, advertiser_id: g("advertiser_id"), plan_id: g("plan_id"), zone_id: zone.id,
          starts_at: g("starts_at") || today(), ends_at: g("ends_at") || plus30(), status: "applied", campaign_id: null, created_at: Date.now(),
        });
      }
      return redirect("/admin");
    }
    if (sub === "orders" && parts[2] && parts[3] === "approve") {
      const o = await repo.getOrder(parts[2]);
      if (o && o.status === "applied") {
        const plan = await repo.getPlan(o.plan_id);
        const adv = await repo.getAdvertiser(o.advertiser_id);
        const cid = newId("cmp");
        const rules = effectivePlanRules(plan || {}, o);
        await repo.createCampaign({
          id: cid, tenant_id: o.tenant_id, advertiser_id: o.advertiser_id, zone_id: o.zone_id,
          name: `${adv ? adv.name : "広告主"}（${plan ? plan.name : "プラン"}）`, type: "contract",
          starts_at: o.starts_at, ends_at: o.ends_at, goal_impressions: rules.goal_impressions,
          freq_cap_per_day: rules.freq_cap_per_day, weight: rules.weight, daily_cap: rules.daily_cap,
          regions: rules.regions, cities: rules.cities, hours: rules.hours, weekdays: rules.weekdays, active: true, created_at: Date.now(),
        });
        await repo.updateOrder(o.id, { status: "active", campaign_id: cid });
        await helpers.publishZone(o.zone_id);
      }
      return redirect("/admin");
    }
    if (sub === "orders" && parts[2] && parts[3] === "reject") {
      const o = await repo.getOrder(parts[2]);
      if (o) await repo.updateOrder(o.id, { status: "rejected" });
      return redirect("/admin");
    }
    if (sub === "send-report") {
      const period = g("period") || prevMonthOf(today());
      try {
        const { report, sent, reused } = await sendUsageReport(env, repo, period);
        return page("利用量レポート", `
          <h2>利用量レポート（${esc(period)}）</h2>
          <p>imp 合計: <strong>${report.totals.imp}</strong> / click: ${report.totals.click}<br>
          ハッシュ: <code>${esc(report.hash)}</code><br>
          署名: ${report.signature ? `<code>${esc(report.signature.slice(0, 24))}…</code>` : "なし（LICENSE_KEY 未設定）"}<br>
          送信: ${sent ? "済み" : (env.REPORT_ENDPOINT ? "未送信" : "送信先未設定（ローカル保存のみ）")}${reused ? "（既存レポートを再表示）" : ""}</p>
          <p><a href="/admin/report">レポートへ戻る</a></p>`);
      } catch (e) { return new Response(`送信エラー: ${esc(e.message)}`, { status: 502 }); }
    }
    if (sub === "send-checkpoint") {
      const day = g("day") || jstParts(Date.now() - 86400000).date;
      try {
        const { report, sent, reused } = await sendDailyCheckpoint(env, repo, day);
        return page("日次チェックポイント", `
          <h2>日次チェックポイント（${esc(day)}）</h2>
          <p>imp: <strong>${report.totals.imp}</strong> / click: ${report.totals.click}<br>
          ハッシュ: <code>${esc(report.hash)}</code><br>
          送信: ${sent ? "済み" : (env.REPORT_ENDPOINT ? "未送信" : "送信先未設定（ローカル保存のみ）")}${reused ? "（既存チェックポイントを再表示）" : ""}</p>
          <p><a href="/admin/report">レポートへ戻る</a></p>`);
      } catch (e) { return new Response(`送信エラー: ${esc(e.message)}`, { status: 502 }); }
    }
    if (sub === "rebuild-counters") {
      await repo.rebuildCounters();
      return redirect("/admin/report");
    }
    if (sub === "aggregate") {
      const hour = g("hour") || hourKeyOf(Date.now() - 3600000);
      await aggregateHour(repo, hour);
      return redirect("/admin/report");
    }
    if (sub === "publish") {
      await helpers.publishAll();
      return redirect("/admin");
    }
    return new Response("unknown admin action", { status: 404 });
  }

  // ---------- GET: 月次レポート（広告主ごと） ----------
  if (sub === "monthly") {
    const nowP = jstParts();
    const month = url.searchParams.get("month") || `${nowP.date.slice(0, 7)}`;
    const [yy, mm] = month.split("-").map(x => parseInt(x, 10));
    const from = `${month}-01`;
    const lastDay = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
    const to = `${month}-${String(lastDay).padStart(2, "0")}`;
    const advertisersAll = await repo.listAdvertisers();
    const advId = url.searchParams.get("advertiser");
    const eventsAll = await repo.listEvents();
    const inMonth = eventsAll.filter(e => { const d = jstParts(e.ts).date; return d >= from && d <= to; });
    const campsAll = await repo.listCampaigns();

    if (!advId) {
      const rowsHtml = advertisersAll.map(a => {
        const cids = campsAll.filter(c => c.advertiser_id === a.id).map(c => c.id);
        const evs = inMonth.filter(e => cids.includes(e.campaign_id));
        const imp = evs.filter(e => e.kind === "imp").length;
        const click = evs.filter(e => e.kind === "click").length;
        return `<tr><td>${esc(a.name)}</td><td>${esc(a.tenant_id)}</td><td>${imp}</td><td>${click}</td><td><a href="/admin/monthly?month=${month}&advertiser=${a.id}">レポートを開く</a></td></tr>`;
      }).join("");
      return page("月次レポート", `
        <h1>月次レポート（広告主ごと）</h1><p><a href="/admin">管理画面へ</a></p>
        <form method="get" action="/admin/monthly"><label>対象月 <input type="month" name="month" value="${month}"></label> <button>表示</button></form>
        <table border="1" cellspacing="0" cellpadding="6" style="border-collapse:collapse;font-size:14px;">
        <tr><th>広告主</th><th>テナント</th><th>表示回数</th><th>クリック</th><th></th></tr>${rowsHtml}</table>`);
    }

    const adv = advertisersAll.find(a => a.id === advId);
    if (!adv) return new Response("unknown advertiser", { status: 404 });
    const camps = campsAll.filter(c => c.advertiser_id === advId);
    const cids = camps.map(c => c.id);
    const evs = inMonth.filter(e => cids.includes(e.campaign_id));
    const totalImp = evs.filter(e => e.kind === "imp").length;
    const totalClick = evs.filter(e => e.kind === "click").length;
    const rows = camps.map(c => {
      const ce = evs.filter(e => e.campaign_id === c.id);
      const imp = ce.filter(e => e.kind === "imp").length;
      const click = ce.filter(e => e.kind === "click").length;
      return { zone: c.zone_id, campaign: c.name, type: c.type, imp, click, share: totalImp ? (imp / totalImp * 100).toFixed(1) + "%" : "—", ctr: imp ? (click / imp * 100).toFixed(2) + "%" : "—" };
    });
    if (url.searchParams.get("format") === "csv") {
      const csv = ["advertiser,month,zone,campaign,type,impressions,share,clicks,ctr",
        ...rows.map(r => [`"${adv.name.replace(/"/g, '""')}"`, month, r.zone, `"${r.campaign.replace(/"/g, '""')}"`, r.type, r.imp, r.share, r.click, r.ctr].join(",")),
        `"${adv.name.replace(/"/g, '""')}",${month},,合計,,${totalImp},,${totalClick},`].join("\n");
      return new Response(csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename=monthly-${month}-${advId}.csv` } });
    }
    const dayRows = [...new Set(evs.map(e => jstParts(e.ts).date))].sort().map(d => {
      const de = evs.filter(e => jstParts(e.ts).date === d);
      return `<tr><td>${d}</td><td>${de.filter(e => e.kind === "imp").length}</td><td>${de.filter(e => e.kind === "click").length}</td></tr>`;
    }).join("");
    const tbl = rows.map(r => `<tr><td>${esc(r.zone)}</td><td>${esc(r.campaign)}</td><td>${esc(r.type)}</td><td>${r.imp}</td><td>${r.share}</td><td>${r.click}</td><td>${r.ctr}</td></tr>`).join("");
    return page(`月次レポート ${month}`, `
      <h1>月次レポート</h1>
      <p>広告主: <strong>${esc(adv.name)}</strong> ／ 対象月: <strong>${month}</strong>（${from}〜${to}） ／ 発行日: ${today()}</p>
      <p><a href="/admin/monthly?month=${month}">広告主一覧へ</a> ・ <a href="/admin/monthly?month=${month}&advertiser=${advId}&format=csv">CSVダウンロード</a> ・ <a href="/admin">管理画面へ</a></p>
      <h2>合計</h2>
      <p style="font-size:18px;">表示回数 <strong>${totalImp}</strong> 回 ／ クリック <strong>${totalClick}</strong> 回 ／ CTR <strong>${totalImp ? (totalClick / totalImp * 100).toFixed(2) : "0.00"}%</strong></p>
      <h2>キャンペーン別内訳</h2>
      <table border="1" cellspacing="0" cellpadding="6" style="border-collapse:collapse;font-size:14px;">
      <tr><th>枠</th><th>キャンペーン</th><th>種別</th><th>表示回数</th><th>占有率</th><th>クリック</th><th>CTR</th></tr>${tbl || '<tr><td colspan="7">対象キャンペーンなし</td></tr>'}
      <tr><td colspan="3"><strong>合計</strong></td><td><strong>${totalImp}</strong></td><td>—</td><td><strong>${totalClick}</strong></td><td>—</td></tr></table>
      <h2>日別</h2>
      <table border="1" cellspacing="0" cellpadding="6" style="border-collapse:collapse;font-size:14px;">
      <tr><th>日付</th><th>表示回数</th><th>クリック</th></tr>${dayRows || '<tr><td colspan="3">データなし</td></tr>'}</table>`);
  }

  // ---------- GET: レポート ----------
  if (sub === "report") {
    const from = url.searchParams.get("from") || "2000-01-01";
    const to = url.searchParams.get("to") || "2999-12-31";
    const events = (await repo.listEvents()).filter(e => { const d = jstParts(e.ts).date; return d >= from && d <= to; });
    const camps = await repo.listCampaigns();
    const advs = await repo.listAdvertisers();
    const advName = id => (advs.find(a => a.id === id) || {}).name || id;
    const rows = camps.map(c => {
      const evs = events.filter(e => e.campaign_id === c.id);
      const imp = evs.filter(e => e.kind === "imp").length;
      const click = evs.filter(e => e.kind === "click").length;
      return { tenant: c.tenant_id, zone: c.zone_id, campaign: c.name, advertiser: advName(c.advertiser_id), type: c.type, imp, click, ctr: imp ? (click / imp * 100).toFixed(2) + "%" : "—" };
    }).filter(r => r.imp || r.click);
    if (url.searchParams.get("format") === "csv") {
      const csv = ["tenant,zone,campaign,advertiser,type,impressions,clicks,ctr",
        ...rows.map(r => [r.tenant, r.zone, `"${r.campaign.replace(/"/g, '""')}"`, `"${r.advertiser.replace(/"/g, '""')}"`, r.type, r.imp, r.click, r.ctr].join(","))].join("\n");
      return new Response(csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": "attachment; filename=report.csv" } });
    }
    const stats = await repo.listStatsHourly();
    const statsRows = stats.map(s => {
      const c = camps.find(x => x.id === s.campaign_id);
      return `<tr><td>${esc(s.hour)}</td><td>${esc(c ? c.name : s.campaign_id)}</td><td>${s.imp}</td><td>${s.click}</td></tr>`;
    }).join("");
    const tbl = rows.map(r => `<tr><td>${esc(r.tenant)}</td><td>${esc(r.zone)}</td><td>${esc(r.campaign)}</td><td>${esc(r.advertiser)}</td><td>${esc(r.type)}</td><td>${r.imp}</td><td>${r.click}</td><td>${r.ctr}</td></tr>`).join("");
    return page("レポート", `
      <h1>レポート</h1><p><a href="/admin">管理画面へ</a></p>
      <form method="get" action="/admin/report">
        <label>開始 <input type="date" name="from" value="${esc(url.searchParams.get("from") || "")}"></label>
        <label>終了 <input type="date" name="to" value="${esc(url.searchParams.get("to") || "")}"></label>
        <button>表示</button>
        <a href="/admin/report?from=${esc(url.searchParams.get("from") || "")}&to=${esc(url.searchParams.get("to") || "")}&format=csv">CSVダウンロード</a>
      </form>
      <h2>キャンペーン別（生イベント集計）</h2>
      <table border="1" cellspacing="0" cellpadding="6" style="border-collapse:collapse;font-size:14px;">
      <tr><th>テナント</th><th>枠</th><th>キャンペーン</th><th>広告主</th><th>種別</th><th>表示</th><th>クリック</th><th>CTR</th></tr>${tbl || '<tr><td colspan="8">データなし</td></tr>'}</table>
      <h2>時間次集計（stats_hourly）</h2>
      <form method="post" action="/admin/aggregate"><label>対象時（例 2026-10-27T15） <input name="hour" placeholder="空=前時"></label> <button>集計する</button></form>
      <form method="post" action="/admin/rebuild-counters" style="margin-top:8px;"><button>配信カウンタを再構築（生イベントから再計算）</button></form>
      <form method="post" action="/admin/send-report" style="margin-top:8px;"><label>利用量レポート期間（YYYY-MM） <input name="period" value="${prevMonthOf(today())}"></label> <button>署名付きレポートを生成・送信</button></form>
      <form method="post" action="/admin/send-checkpoint" style="margin-top:8px;"><label>日次チェックポイント（YYYY-MM-DD） <input name="day" value="${jstParts(Date.now() - 86400000).date}"></label> <button>チェックポイントを署名・送信</button></form>
      <table border="1" cellspacing="0" cellpadding="6" style="border-collapse:collapse;font-size:14px;">
      <tr><th>時</th><th>キャンペーン</th><th>表示</th><th>クリック</th></tr>${statsRows || '<tr><td colspan="4">未集計</td></tr>'}</table>`);
  }

  // ---------- GET: ダッシュボード ----------
  const [tenants, zones, campaigns, banners, plans, orders, advertisers] = await Promise.all([
    repo.listTenants(), repo.listZones(), repo.listCampaigns(), repo.listBanners(), repo.listPlans(), repo.listOrders(), repo.listAdvertisers(),
  ]);
  const pending = banners.filter(b => b.review_status === "pending");
  const reviewHtml = pending.length ? pending.map(b => {
    const c = campaigns.find(x => x.id === b.campaign_id);
    return `<div style="border:1px solid #ccc;padding:10px;margin:8px 0;">
      <div style="font-size:13px;color:#555;">キャンペーン: ${esc(c ? c.name : b.campaign_id)} / テナント: ${esc(b.tenant_id)}</div>
      <div style="border:1px dashed #aaa;margin:6px 0;">${b.creative_type === "native"
        ? `${b.image_url ? `<img src="${esc(b.image_url)}" style="max-width:300px;max-height:120px;display:block;">` : ""}<strong>${esc(b.title || "")}</strong><div>${esc(b.body || "")}</div><div style="font-size:11px;color:#888;">（構造化クリエイティブ）</div>`
        : b.html}</div>
      <div style="font-size:13px;">リンク先: ${esc(b.link_url)}</div>
      <form method="post" action="/admin/review/${b.id}" style="display:inline"><input type="hidden" name="status" value="approved"><button>承認する</button></form>
      <form method="post" action="/admin/review/${b.id}" style="display:inline"><input type="hidden" name="status" value="rejected"><button>却下する</button></form>
    </div>`;
  }).join("") : "<p>審査待ちはありません。</p>";

  const tenantHtml = tenants.map(t => {
    const tZones = zones.filter(z => z.tenant_id === t.id);
    const zoneHtml = tZones.map(z => {
      const camps = campaigns.filter(c => c.zone_id === z.id);
      const rowsHtml = camps.map(c => {
        const adv = advertisers.find(a => a.id === c.advertiser_id);
        const p = progressOf(c, 0); // 進捗はレポート側で実数表示（ここでは目標のみ）
        const rules = [
          c.regions?.length ? `地域:${c.regions.join("/")}` : null,
          c.cities?.length ? `市:${c.cities.join("/")}` : null,
          c.hours ? `時間:${c.hours}` : null,
          c.weekdays?.length ? `曜日:${c.weekdays.join("/")}` : null,
          c.daily_cap ? `日次上限:${c.daily_cap}` : null,
          c.freq_cap_per_day ? `FC/日:${c.freq_cap_per_day}` : null,
          c.weight && c.weight !== 1 ? `重み:${c.weight}` : null,
        ].filter(Boolean).join(" / ");
        const bcount = banners.filter(b => b.campaign_id === c.id);
        const appr = bcount.filter(b => b.review_status === "approved").length;
        return `<tr><td>${esc(c.name)}</td><td>${esc(adv ? adv.name : c.advertiser_id)}</td><td>${esc(c.type)}</td><td>${c.active ? "有効" : "停止"}</td>
          <td>${c.starts_at}〜${c.ends_at}</td><td>${esc(rules) || "—"}</td><td>目標 ${c.goal_impressions || "—"}</td><td>バナー ${appr}/${bcount.length} 承認</td>
          <td><form method="post" action="/admin/toggle/${c.id}" style="display:inline"><button>${c.active ? "停止" : "開始"}</button></form></td></tr>`;
      }).join("");
      return `<h3>枠: ${esc(z.name)}（<code>${esc(z.id)}</code> / ${z.width}×${z.height}）</h3>
        <p>埋め込み: <code>&lt;script src="/tag/${z.id}.js"&gt;&lt;/script&gt;</code> ・ 配信: <code>/ad/${z.id}</code></p>
        <table border="1" cellspacing="0" cellpadding="6" style="border-collapse:collapse;font-size:14px;">
        <tr><th>キャンペーン</th><th>広告主</th><th>種別</th><th>状態</th><th>期間</th><th>ルール</th><th>目標</th><th>バナー</th><th></th></tr>${rowsHtml}</table>`;
    }).join("");
    return `<h2>テナント: ${esc(t.name)}（${esc(t.id)}）</h2><p style="font-size:13px;color:#555;">Stripe: ${t.stripe_account_id ? `接続済み（${esc(t.stripe_account_id)} / 課金 ${t.stripe_charges_enabled ? "有効" : "確認中"})` : "未接続（テナントコンソールから接続）"}</p>${zoneHtml || "<p>枠がありません。</p>"}`;
  }).join("<hr>");

  const zoneImp30 = {};
  if (typeof repo.getZoneImpStats === "function") {
    for (const z of zones) zoneImp30[z.id] = await repo.getZoneImpStats(z.id, 30);
  }
  const feasLabel = f => ({
    ok: "余裕",
    tight: `<span style="color:#b58900">注意（枠実績の約${Math.round(f.ratio * 100)}%）</span>`,
    over: `<span style="color:#c00">⚠ 目標が枠の直近実績ペースを超過</span>`,
    unknown: "実績なし",
    none: "—",
  })[f.level] || "—";
  const orderRows = orders.map(o => {
    const plan = plans.find(p => p.id === o.plan_id);
    const adv = advertisers.find(a => a.id === o.advertiser_id);
    const feas = feasLabel(assessFeasibility(plan || {}, o, zoneImp30[o.zone_id] || 0));
    const act = o.status === "applied"
      ? `<form method="post" action="/admin/orders/${o.id}/approve" style="display:inline"><button>承認してキャンペーン化</button></form>
         <form method="post" action="/admin/orders/${o.id}/reject" style="display:inline"><button>却下</button></form>` : "";
    return `<tr><td>${esc(adv ? adv.name : o.advertiser_id)}</td><td>${esc(plan ? `${plan.name}（月${plan.price_monthly.toLocaleString()}円）` : o.plan_id)}</td><td>${esc(o.zone_id)}</td><td>${o.starts_at}〜${o.ends_at}</td><td>${esc(o.status)}</td><td>${esc(o.payment_status || "unpaid")}</td><td>${esc(o.campaign_id || "—")}</td><td>${feas}</td><td>${act}</td></tr>`;
  }).join("");
  const planRows = plans.map(p => `<tr><td>${esc(p.name)}</td><td>${p.price_monthly.toLocaleString()}円</td><td>${p.goal_impressions}</td><td>${esc(rulesSummary(effectivePlanRules(p, {})))}</td><td>${esc(p.description || "")}</td></tr>`).join("");
  const sel = (items, val, label) => items.map(i => `<option value="${esc(i[val])}">${esc(i[label])}</option>`).join("");
  const lic = await licenseStatus(env);
  const licHtml = {
    unset: `<p style="font-size:13px;color:#888;">ライセンス: 未設定（LICENSE_FILE が設定されていません）</p>`,
    valid: `<p style="font-size:13px;">ライセンス: <strong>有効</strong> — ${esc(lic.payload.licensee || "")} / デプロイ ${esc(lic.payload.deployment_id || "")} / 期限 ${esc(lic.payload.expires_at || "")}（残り${lic.daysLeft}日）${lic.expiringSoon ? ' <span style="color:#b58900">※期限が近づいています</span>' : ""}${lic.deploymentMismatch ? ' <span style="color:#c00">※DEPLOYMENT_ID と一致しません</span>' : ""}</p>`,
    expired: `<p style="font-size:13px;color:#c00;">ライセンス: <strong>期限切れ</strong> — ${esc(lic.payload.licensee || "")} / 期限 ${esc(lic.payload.expires_at || "")}（配信は継続中です。発行元へ更新を依頼してください）</p>`,
    invalid: `<p style="font-size:13px;color:#c00;">ライセンス: <strong>検証失敗</strong> — ${esc(lic.reason || "")}（配信は継続中です）</p>`,
    unverifiable: `<p style="font-size:13px;color:#b58900;">ライセンス: ファイルはありますが検証できません — ${esc(lic.reason || "")}</p>`,
  }[lic.state] || "";

  return page("広告管理（本番構成）", `
    <h1>広告管理画面（本番構成）</h1>
    <p><a href="/demo">デモページ</a> / <a href="/admin/report">レポート</a> / <a href="/admin/monthly">月次レポート（広告主ごと）</a></p>
    ${licHtml}
    <form method="post" action="/admin/publish" style="display:inline"><button>スナップショット再発行</button></form>
    <h2>審査キュー（${pending.length}件）</h2>${reviewHtml}
    <hr>${tenantHtml}
    <hr><h2>申込（orders）</h2>
    <table border="1" cellspacing="0" cellpadding="6" style="border-collapse:collapse;font-size:14px;">
    <tr><th>広告主</th><th>プラン</th><th>枠</th><th>期間</th><th>状態</th><th>支払い</th><th>キャンペーン</th><th>見込み</th><th></th></tr>${orderRows || '<tr><td colspan="9">申込なし</td></tr>'}</table>
    <h2>プラン</h2>
    <table border="1" cellspacing="0" cellpadding="6" style="border-collapse:collapse;font-size:14px;">
    <tr><th>名前</th><th>月額</th><th>目標imp</th><th>自動ルール（日次上限は30日換算の目安）</th><th>説明</th></tr>${planRows}</table>

    <hr><h2>追加フォーム</h2>
    <div style="display:grid;gap:20px;">
    <form method="post" action="/admin/campaigns" style="display:grid;gap:6px;max-width:680px;">
      <strong>キャンペーン追加（バナーは審査待ちで登録されます）</strong>
      <label>枠 <select name="zone_id">${sel(zones, "id", "id")}</select></label>
      <label>広告主 <select name="advertiser_id">${advertisers.map(a => `<option value="${a.id}">${esc(a.name)}（${esc(a.tenant_id)}）</option>`).join("")}</select></label>
      <label>名前 <input name="name" required style="width:100%"></label>
      <label>種別 <select name="type"><option value="override">override</option><option value="contract" selected>contract</option><option value="remnant">remnant</option></select></label>
      <label>開始日 <input name="starts_at" type="date" value="${today()}"> 終了日 <input name="ends_at" type="date" value="2099-12-31"></label>
      <label>目標imp <input name="goal_impressions" type="number" value="0"> 日次上限 <input name="daily_cap" type="number" value="0"> 重み <input name="weight" type="number" value="1"> FC/日 <input name="freq_cap_per_day" type="number" value="0"></label>
      <label>地域（カンマ区切り） <input name="regions" style="width:60%"></label>
      <label>市（カンマ区切り・cf.city の英語表記 例 Yokohama,Chiba） <input name="cities" style="width:60%"></label>
      <label>時間帯（例 18-24） <input name="hours"> 曜日（0=日〜6=土） <input name="weekdays"></label>
      <label>クリエイティブ種別 <select name="creative_type"><option value="html">HTML（Web向け）</option><option value="native">構造化（アプリ向け: 画像+文）</option></select></label>
      <label>バナーHTML（html種別用） <textarea name="html" rows="3" style="width:100%"></textarea></label>
      <label>画像URL（構造化用） <input name="image_url" style="width:100%"></label>
      <label>タイトル（構造化用） <input name="title" style="width:100%"></label>
      <label>本文（構造化用） <input name="body" style="width:100%"></label>
      <label>リンク先 <input name="link_url" value="https://example.com/" style="width:100%"></label>
      <button>追加する</button>
    </form>
    <form method="post" action="/admin/banners" style="display:grid;gap:6px;max-width:680px;">
      <strong>バナー追加（既存キャンペーンへ・審査待ち）</strong>
      <label>キャンペーン <select name="campaign_id">${sel(campaigns, "id", "name")}</select></label>
      <label>クリエイティブ種別 <select name="creative_type"><option value="html">HTML（Web向け）</option><option value="native">構造化（アプリ向け: 画像+文）</option></select></label>
      <label>バナーHTML（html種別用） <textarea name="html" rows="3" style="width:100%"></textarea></label>
      <label>画像URL（構造化用） <input name="image_url" style="width:100%"></label>
      <label>タイトル（構造化用） <input name="title" style="width:100%"></label>
      <label>本文（構造化用） <input name="body" style="width:100%"></label>
      <label>リンク先 <input name="link_url" value="https://example.com/" style="width:100%"></label>
      <button>追加する</button>
    </form>
    <form method="post" action="/admin/orders" style="display:grid;gap:6px;max-width:680px;">
      <strong>申込の登録</strong>
      <label>広告主 <select name="advertiser_id">${advertisers.map(a => `<option value="${a.id}">${esc(a.name)}</option>`).join("")}</select></label>
      <label>プラン <select name="plan_id">${plans.map(p => `<option value="${p.id}">${esc(p.name)}（月${p.price_monthly.toLocaleString()}円）</option>`).join("")}</select></label>
      <label>枠 <select name="zone_id">${sel(zones, "id", "id")}</select></label>
      <label>開始日 <input name="starts_at" type="date" value="${today()}"> 終了日 <input name="ends_at" type="date" value="${plus30()}"></label>
      <button>申込を登録</button>
    </form>
    <form method="post" action="/admin/zones" style="display:grid;gap:6px;max-width:680px;">
      <strong>枠の追加</strong>
      <label>テナント <select name="tenant_id">${sel(tenants, "id", "name")}</select></label>
      <label>名前 <input name="name" style="width:60%"></label>
      <label>幅 <input name="width" type="number" value="300"> 高さ <input name="height" type="number" value="250"></label>
      <label>バックフィルHTML（GAMタグ等） <textarea name="backfill_html" rows="2" style="width:100%"></textarea></label>
      <button>枠を追加</button>
    </form>
    <form method="post" action="/admin/advertisers" style="display:grid;gap:6px;max-width:680px;">
      <strong>広告主の追加</strong>
      <label>テナント <select name="tenant_id">${sel(tenants, "id", "name")}</select></label>
      <label>名前 <input name="name" style="width:60%"></label>
      <label>連絡先メール <input name="contact_email" style="width:60%"></label>
      <button>広告主を追加</button>
    </form>
    <form method="post" action="/admin/tenants" style="display:grid;gap:6px;max-width:680px;">
      <strong>テナントの追加</strong>
      <label>名前 <input name="name" style="width:60%"></label>
      <button>テナントを追加</button>
    </form>
    <form method="post" action="/admin/plans" style="display:grid;gap:6px;max-width:680px;">
      <strong>プランの追加</strong>
      <label>名前 <input name="name" style="width:60%"></label>
      <label>月額 <input name="price_monthly" type="number" value="0"> 目標imp <input name="goal_impressions" type="number" value="0"></label>
      <label>説明 <input name="description" style="width:100%"></label>
      <label>ルール上書き（0・空欄＝月額から自動） 重み <input name="rule_weight" type="number" value="0" style="width:70px"> 日次上限 <input name="rule_daily_cap" type="number" value="0" style="width:100px"> FC/日 <input name="rule_freq_cap_per_day" type="number" value="0" style="width:70px"></label>
      <label>対象地域（カンマ区切り） <input name="rule_regions" style="width:60%"></label>
      <label>対象市（カンマ区切り・英語表記 例 Yokohama） <input name="rule_cities" style="width:60%"></label>
      <label>時間帯（例 18-24） <input name="rule_hours"> 曜日（0=日〜6=土） <input name="rule_weekdays"></label>
      <button>プランを追加</button>
    </form>
    </div>`);
}
