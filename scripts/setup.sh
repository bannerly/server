#!/usr/bin/env bash
# bannerly 初回セットアップ: Cloudflare リソース（D1 / KV / Queue）を作成し、
# wrangler.toml へ ID を反映、スキーマ適用、管理トークン設定、初回デプロイまでを行う。
# 前提: `npx wrangler login` 済みであること。冪等ではないので、初回のみ実行する。
set -euo pipefail
cd "$(dirname "$0")/.."

command -v npx >/dev/null || { echo "Node.js / npx が必要です"; exit 1; }
WR="npx wrangler"

echo "==> D1 データベースを作成します"
$WR d1 create bannerly || true
DB_ID=$($WR d1 list --json 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const a=JSON.parse(s);const db=a.find(x=>x.name==='bannerly');console.log(db?db.uuid:'')})")
[ -n "$DB_ID" ] || { echo "D1 の ID を取得できませんでした。wrangler.toml を手動で確認してください"; exit 1; }

echo "==> KV 名前空間を作成します"
KV_OUT=$($WR kv namespace create SNAP 2>&1 || true)
echo "$KV_OUT"
KV_ID=$(echo "$KV_OUT" | grep -oE 'id = "[a-f0-9]+"' | head -1 | cut -d'"' -f2 || true)

echo "==> Queue を作成します"
$WR queues create ad-events || true

echo "==> wrangler.toml に D1 ID を反映します"
sed -i.bak "s/database_id = \"REPLACE_ME\"/database_id = \"$DB_ID\"/" wrangler.toml
if [ -n "${KV_ID:-}" ]; then
  sed -i.bak "s/id = \"REPLACE_ME\"/id = \"$KV_ID\"/" wrangler.toml
else
  echo "KV の ID は出力から取得できませんでした。wrangler.toml の kv_namespaces の id を手動で設定してください"
fi
rm -f wrangler.toml.bak

echo "==> スキーマを適用します"
$WR d1 execute bannerly --remote --file=schema.sql

echo "==> 管理トークン（ADMIN_TOKEN）を設定します"
$WR secret put ADMIN_TOKEN

if [ -n "${STRIPE_SECRET_KEY:-}" ]; then
  echo "==> Stripe シークレットを設定します"
  printf '%s' "$STRIPE_SECRET_KEY" | $WR secret put STRIPE_SECRET_KEY
fi
if [ -n "${STRIPE_WEBHOOK_SECRET:-}" ]; then
  printf '%s' "$STRIPE_WEBHOOK_SECRET" | $WR secret put STRIPE_WEBHOOK_SECRET
fi

echo "==> デプロイします"
$WR deploy
echo "完了。/admin が管理画面、/signup がテナント登録、/tenant がテナントコンソールです。"
echo "Stripe Webhook は https://<your-domain>/stripe/webhook をエンドポイントに登録してください（checkout.session.completed / invoice.paid / invoice.payment_failed / account.updated）。"
