// Stripe Connect（Direct charges）連携。SDK を使わず fetch + form-encoded で Stripe API を叩く。
// 資金はプラットフォームを経由しない: 課金はテナントの接続アカウント上で直接行い（Direct charges）、
// プラットフォーム手数料は application_fee_amount としてのみ差し引く。
// 請求書（Stripe Invoicing）も接続アカウント名義で発行され、Stripe が顧客へメール送信する。

export function stripeConfig(env) {
  return {
    secretKey: env.STRIPE_SECRET_KEY || "",
    webhookSecret: env.STRIPE_WEBHOOK_SECRET || "",
    feeBps: parseInt(env.PLATFORM_FEE_BPS || "0", 10) || 0, // 100 = 1%
    baseUrl: (env.PUBLIC_BASE_URL || "").replace(/\/$/, ""),
  };
}
export const stripeEnabled = env => !!stripeConfig(env).secretKey;
export const applicationFee = (amount, feeBps) => Math.floor(amount * feeBps / 10000);

function encodeForm(obj, prefix, out) {
  out = out || new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((item, i) => encodeForm(item && typeof item === "object" ? item : { "": item }, `${key}[${i}]`, out));
    else if (typeof v === "object") encodeForm(v, key, out);
    else out.append(key, String(v));
  }
  return out;
}

export async function stripeReq(env, path, params = {}, connectedAccount = null) {
  const cfg = stripeConfig(env);
  if (!cfg.secretKey) throw new Error("STRIPE_SECRET_KEY が未設定です");
  const headers = { authorization: `Bearer ${cfg.secretKey}`, "content-type": "application/x-www-form-urlencoded" };
  if (connectedAccount) headers["stripe-account"] = connectedAccount;
  const res = await fetch(`https://api.stripe.com${path}`, {
    method: params ? "POST" : "GET", headers,
    body: params ? encodeForm(params).toString() : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Stripe API ${path}: ${(data.error && data.error.message) || res.status}`);
  return data;
}

// テナントの Connect アカウント作成 + オンボーディングリンク発行
// 種別は STRIPE_ACCOUNT_TYPE（standard | express、既定 standard）。
// standard はテナント自身の Stripe アカウントをそのまま使う形で、請求書の名義・
// 適格請求書の登録番号・振込先などはアカウント側の設定がそのまま効く。
export async function createConnectAccount(env, tenant, email) {
  const type = (env.STRIPE_ACCOUNT_TYPE || "standard").toLowerCase() === "express" ? "express" : "standard";
  const params = { type, email: email || undefined, country: "JP", metadata: { tenant_id: tenant.id } };
  if (type === "express") {
    params.capabilities = { card_payments: { requested: true }, transfers: { requested: true } };
    params.business_type = "company";
  }
  return stripeReq(env, "/v1/accounts", params);
}
export async function createAccountLink(env, accountId) {
  const cfg = stripeConfig(env);
  return stripeReq(env, "/v1/account_links", {
    account: accountId, type: "account_onboarding",
    refresh_url: `${cfg.baseUrl}/tenant?stripe=refresh`,
    return_url: `${cfg.baseUrl}/tenant?stripe=done`,
  });
}

// Direct charge: 接続アカウント上での Checkout セッション（申込の支払い）
export async function createOrderCheckout(env, tenant, order, plan, advertiser) {
  const cfg = stripeConfig(env);
  if (!tenant.stripe_account_id) throw new Error("テナントの Stripe 接続が未完了です");
  const amount = plan.price_monthly;
  const session = await stripeReq(env, "/v1/checkout/sessions", {
    mode: "payment",
    success_url: `${cfg.baseUrl}/tenant?paid=1`,
    cancel_url: `${cfg.baseUrl}/tenant?paid=0`,
    line_items: [{ quantity: 1, price_data: { currency: "jpy", unit_amount: amount, product_data: { name: `bannerly ${plan.name}（月額）` } } }],
    payment_intent_data: { application_fee_amount: applicationFee(amount, cfg.feeBps) || undefined },
    metadata: { order_id: order.id, tenant_id: tenant.id },
  }, tenant.stripe_account_id);
  return session;
}

// 請求書: 接続アカウント名義で作成し、Stripe から顧客へメール送信する（send_invoice）
export async function sendOrderInvoice(env, tenant, order, plan, advertiser) {
  if (!tenant.stripe_account_id) throw new Error("テナントの Stripe 接続が未完了です");
  const acct = tenant.stripe_account_id;
  const customer = await stripeReq(env, "/v1/customers", {
    name: advertiser ? advertiser.name : "広告主",
    email: (advertiser && advertiser.contact_email) || undefined,
    metadata: { advertiser_id: order.advertiser_id, tenant_id: tenant.id },
  }, acct);
  await stripeReq(env, "/v1/invoiceitems", {
    customer: customer.id, amount: plan.price_monthly, currency: "jpy",
    description: `bannerly ${plan.name}（月額） ${order.starts_at}〜${order.ends_at}`,
  }, acct);
  const cfg = stripeConfig(env);
  const invoice = await stripeReq(env, "/v1/invoices", {
    customer: customer.id, collection_method: "send_invoice", days_until_due: 30,
    application_fee_amount: applicationFee(plan.price_monthly, cfg.feeBps) || undefined,
    metadata: { order_id: order.id, tenant_id: tenant.id },
  }, acct);
  await stripeReq(env, `/v1/invoices/${invoice.id}/finalize`, {}, acct);
  const sent = await stripeReq(env, `/v1/invoices/${invoice.id}/send`, {}, acct);
  return sent; // hosted_invoice_url を含む
}

// Webhook 署名検証（Stripe-Signature: t=...,v1=... / HMAC-SHA256）
export async function verifyWebhook(env, rawBody, sigHeader) {
  const secret = stripeConfig(env).webhookSecret;
  if (!secret) return false;
  const parts = Object.fromEntries(String(sigHeader || "").split(",").map(p => p.split("=").map(s => s.trim())));
  if (!parts.t || !parts.v1) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(`${parts.t}.${rawBody}`));
  const hex = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
  if (hex.length !== parts.v1.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ parts.v1.charCodeAt(i);
  return diff === 0;
}
