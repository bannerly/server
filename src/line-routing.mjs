// LINE メッセージルーティング / 統合受信箱。
// 設計: ~/workspace/ad-server/LINE計測設計.md（メッセージルーティング／統合受信箱）
// - ポータルの公式アカウントに届いたメッセージを、ルールで担当キューへ「割り当てる」。
//   LINE の 1 対 1 チャットは公式アカウント内でしか完結しないため、個人 LINE への転送は行わない。
// - 振り分け軸: 帰属キャンペーン / エリア（帰属キャンペーンの配信地域）/ 時間帯（JST）/ キーワード / 担当キューの対応可否。
// - 保存は必要最小限: チャネル単位の仮名ユーザー ID、テキスト本文（受信箱の表示と返信に必要な範囲）、割当て結果。
//   テキスト以外のメッセージは種別だけを記録し、内容は保存しない。プロフィール情報は取得しない。
import { jstParts, hourInRanges } from "./deliver.mjs";

const lower = s => String(s || "").toLowerCase();

// ルール評価（純関数）。rules は優先度（priority 昇順、同順位は作成順）で評価し、
// 条件がすべて一致し、かつ割当先キューが対応可（available）の最初のルールを採用する。
// どのルールにも一致しない場合はフォールバック: 対応可のキューのうちエリアが一致するもの、
// なければ最も古い対応可キュー。それも無ければ "" （未割当）。
export function pickLineQueue(rules, queues, ctx) {
  const byId = new Map((queues || []).map(q => [q.id, q]));
  const areas = (ctx.areas || []).map(lower);
  const sorted = [...(rules || [])]
    .filter(r => r.active)
    .sort((a, b) => (a.priority || 100) - (b.priority || 100) || (a.created_at || 0) - (b.created_at || 0));
  for (const r of sorted) {
    const q = byId.get(r.queue_id);
    if (!q || !q.available) continue;
    if (r.campaign_id && r.campaign_id !== (ctx.campaignId || "")) continue;
    if (r.area && !areas.includes(lower(r.area))) continue;
    if (r.hours && !hourInRanges(ctx.hour, r.hours)) continue;
    if (r.keywords) {
      const kws = String(r.keywords).split(",").map(s => s.trim()).filter(Boolean);
      if (kws.length && !kws.some(k => String(ctx.text || "").includes(k))) continue;
    }
    return q.id;
  }
  const avail = [...(queues || [])].filter(q => q.available).sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
  if (!avail.length) return "";
  const areaHit = avail.find(q => q.area && areas.includes(lower(q.area)));
  return (areaHit || avail[0]).id;
}

// Webhook の message イベントを受信箱へ取り込む（スレッド作成/更新・ルーティング割当て・本文保存）。
// 戻り値は取り込んだ件数。follow/unfollow 等は計測側（line.mjs）が従来どおり件数だけ記録する。
export async function ingestLineWebhookMessages(repo, tenant, body, newId) {
  const events = Array.isArray(body && body.events) ? body.events : [];
  let ingested = 0;
  for (const ev of events) {
    if (ev.type !== "message") continue;
    const userId = ev.source && ev.source.userId;
    if (!userId) continue;
    const ts = ev.timestamp || Date.now();
    const msg = ev.message || {};
    const isText = msg.type === "text";
    const text = isText ? String(msg.text || "") : "";
    const attr = await repo.getLineAttribution(tenant.id, userId);
    const campaignId = (attr && attr.campaign_id) || "";
    let thread = await repo.getLineThreadByUser(tenant.id, userId);
    if (!thread) {
      thread = await repo.createLineThread({
        id: newId("th"), tenant_id: tenant.id, line_user_id: userId,
        queue_id: "", status: "open", campaign_id: campaignId, created_at: ts, updated_at: ts,
      });
    }
    const patch = { updated_at: ts };
    if (campaignId && campaignId !== thread.campaign_id) patch.campaign_id = campaignId;
    if (thread.status === "open") {
      const [rules, queues] = await Promise.all([repo.listLineRouteRules(tenant.id), repo.listLineQueues(tenant.id)]);
      const current = queues.find(q => q.id === thread.queue_id);
      if (!thread.queue_id || !current || !current.available) {
        const effectiveCampaign = campaignId || thread.campaign_id || "";
        const campaign = effectiveCampaign ? await repo.getCampaign(effectiveCampaign) : null;
        const areas = campaign ? [...(campaign.regions || []), ...(campaign.cities || [])] : [];
        patch.queue_id = pickLineQueue(rules, queues, { campaignId: effectiveCampaign, areas, hour: jstParts(ts).hour, text });
      }
    }
    await repo.updateLineThread(thread.id, patch);
    await repo.createLineMessage({
      id: newId("lm"), thread_id: thread.id, tenant_id: tenant.id, direction: "in",
      msg_type: msg.type || "", body: text, ts, created_at: Date.now(),
    });
    ingested++;
  }
  return ingested;
}

// LINE Messaging API（Push）で公式アカウントとして返信する。返信は会話への応答のため配信課金対象外。
// apiBase はローカル検証用のモック差し替え口（通常は https://api.line.me）。
export async function sendLinePush(accessToken, userId, text, { apiBase = "https://api.line.me", fetchImpl } = {}) {
  if (!accessToken) throw new Error("LINE チャネルアクセストークンが未設定です（テナントコンソールの LINE 設定）");
  const doFetch = fetchImpl || fetch;
  const res = await doFetch(`${apiBase}/v2/bot/message/push`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ to: userId, messages: [{ type: "text", text: String(text).slice(0, 5000) }] }),
  });
  if (!res.ok) {
    let detail = "";
    try { detail = (await res.text()).slice(0, 200); } catch { /* 詳細が取れなくても失敗として扱う */ }
    throw new Error(`LINE 送信に失敗しました (HTTP ${res.status}) ${detail}`);
  }
  return true;
}

// 受信箱からスレッドへ返信し、送信メッセージをスレッドに記録する。
export async function sendLineReply(repo, tenant, thread, text, newId, env = {}) {
  await sendLinePush(tenant.line_access_token, thread.line_user_id, text, { apiBase: env.LINE_API_BASE_URL || undefined });
  const now = Date.now();
  const m = await repo.createLineMessage({
    id: newId("lm"), thread_id: thread.id, tenant_id: tenant.id, direction: "out",
    msg_type: "text", body: String(text), ts: now, created_at: now,
  });
  await repo.updateLineThread(thread.id, { updated_at: now });
  return m;
}
