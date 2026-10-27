// 広告基盤 本番構成エントリ（Cloudflare Workers）
// env.DB があれば D1、なければローカルJSON。スナップショット/配信トークンは KV(env.SNAP) 優先。
import { LocalRepo, newId as localNewId } from "./repo-local.mjs";
import { D1Repo, newId as d1NewId } from "./repo-d1.mjs";
import { jstParts, today, pickFromSnapshot, buildSnapshot, publishAllSnapshots, aggregateHour, hourKeyOf } from "./deliver.mjs";
import { handleAdmin, esc } from "./admin.mjs";

const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x21, 0xf9, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00, 0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02, 0x44, 0x01, 0x00, 0x3b]);
let localRepo = null;

function getRepo(env) {
  if (env.DB) return new D1Repo(env.DB);
  if (!localRepo) localRepo = new LocalRepo();
  return localRepo;
}
const newId = prefix => (typeof crypto !== "undefined" && crypto.randomUUID)
  ? `${prefix}-${crypto.randomUUID().slice(0, 8)}` : localNewId(prefix);

function snapStore(env, repo) {
  if (env.SNAP) {
    return {
      get: async zoneId => { const v = await env.SNAP.get(`snap:${zoneId}`, "json"); return v || null; },
      put: async (zoneId, snap) => { await env.SNAP.put(`snap:${zoneId}`, JSON.stringify(snap)); },
    };
  }
  return { get: zoneId => repo.getSnapshot(zoneId), put: (zoneId, snap) => repo.putSnapshot(zoneId, snap) };
}
function deliveryStore(env, repo) {
  if (env.SNAP) {
    return {
      put: async (token, d) => { await env.SNAP.put(`dlv:${token}`, JSON.stringify(d), { expirationTtl: 3600 }); },
      get: async token => { const v = await env.SNAP.get(`dlv:${token}`, "json"); return v || null; },
      mark: async (token, d) => { await env.SNAP.put(`dlv:${token}`, JSON.stringify({ ...d, counted: true }), { expirationTtl: 3600 }); },
    };
  }
  return {
    put: (token, d) => repo.putDelivery(token, d),
    get: token => repo.getDelivery(token),
    mark: token => repo.markDeliveryCounted(token),
  };
}

async function emitEvent(env, repo, ev) {
  if (env.EVENTS) { await env.EVENTS.send(ev); return; }
  await repo.insertEvent(ev);
}

async function serveAd(env, repo, zoneId, req, url) {
  const snap = snapStore(env, repo);
  let snapshot = await snap.get(zoneId);
  if (!snapshot) {
    const zone = await repo.getZone(zoneId);
    if (!zone) return new Response("unknown zone", { status: 404 });
    snapshot = await buildSnapshot(repo, zone);
    await snap.put(zoneId, snapshot);
  }
  const zone = snapshot.zone;
  const parts = jstParts();
  const ctx = {
    region: url.searchParams.get("region") || req.headers.get("x-region") || (req.cf && req.cf.region) || null,
    hour: parts.hour, weekday: parts.weekday, cookie: req.headers.get("cookie") || "",
  };
  const countsFn = async c => ({
    total: await repo.getCount(c.id, null, jstParts),
    today: await repo.getCount(c.id, parts.date, jstParts),
  });
  const picked = await pickFromSnapshot(snapshot, ctx, countsFn);
  if (!picked) {
    if (url.searchParams.get("format") === "json") return Response.json({ zone: zoneId, source: "backfill", html: zone.backfill_html });
    return new Response(zone.backfill_html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  }
  const { campaign, banner } = picked;
  const token = newId("dlv");
  await deliveryStore(env, repo).put(token, { tenant_id: zone.tenant_id, zone_id: zoneId, campaign_id: campaign.id, banner_id: banner.id, counted: false });
  const creativeType = banner.creative_type || "html";
  const creativeHtml = creativeType === "native"
    ? `<div style="font-family:sans-serif;">${banner.image_url ? `<img src="${banner.image_url}" style="max-width:100%;display:block;">` : ""}<div style="font-weight:bold;">${esc(banner.title || "")}</div><div>${esc(banner.body || "")}</div></div>`
    : banner.html;
  const html = `<div style="font-size:10px;color:#888;font-family:sans-serif;">広告</div><a href="/click/${token}" target="_blank" rel="noopener sponsored" style="text-decoration:none;color:inherit;">${creativeHtml}</a><img src="/imp/${token}" width="1" height="1" alt="" style="position:absolute;visibility:hidden;">`;
  if (url.searchParams.get("format") === "json") {
    return Response.json({
      zone: zoneId, source: campaign.type, campaign: campaign.name,
      creative: {
        type: creativeType, html: creativeType === "html" ? banner.html : undefined,
        image_url: banner.image_url || undefined, title: banner.title || undefined, body: banner.body || undefined,
        link_url: banner.link_url, imp_url: `/imp/${token}`, click_url: `/click/${token}`,
      },
      html,
    });
  }
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

function adminAuthorized(env, req, url) {
  const token = env.ADMIN_TOKEN;
  if (!token) return true; // ローカル開発用。本番は secret 設定 + Cloudflare Access を前段に置く
  if (req.headers.get("x-admin-token") === token) return true;
  const cookie = req.headers.get("cookie") || "";
  return cookie.split(";").some(c => c.trim() === `admin_token=${token}`);
}

export default {
  async fetch(req, env = {}, ctx = {}) {
    const url = new URL(req.url);
    const repo = getRepo(env);
    const parts = url.pathname.split("/").filter(Boolean);

    if (parts[0] === "ad" && parts[1]) return serveAd(env, repo, parts[1], req, url);

    if (parts[0] === "tag" && parts[1]?.endsWith(".js")) {
      const zoneId = parts[1].replace(/\.js$/, "");
      const js = `document.write('<div class="adslot" data-zone="${zoneId}"></div>');fetch('/ad/${zoneId}').then(r=>r.text()).then(h=>{document.currentScript.previousElementSibling.innerHTML=h;});`;
      return new Response(js, { headers: { "content-type": "text/javascript; charset=utf-8" } });
    }

    if (parts[0] === "imp" && parts[1]) {
      const ds = deliveryStore(env, repo);
      const d = await ds.get(parts[1]);
      if (d && !d.counted) {
        await ds.mark(parts[1], d);
        await emitEvent(env, repo, { id: newId("ev"), ts: Date.now(), kind: "imp", tenant_id: d.tenant_id, zone_id: d.zone_id, campaign_id: d.campaign_id, banner_id: d.banner_id });
      }
      return new Response(GIF, { headers: { "content-type": "image/gif", "cache-control": "no-store" } });
    }
    if (parts[0] === "click" && parts[1]) {
      const ds = deliveryStore(env, repo);
      const d = await ds.get(parts[1]);
      let dest = "/";
      if (d) {
        const banner = await repo.getBanner(d.banner_id);
        if (banner) dest = banner.link_url || "/";
        await emitEvent(env, repo, { id: newId("ev"), ts: Date.now(), kind: "click", tenant_id: d.tenant_id, zone_id: d.zone_id, campaign_id: d.campaign_id, banner_id: d.banner_id });
      }
      return new Response(null, { status: 302, headers: { location: dest } });
    }

    if (url.pathname === "/demo") {
      return new Response(`<!doctype html><meta charset="utf-8"><title>デモ</title><body style="font-family:sans-serif;max-width:960px;margin:24px auto;padding:0 16px;">
        <h1>デモ: ポータルページ（テナント: デモポータル）</h1><iframe src="/ad/portal-top" width="760" height="130" style="border:0;"></iframe>
        <h2 style="margin-top:40px;">別テナントのサイト（提携店舗（デモ））</h2><iframe src="/ad/shop-side" width="320" height="290" style="border:0;"></iframe>
        <p><a href="/admin">管理画面</a> / <a href="/admin/report">レポート</a></p></body>`,
        { headers: { "content-type": "text/html; charset=utf-8" } });
    }

    if (parts[0] === "admin") {
      if (!adminAuthorized(env, req, url)) {
        return new Response("unauthorized: x-admin-token ヘッダか admin_token クッキーが必要です", { status: 401 });
      }
      const snap = snapStore(env, repo);
      const helpers = {
        publishZone: async zoneId => { const z = await repo.getZone(zoneId); if (z) await snap.put(zoneId, await buildSnapshot(repo, z)); },
        publishAll: async () => { await publishAllSnapshots(repo, (zid, s) => snap.put(zid, s)); },
      };
      return handleAdmin(req, url, repo, helpers, newId);
    }

    if (url.pathname === "/") {
      return new Response(`<!doctype html><meta charset="utf-8"><title>ad-platform</title><body style="font-family:sans-serif;max-width:960px;margin:24px auto;padding:0 16px;">
        <h1>広告基盤（本番構成）</h1><p><a href="/demo">デモ</a> / <a href="/admin">管理画面</a> / <a href="/admin/report">レポート</a></p></body>`,
        { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    return new Response("not found", { status: 404 });
  },

  // Queue コンシューマ: 計測イベントを D1 へ
  async queue(batch, env) {
    const repo = getRepo(env);
    for (const msg of batch.messages) {
      try { await repo.insertEvent(msg.body); msg.ack(); }
      catch { msg.retry(); }
    }
  },

  // Cron: スナップショット再発行 + 前時分の集計
  async scheduled(event, env) {
    const repo = getRepo(env);
    const snap = snapStore(env, repo);
    await publishAllSnapshots(repo, (zid, s) => snap.put(zid, s));
    await aggregateHour(repo, hourKeyOf(Date.now() - 3600000));
  },
};
