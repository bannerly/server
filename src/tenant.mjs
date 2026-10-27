// セルフテナント登録と、テナント専用コンソール。
// 登録すると tenant + tenant_admin ユーザーが作られ、管理トークンが一度だけ表示される。
// トークンは SHA-256 ハッシュで保存し、コンソールは自テナントのデータだけを表示・操作できる。
import { esc } from "./admin.mjs";
import { today } from "./deliver.mjs";
import { stripeEnabled, createConnectAccount, createAccountLink, createOrderCheckout, sendOrderInvoice } from "./stripe.mjs";

const RESERVED = new Set(["admin", "signup", "tenant", "ad", "tag", "imp", "click", "demo", "stripe", "api"]);
const slugOk = s => /^[a-z0-9][a-z0-9-]{2,31}$/.test(s) && !RESERVED.has(s);
const plus30 = () => new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);

export async function hashToken(token) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}
export function newToken() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
}
function page(title, body, extraHeaders = {}) {
  return new Response(`<!doctype html><meta charset="utf-8"><title>${esc(title)}</title>
<body style="font-family:sans-serif;max-width:1024px;margin:24px auto;padding:0 16px;line-height:1.6;">${body}</body>`,
    { headers: { "content-type": "text/html; charset=utf-8", ...extraHeaders } });
}
const redirect = loc => new Response(null, { status: 303, headers: { location: loc } });

export async function handleSignup(req, url, repo, newId) {
  if (req.method === "GET") {
    return page("テナント登録", `
      <h1>Slotly テナント登録</h1>
      <p>登録すると、あなたの広告枠を管理するテナントと管理トークンが発行されます。</p>
      <form method="post" action="/signup" style="display:grid;gap:8px;max-width:480px;">
        <label>テナント名（会社・サービス名） <input name="name" required style="width:100%"></label>
        <label>テナントID（半角英小文字・数字・ハイフン、3〜32文字。URLや枠の管理に使います） <input name="slug" required pattern="[a-z0-9][a-z0-9-]{2,31}" style="width:100%"></label>
        <label>担当者メールアドレス <input name="email" type="email" required style="width:100%"></label>
        <button>登録する</button>
      </form>`);
  }
  const form = await req.formData();
  const name = String(form.get("name") || "").trim();
  const slug = String(form.get("slug") || "").trim();
  const email = String(form.get("email") || "").trim();
  if (!name || !slugOk(slug) || !email.includes("@")) {
    return new Response("入力が不正です（テナントIDの形式、メールアドレスを確認してください）", { status: 400 });
  }
  if (await repo.getTenant(slug)) return new Response("そのテナントIDは既に使われています", { status: 409 });
  const token = newToken();
  await repo.createTenant({ id: slug, name, stripe_account_id: "", stripe_charges_enabled: 0, created_at: Date.now() });
  await repo.createUser({ id: newId("u"), tenant_id: slug, email, role: "tenant_admin", token_hash: await hashToken(token), created_at: Date.now() });
  return page("登録完了", `
    <h1>登録が完了しました</h1>
    <p>テナント: <strong>${esc(name)}</strong>（<code>${esc(slug)}</code>）</p>
    <p>管理トークン（<strong>この画面でだけ表示されます。必ず保存してください</strong>）:</p>
    <p style="font-size:18px;background:#f4f4f4;padding:12px;"><code>${esc(token)}</code></p>
    <p><a href="/tenant">テナントコンソールを開く</a>（このブラウザではトークンを Cookie に保存しました）</p>`,
    { "set-cookie": `tenant_token=${token}; Path=/; HttpOnly; SameSite=Lax` });
}

export async function tenantAuth(req, url, repo) {
  const token = req.headers.get("x-tenant-token")
    || url.searchParams.get("token")
    || ((req.headers.get("cookie") || "").split(";").map(s => s.trim()).find(s => s.startsWith("tenant_token=")) || "").split("=")[1];
  if (!token) return null;
  const user = await repo.getUserByTokenHash(await hashToken(token));
  if (!user || !user.tenant_id) return null;
  const tenant = await repo.getTenant(user.tenant_id);
  return tenant ? { user, tenant } : null;
}

export async function handleTenant(req, url, repo, helpers, newId, env) {
  const auth = await tenantAuth(req, url, repo);
  if (!auth) {
    return page("テナントコンソール", `
      <h1>テナントコンソール</h1>
      <p>管理トークンが必要です。</p>
      <form method="get" action="/tenant" style="display:grid;gap:8px;max-width:480px;">
        <label>管理トークン <input name="token" style="width:100%"></label>
        <button>開く</button>
      </form>
      <p>まだ登録していない場合は <a href="/signup">テナント登録</a> からどうぞ。</p>`);
  }
  const { tenant } = auth;
  const tid = tenant.id;
  const parts = url.pathname.split("/").filter(Boolean); // ["tenant", ...]

  if (req.method === "POST") {
    const form = await req.formData().catch(() => new FormData());
    const g = k => form.get(k);
    if (parts[1] === "zones") {
      const z = await repo.createZone({ id: newId("zone"), tenant_id: tid, name: g("name") || "無名の枠", width: parseInt(g("width") || "0", 10) || 0, height: parseInt(g("height") || "0", 10) || 0, backfill_html: g("backfill_html") || "", created_at: Date.now() });
      await helpers.publishZone(z.id);
      return redirect("/tenant");
    }
    if (parts[1] === "advertisers") {
      await repo.createAdvertiser({ id: newId("adv"), tenant_id: tid, name: g("name") || "無名", contact_email: g("contact_email") || "", created_at: Date.now() });
      return redirect("/tenant");
    }
    if (parts[1] === "orders" && !parts[2]) {
      const zone = await repo.getZone(g("zone_id"));
      if (zone && zone.tenant_id === tid) {
        await repo.createOrder({ id: newId("ord"), tenant_id: tid, advertiser_id: g("advertiser_id"), plan_id: g("plan_id"), zone_id: zone.id, starts_at: g("starts_at") || today(), ends_at: g("ends_at") || plus30(), status: "applied", campaign_id: null, payment_status: "unpaid", created_at: Date.now() });
      }
      return redirect("/tenant");
    }
    if (parts[1] === "stripe" && parts[2] === "connect") {
      if (!stripeEnabled(env)) return new Response("Stripe が未設定です（STRIPE_SECRET_KEY）", { status: 501 });
      try {
        let acctId = tenant.stripe_account_id;
        if (!acctId) {
          const acct = await createConnectAccount(env, tenant, auth.user.email);
          acctId = acct.id;
          await repo.updateTenant(tid, { stripe_account_id: acctId });
        }
        const link = await createAccountLink(env, acctId);
        return redirect(link.url);
      } catch (e) { return new Response(`Stripe 接続エラー: ${esc(e.message)}`, { status: 502 }); }
    }
    if (parts[1] === "orders" && parts[2] && (parts[3] === "checkout" || parts[3] === "invoice")) {
      const o = await repo.getOrder(parts[2]);
      if (!o || o.tenant_id !== tid) return new Response("unknown order", { status: 404 });
      if (!stripeEnabled(env)) return new Response("Stripe が未設定です（STRIPE_SECRET_KEY）", { status: 501 });
      const plan = await repo.getPlan(o.plan_id);
      const adv = await repo.getAdvertiser(o.advertiser_id);
      try {
        if (parts[3] === "checkout") {
          const s = await createOrderCheckout(env, tenant, o, plan, adv);
          await repo.updateOrder(o.id, { stripe_session_id: s.id });
          return redirect(s.url);
        }
        const inv = await sendOrderInvoice(env, tenant, o, plan, adv);
        await repo.updateOrder(o.id, { stripe_invoice_id: inv.id, stripe_invoice_url: inv.hosted_invoice_url || "" });
        return redirect("/tenant?msg=invoice_sent");
      } catch (e) { return new Response(`Stripe エラー: ${esc(e.message)}`, { status: 502 }); }
    }
    return new Response("unknown tenant action", { status: 404 });
  }

  const [zones, campaigns, orders, plans, advertisers] = await Promise.all([
    repo.listZones(), repo.listCampaigns(), repo.listOrders(), repo.listPlans(), repo.listAdvertisers(tid),
  ]);
  const myZones = zones.filter(z => z.tenant_id === tid);
  const myCamps = campaigns.filter(c => c.tenant_id === tid);
  const myOrders = orders.filter(o => o.tenant_id === tid);
  const sel = (items, val, label) => items.map(i => `<option value="${esc(i[val])}">${esc(i[label])}</option>`).join("");
  const zoneRows = myZones.map(z => {
    const camps = myCamps.filter(c => c.zone_id === z.id).length;
    return `<tr><td>${esc(z.name)}</td><td><code>${esc(z.id)}</code></td><td>${z.width}×${z.height}</td><td>キャンペーン ${camps} 件</td><td><code>/ad/${esc(z.id)}</code></td></tr>`;
  }).join("");
  const orderRows = myOrders.map(o => {
    const plan = plans.find(p => p.id === o.plan_id);
    const adv = advertisers.find(a => a.id === o.advertiser_id);
    const pay = tenant.stripe_account_id && o.payment_status !== "paid"
      ? `<form method="post" action="/tenant/orders/${o.id}/checkout" style="display:inline"><button>支払いリンク（Checkout）</button></form>
         <form method="post" action="/tenant/orders/${o.id}/invoice" style="display:inline"><button>請求書を送る</button></form>` : "";
    const invLink = o.stripe_invoice_url ? ` <a href="${esc(o.stripe_invoice_url)}" target="_blank" rel="noopener">請求書</a>` : "";
    return `<tr><td>${esc(adv ? adv.name : o.advertiser_id)}</td><td>${esc(plan ? plan.name : o.plan_id)}</td><td>${o.starts_at}〜${o.ends_at}</td><td>${esc(o.status)}</td><td>${esc(o.payment_status)}${invLink}</td><td>${pay}</td></tr>`;
  }).join("");
  const stripeBox = tenant.stripe_account_id
    ? `<p>Stripe 接続済み（アカウント: <code>${esc(tenant.stripe_account_id)}</code> / 課金可否: ${tenant.stripe_charges_enabled ? "有効" : "確認中"})</p>`
    : `<form method="post" action="/tenant/stripe/connect"><button>Stripe を接続する（Direct charges）</button></form>
       <p style="font-size:13px;color:#555;">広告主への請求は、あなたの Stripe アカウントから直接行われます（プラットフォームは資金を預かりません）。請求書の発行・メール送信も Stripe から行えます。</p>`;
  return page("テナントコンソール", `
    <h1>テナントコンソール</h1>
    <p>テナント: <strong>${esc(tenant.name)}</strong>（<code>${esc(tid)}</code>）</p>
    ${url.searchParams.get("msg") === "invoice_sent" ? '<p style="background:#dff3e4;padding:8px;">請求書を送信しました。</p>' : ""}
    <h2>Stripe（決済・請求）</h2>${stripeBox}
    <h2>枠</h2>
    <table border="1" cellspacing="0" cellpadding="6" style="border-collapse:collapse;font-size:14px;">
    <tr><th>名前</th><th>ID</th><th>サイズ</th><th></th><th>配信URL</th></tr>${zoneRows || '<tr><td colspan="5">枠がありません</td></tr>'}</table>
    <form method="post" action="/tenant/zones" style="display:grid;gap:6px;max-width:560px;margin-top:12px;">
      <strong>枠の追加</strong>
      <label>名前 <input name="name" style="width:60%"></label>
      <label>幅 <input name="width" type="number" value="300"> 高さ <input name="height" type="number" value="250"></label>
      <label>バックフィルHTML <textarea name="backfill_html" rows="2" style="width:100%"></textarea></label>
      <button>枠を追加</button>
    </form>
    <h2>広告主</h2>
    <p>${advertisers.map(a => esc(a.name)).join("、") || "なし"}</p>
    <form method="post" action="/tenant/advertisers" style="display:grid;gap:6px;max-width:560px;">
      <strong>広告主の追加</strong>
      <label>名前 <input name="name" style="width:60%"></label>
      <label>連絡先メール（請求書の宛先） <input name="contact_email" style="width:60%"></label>
      <button>広告主を追加</button>
    </form>
    <h2>申込</h2>
    <table border="1" cellspacing="0" cellpadding="6" style="border-collapse:collapse;font-size:14px;">
    <tr><th>広告主</th><th>プラン</th><th>期間</th><th>状態</th><th>支払い</th><th></th></tr>${orderRows || '<tr><td colspan="6">申込なし</td></tr>'}</table>
    <form method="post" action="/tenant/orders" style="display:grid;gap:6px;max-width:560px;margin-top:12px;">
      <strong>申込の登録</strong>
      <label>広告主 <select name="advertiser_id">${sel(advertisers, "id", "name")}</select></label>
      <label>プラン <select name="plan_id">${plans.map(p => `<option value="${p.id}">${esc(p.name)}（月${p.price_monthly.toLocaleString()}円）</option>`).join("")}</select></label>
      <label>枠 <select name="zone_id">${sel(myZones, "id", "id")}</select></label>
      <label>開始日 <input name="starts_at" type="date" value="${today()}"> 終了日 <input name="ends_at" type="date" value="${plus30()}"></label>
      <button>申込を登録</button>
    </form>`);
}
