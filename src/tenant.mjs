// セルフテナント登録と、テナント専用コンソール。
// 登録すると tenant + tenant_admin ユーザーが作られ、管理トークンが一度だけ表示される。
// トークンは SHA-256 ハッシュで保存し、コンソールは自テナントのデータだけを表示・操作できる。
import { esc } from "./admin.mjs";
import { today } from "./deliver.mjs";
import { stripeEnabled, createConnectAccount, createAccountLink, createOrderCheckout, sendOrderInvoice, createConnectWebhookEndpoint } from "./stripe.mjs";
import { sendLineReply } from "./line-routing.mjs";

const RESERVED = new Set(["admin", "signup", "tenant", "ad", "tag", "imp", "click", "demo", "stripe", "api", "line"]);
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

export async function handleSignup(req, url, repo, newId, env = {}) {
  // セルフホスト型: 登録は「最初の管理者を作るまで」だけ開く（ブートストラップ）。
  // 常時開放したい場合のみ ALLOW_OPEN_SIGNUP=1 を設定する（中央集約型 SaaS 用途）。
  const users = await repo.listUsers();
  if (env.ALLOW_OPEN_SIGNUP !== "1" && users.length > 0) {
    return page("登録は終了しています", `
      <h1>登録は終了しています</h1>
      <p>bannerly は、運用者が各自の Cloudflare にデプロイするセルフホスト型です。このデプロイでは新規テナント登録を受け付けていません。</p>
      <p>運用者は <a href="/tenant">テナントコンソール</a> または <a href="/admin">管理画面</a> を使ってください。</p>`);
  }
  if (req.method === "GET") {
    return page("テナント登録", `
      <h1>bannerly テナント登録</h1>
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
    if (parts[1] === "stripe" && parts[2] === "webhook") {
      if (!stripeEnabled(env)) return new Response("Stripe が未設定です（STRIPE_SECRET_KEY）", { status: 501 });
      try {
        const ep = await createConnectWebhookEndpoint(env);
        return page("Webhook 作成完了", `
          <h1>Webhook エンドポイントを作成しました</h1>
          <p>エンドポイント ID: <code>${esc(ep.id)}</code><br>URL: <code>${esc(ep.url)}</code></p>
          <p>署名シークレット（<strong>この画面でだけ表示されます</strong>）:</p>
          <p style="font-size:16px;background:#f4f4f4;padding:12px;"><code>${esc(ep.secret || "")}</code></p>
          <p>これをデプロイ側の <code>STRIPE_WEBHOOK_SECRET</code> に設定してください（Cloudflare: <code>wrangler secret put STRIPE_WEBHOOK_SECRET</code>）。設定するまで Webhook による支払い反映は動きません。</p>
          <p><a href="/tenant">コンソールへ戻る</a></p>`);
      } catch (e) { return new Response(`Stripe エラー: ${esc(e.message)}`, { status: 502 }); }
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
    if (parts[1] === "line" && parts[2] === "settings") {
      const patch = { line_channel_id: g("line_channel_id") || "" };
      if (g("line_channel_secret")) patch.line_channel_secret = g("line_channel_secret");
      if (g("line_access_token")) patch.line_access_token = g("line_access_token");
      await repo.updateTenant(tid, patch);
      return redirect("/tenant");
    }
    if (parts[1] === "line" && parts[2] === "queues" && !parts[3]) {
      await repo.createLineQueue({ id: newId("q"), tenant_id: tid, name: g("name") || "無名キュー", advertiser_id: g("advertiser_id") || "", area: g("area") || "", available: g("available") !== "0", created_at: Date.now() });
      return redirect("/tenant/line/queues");
    }
    if (parts[1] === "line" && parts[2] === "queues" && parts[3] && parts[4] === "update") {
      const q = await repo.getLineQueue(parts[3]);
      if (!q || q.tenant_id !== tid) return new Response("unknown queue", { status: 404 });
      await repo.updateLineQueue(q.id, { name: g("name") || q.name, advertiser_id: g("advertiser_id") || "", area: g("area") || "", available: g("available") !== "0" });
      return redirect("/tenant/line/queues");
    }
    if (parts[1] === "line" && parts[2] === "rules" && !parts[3]) {
      const q = await repo.getLineQueue(g("queue_id") || "");
      if (!q || q.tenant_id !== tid) return new Response("unknown queue", { status: 400 });
      await repo.createLineRouteRule({ id: newId("lr"), tenant_id: tid, queue_id: q.id, priority: parseInt(g("priority") || "100", 10) || 100, campaign_id: g("campaign_id") || "", area: g("area") || "", hours: g("hours") || "", keywords: g("keywords") || "", active: true, created_at: Date.now() });
      return redirect("/tenant/line/queues");
    }
    if (parts[1] === "line" && parts[2] === "rules" && parts[3] && parts[4] === "delete") {
      const rules = await repo.listLineRouteRules(tid);
      if (rules.some(r => r.id === parts[3])) await repo.deleteLineRouteRule(parts[3]);
      return redirect("/tenant/line/queues");
    }
    if (parts[1] === "line" && parts[2] === "threads" && parts[3]) {
      const th = await repo.getLineThread(parts[3]);
      if (!th || th.tenant_id !== tid) return new Response("unknown thread", { status: 404 });
      if (parts[4] === "reply") {
        const text = String(g("text") || "").trim();
        if (!text) return redirect(`/tenant/line/threads/${th.id}`);
        try {
          await sendLineReply(repo, tenant, th, text, newId, env);
        } catch (e) {
          return page("送信エラー", `<h1>返信を送信できませんでした</h1><p>${esc(e.message)}</p><p><a href="/tenant/line/threads/${th.id}">スレッドへ戻る</a></p>`);
        }
        return redirect(`/tenant/line/threads/${th.id}`);
      }
      if (parts[4] === "assign") {
        const qid = g("queue_id") || "";
        if (qid) { const q = await repo.getLineQueue(qid); if (!q || q.tenant_id !== tid) return new Response("unknown queue", { status: 400 }); }
        await repo.updateLineThread(th.id, { queue_id: qid, updated_at: Date.now() });
        return redirect(`/tenant/line/threads/${th.id}`);
      }
      if (parts[4] === "status") {
        await repo.updateLineThread(th.id, { status: th.status === "open" ? "closed" : "open", updated_at: Date.now() });
        return redirect(`/tenant/line/threads/${th.id}`);
      }
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

  // --- LINE 受信箱 / キュー・ルール管理（サブページ） ---
  const fmtTs = ts => new Date(ts || 0).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  if (parts[1] === "line" && parts[2] === "inbox") {
    const [threads, queues, camps] = await Promise.all([repo.listLineThreads(tid), repo.listLineQueues(tid), repo.listCampaigns()]);
    const qName = id => { const q = queues.find(x => x.id === id); return q ? q.name : (id ? "(削除済みキュー)" : "未割当"); };
    const cName = id => { const c = camps.find(x => x.id === id && x.tenant_id === tid); return c ? c.name : ""; };
    const qFilter = url.searchParams.get("queue") || "";
    const sFilter = url.searchParams.get("status") || "";
    const shown = threads.filter(t => {
      if (qFilter === "__none" && t.queue_id) return false;
      if (qFilter && qFilter !== "__none" && t.queue_id !== qFilter) return false;
      if (sFilter && t.status !== sFilter) return false;
      return true;
    });
    const rows = [];
    for (const t of shown) {
      const msgs = await repo.listLineMessages(t.id);
      const last = msgs[msgs.length - 1];
      const preview = last ? (last.direction === "out" ? "↪ " : "") + (last.body || `（${last.msg_type || "その他"}）`) : "";
      rows.push(`<tr><td>${fmtTs(t.updated_at)}</td><td><code>${esc(t.line_user_id.slice(0, 12))}…</code></td><td>${esc(qName(t.queue_id))}</td><td>${t.status === "open" ? "対応中" : "完了"}</td><td>${esc(cName(t.campaign_id))}</td><td style="max-width:360px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(preview)}</td><td><a href="/tenant/line/threads/${t.id}">開く</a></td></tr>`);
    }
    const qOpts = [`<option value="">すべて</option>`, `<option value="__none" ${qFilter === "__none" ? "selected" : ""}>未割当</option>`, ...queues.map(q => `<option value="${q.id}" ${qFilter === q.id ? "selected" : ""}>${esc(q.name)}</option>`)].join("");
    const bodyRows = rows;
    return page("LINE 受信箱", `
      <h1>LINE 受信箱</h1>
      <p>テナント: <strong>${esc(tenant.name)}</strong> / <a href="/tenant">コンソール</a> / <a href="/tenant/line/queues">キュー・ルール設定</a></p>
      <p style="font-size:13px;color:#555;">公式アカウントに届いたメッセージは、ルールで担当キューに割り当てられます。返信はこの受信箱から、公式アカウントとして送信されます（店舗の個人 LINE へは転送されません）。</p>
      <form method="get" action="/tenant/line/inbox" style="display:flex;gap:12px;align-items:end;flex-wrap:wrap;">
        <label>キュー <select name="queue">${qOpts}</select></label>
        <label>状態 <select name="status"><option value="">すべて</option><option value="open" ${sFilter === "open" ? "selected" : ""}>対応中</option><option value="closed" ${sFilter === "closed" ? "selected" : ""}>完了</option></select></label>
        <button>絞り込む</button>
      </form>
      <table border="1" cellspacing="0" cellpadding="6" style="border-collapse:collapse;font-size:14px;margin-top:12px;">
      <tr><th>最終更新</th><th>ユーザー</th><th>担当キュー</th><th>状態</th><th>帰属</th><th>最終メッセージ</th><th></th></tr>${bodyRows.join("") || '<tr><td colspan="7">スレッドがありません</td></tr>'}</table>`);
  }
  if (parts[1] === "line" && parts[2] === "threads" && parts[3]) {
    const th = await repo.getLineThread(parts[3]);
    if (!th || th.tenant_id !== tid) return new Response("unknown thread", { status: 404 });
    const [msgs, queues] = await Promise.all([repo.listLineMessages(th.id), repo.listLineQueues(tid)]);
    const bubbles = msgs.map(m => m.direction === "out"
      ? `<div style="text-align:right;margin:6px 0;"><span style="display:inline-block;background:#dff3e4;border-radius:10px;padding:8px 10px;max-width:75%;text-align:left;white-space:pre-wrap;">${esc(m.body || `（${m.msg_type}）`)}</span><div style="font-size:11px;color:#888;">${fmtTs(m.ts)} 送信</div></div>`
      : `<div style="margin:6px 0;"><span style="display:inline-block;background:#f0f0f0;border-radius:10px;padding:8px 10px;max-width:75%;white-space:pre-wrap;">${esc(m.body || `（${m.msg_type || "その他"}: 内容は保存されません）`)}</span><div style="font-size:11px;color:#888;">${fmtTs(m.ts)} 受信</div></div>`).join("");
    const qOpts = [`<option value="">未割当</option>`, ...queues.map(q => `<option value="${q.id}" ${th.queue_id === q.id ? "selected" : ""}>${esc(q.name)}${q.available ? "" : "（停止中）"}</option>`)].join("");
    const curQ = queues.find(q => q.id === th.queue_id);
    return page("LINE スレッド", `
      <h1>スレッド</h1>
      <p><a href="/tenant/line/inbox">受信箱へ戻る</a></p>
      <p style="font-size:13px;">ユーザー: <code>${esc(th.line_user_id)}</code>（チャネル単位の仮名 ID）<br>
      担当キュー: <strong>${esc(curQ ? curQ.name : "未割当")}</strong> / 状態: ${th.status === "open" ? "対応中" : "完了"}${th.campaign_id ? `<br>帰属キャンペーン: <code>${esc(th.campaign_id)}</code>` : ""}</p>
      <div style="border:1px solid #ddd;border-radius:8px;padding:12px;background:#fff;">${bubbles || '<p style="color:#888;">メッセージがありません</p>'}</div>
      <form method="post" action="/tenant/line/threads/${th.id}/reply" style="display:grid;gap:6px;margin-top:12px;">
        <strong>返信する（公式アカウントとして送信）</strong>
        <textarea name="text" rows="3" required style="width:100%"></textarea>
        <button>送信</button>
      </form>
      <div style="display:flex;gap:16px;margin-top:16px;flex-wrap:wrap;">
        <form method="post" action="/tenant/line/threads/${th.id}/assign" style="display:flex;gap:6px;align-items:center;">
          <label>担当キュー <select name="queue_id">${qOpts}</select></label><button>割り当てる</button>
        </form>
        <form method="post" action="/tenant/line/threads/${th.id}/status">
          <button>${th.status === "open" ? "対応を完了にする" : "対応中に戻す"}</button>
        </form>
      </div>`);
  }
  if (parts[1] === "line" && parts[2] === "queues") {
    const [queues, rules, camps, advs] = await Promise.all([repo.listLineQueues(tid), repo.listLineRouteRules(tid), repo.listCampaigns(), repo.listAdvertisers(tid)]);
    const myCamps = camps.filter(c => c.tenant_id === tid);
    const advName = id => { const a = advs.find(x => x.id === id); return a ? a.name : ""; };
    const campName = id => { const c = myCamps.find(x => x.id === id); return c ? c.name : id; };
    const qRows = queues.map(q => `
      <tr><td>${esc(q.name)}</td><td>${esc(advName(q.advertiser_id))}</td><td>${esc(q.area)}</td><td>${q.available ? "対応可" : "停止中"}</td>
      <td><form method="post" action="/tenant/line/queues/${q.id}/update" style="display:flex;gap:4px;flex-wrap:wrap;">
        <input name="name" value="${esc(q.name)}" size="12"><input name="area" value="${esc(q.area)}" size="10" placeholder="エリア">
        <select name="advertiser_id"><option value="">（店舗なし）</option>${advs.map(a => `<option value="${a.id}" ${q.advertiser_id === a.id ? "selected" : ""}>${esc(a.name)}</option>`).join("")}</select>
        <select name="available"><option value="1" ${q.available ? "selected" : ""}>対応可</option><option value="0" ${q.available ? "" : "selected"}>停止</option></select>
        <button>更新</button></form></td></tr>`).join("");
    const qOpts = queues.map(q => `<option value="${q.id}">${esc(q.name)}</option>`).join("");
    const rRows = rules.map(r => {
      const q = queues.find(x => x.id === r.queue_id);
      const cond = [r.campaign_id ? `帰属:${esc(campName(r.campaign_id))}` : null, r.area ? `エリア:${esc(r.area)}` : null, r.hours ? `時間帯:${esc(r.hours)}` : null, r.keywords ? `KW:${esc(r.keywords)}` : null].filter(Boolean).join(" / ") || "（条件なし）";
      return `<tr><td>${r.priority}</td><td>${esc(q ? q.name : "(削除済み)")}</td><td>${cond}</td><td>${r.active ? "有効" : "無効"}</td>
      <td><form method="post" action="/tenant/line/rules/${r.id}/delete"><button>削除</button></form></td></tr>`;
    }).join("");
    return page("LINE キュー・ルール設定", `
      <h1>LINE キュー・ルール設定</h1>
      <p>テナント: <strong>${esc(tenant.name)}</strong> / <a href="/tenant">コンソール</a> / <a href="/tenant/line/inbox">受信箱</a></p>
      <h2>担当キュー</h2>
      <table border="1" cellspacing="0" cellpadding="6" style="border-collapse:collapse;font-size:14px;">
      <tr><th>名前</th><th>店舗・事業者</th><th>エリア</th><th>対応可否</th><th>編集</th></tr>${qRows || '<tr><td colspan="5">キューがありません</td></tr>'}</table>
      <form method="post" action="/tenant/line/queues" style="display:grid;gap:6px;max-width:560px;margin-top:12px;">
        <strong>キューの追加</strong>
        <label>名前 <input name="name" style="width:60%"></label>
        <label>店舗・事業者 <select name="advertiser_id"><option value="">（なし）</option>${advs.map(a => `<option value="${a.id}">${esc(a.name)}</option>`).join("")}</select></label>
        <label>エリア <input name="area" placeholder="例: 横浜市（帰属キャンペーンの地域と照合）" style="width:60%"></label>
        <label>対応可否 <select name="available"><option value="1">対応可</option><option value="0">停止</option></select></label>
        <button>キューを追加</button>
      </form>
      <h2>振り分けルール</h2>
      <p style="font-size:13px;color:#555;">優先度が小さい順に評価し、条件がすべて一致して割当先が「対応可」の最初のルールを採用します。どれにも一致しない場合は、エリアが一致する対応可キュー→最も古い対応可キューの順に割り当てます。エリアは「帰属キャンペーンの配信地域（都道府県・市区町村）」と照合します。時間帯は JST で <code>9-18,22-24</code> 形式、キーワードはカンマ区切り（いずれか含めば一致）です。</p>
      <table border="1" cellspacing="0" cellpadding="6" style="border-collapse:collapse;font-size:14px;">
      <tr><th>優先度</th><th>割当先</th><th>条件</th><th>状態</th><th></th></tr>${rRows || '<tr><td colspan="5">ルールがありません</td></tr>'}</table>
      <form method="post" action="/tenant/line/rules" style="display:grid;gap:6px;max-width:560px;margin-top:12px;">
        <strong>ルールの追加</strong>
        <label>優先度 <input name="priority" type="number" value="100" style="width:80px"></label>
        <label>割当先キュー <select name="queue_id">${qOpts}</select></label>
        <label>帰属キャンペーン <select name="campaign_id"><option value="">（指定なし）</option>${myCamps.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join("")}</select></label>
        <label>エリア <input name="area" placeholder="例: 神奈川県 / 横浜市" style="width:60%"></label>
        <label>時間帯 <input name="hours" placeholder="例: 9-18,22-24" style="width:60%"></label>
        <label>キーワード <input name="keywords" placeholder="例: 予約,料金" style="width:60%"></label>
        <button>ルールを追加</button>
      </form>`);
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
    ? `<p>Stripe 接続済み（アカウント: <code>${esc(tenant.stripe_account_id)}</code> / 課金可否: ${tenant.stripe_charges_enabled ? "有効" : "確認中"})</p>
       <form method="post" action="/tenant/stripe/webhook"><button>Webhook エンドポイントを自動作成</button></form>
       <p style="font-size:13px;color:#555;">支払い・請求書・接続状態の自動反映に必要です。作成時に表示される署名シークレットを <code>STRIPE_WEBHOOK_SECRET</code> に設定してください。</p>`
    : `<form method="post" action="/tenant/stripe/connect"><button>Stripe を接続する（Direct charges）</button></form>
       <p style="font-size:13px;color:#555;">広告主への請求は、あなたの Stripe アカウントから直接行われます（プラットフォームは資金を預かりません）。請求書の発行・メール送信も Stripe から行えます。</p>`;
  const lineBox = `
    <p style="font-size:13px;">チャネル: ${tenant.line_channel_id ? `<code>${esc(tenant.line_channel_id)}</code>` : "未設定"} / シークレット: ${tenant.line_channel_secret ? "設定済み" : "未設定"} / トークン: ${tenant.line_access_token ? "設定済み" : "未設定"}</p>
    <p style="font-size:13px;color:#555;">Webhook URL: <code>${esc(env.PUBLIC_BASE_URL || "")}/line/webhook/${esc(tid)}</code>（LINE Developers の Webhook URL に設定してください）</p>
    <form method="post" action="/tenant/line/settings" style="display:grid;gap:6px;max-width:560px;">
      <label>チャネル ID <input name="line_channel_id" value="${esc(tenant.line_channel_id || "")}" style="width:60%"></label>
      <label>チャネルシークレット <input name="line_channel_secret" type="password" placeholder="${tenant.line_channel_secret ? "設定済み（変更時のみ入力）" : ""}" style="width:60%"></label>
      <label>チャネルアクセストークン <input name="line_access_token" type="password" placeholder="${tenant.line_access_token ? "設定済み（変更時のみ入力）" : ""}" style="width:60%"></label>
      <button>LINE 設定を保存</button>
    </form>
    <p style="font-size:13px;color:#555;">友だち追加などのイベントは件数だけを記録します。受信したメッセージは<a href="/tenant/line/inbox">受信箱</a>のスレッドとして保存され、<a href="/tenant/line/queues">キュー・ルール設定</a>のルールで担当へ割り当てられます（保存は仮名ユーザー ID とテキスト本文のみ。プロフィールは取得しません）。返信は受信箱から公式アカウントとして送信します。LIFF の到達計測は、ポータル画面から <code>/line/open?c=&lt;キャンペーンID&gt;</code> を呼ぶ形で、<code>u=&lt;仮名ユーザーID&gt;</code> を付けると以降のメッセージの帰属に使われます。</p>
    <p><a href="/tenant/line/inbox">LINE 受信箱を開く</a> / <a href="/tenant/line/queues">キュー・ルール設定</a></p>`;
  return page("テナントコンソール", `
    <h1>テナントコンソール</h1>
    <p>テナント: <strong>${esc(tenant.name)}</strong>（<code>${esc(tid)}</code>）</p>
    ${url.searchParams.get("msg") === "invoice_sent" ? '<p style="background:#dff3e4;padding:8px;">請求書を送信しました。</p>' : ""}
    <h2>Stripe（決済・請求）</h2>${stripeBox}
    <h2>LINE（計測・連携）</h2>${lineBox}
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
