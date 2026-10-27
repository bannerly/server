// LINE 連携: Webhook（友だち追加など）の受信と、LIFF 到達（line_open）の記録。
// 設計: ~/workspace/ad-server/LINE計測設計.md（LIFF 方式）
// - Webhook はテナントごとのチャネルシークレットで署名検証する（x-line-signature = Base64(HMAC-SHA256(secret, body))）
// - イベントは「件数だけ」を記録する。メッセージ本文やユーザー ID は保存しない
// - line_open は /click で付けた帰属パラメータ（campaign）を LIFF 側がそのまま渡す前提

export async function verifyLineSignature(channelSecret, rawBody, signature) {
  if (!channelSecret || !signature) return false;
  try {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(channelSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
    const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));
    if (expected.length !== String(signature).length) return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ String(signature).charCodeAt(i);
    return diff === 0;
  } catch { return false; }
}

const KIND_BY_EVENT = { follow: "line_follow", unfollow: "line_unfollow", message: "line_message" };

// Webhook イベントを集計用イベントとして記録する。戻り値は記録した件数。
export async function recordLineWebhookEvents(repo, tenant, body, newId) {
  const events = Array.isArray(body && body.events) ? body.events : [];
  let recorded = 0;
  for (const ev of events) {
    const kind = KIND_BY_EVENT[ev.type];
    if (!kind) continue;
    await repo.insertEvent({ id: newId("ev"), ts: ev.timestamp || Date.now(), kind, tenant_id: tenant.id, zone_id: "", campaign_id: "", banner_id: "" });
    recorded++;
  }
  return recorded;
}

// LIFF 起動（ポータル画面への実到達）をコンバージョンとして記録する。
export async function recordLineOpen(repo, campaignId, newId) {
  if (!campaignId) return null;
  const campaign = await repo.getCampaign(campaignId);
  if (!campaign) return null;
  const ev = { id: newId("ev"), ts: Date.now(), kind: "line_open", tenant_id: campaign.tenant_id, zone_id: campaign.zone_id, campaign_id: campaign.id, banner_id: "" };
  await repo.insertEvent(ev);
  return ev;
}

// /click の遷移先が LIFF URL のとき、帰属パラメータを付ける
export function withLineAttribution(dest, { campaign_id, tenant_id }) {
  try {
    const u = new URL(dest);
    if (u.hostname !== "liff.line.me") return dest;
    if (!u.searchParams.has("bn_campaign")) u.searchParams.set("bn_campaign", campaign_id);
    if (!u.searchParams.has("bn_tenant")) u.searchParams.set("bn_tenant", tenant_id);
    return u.toString();
  } catch { return dest; }
}
