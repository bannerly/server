# Slotly

スタートアップや小規模サービスのための、軽量なマルチテナント広告配信サーバー。

自社の Web サイトやアプリに広告枠を持ち、提携先への直接販売と、空き枠のバックフィル（Google Ad Manager など）を、ひとつの管理画面で運用できます。配信モデルは Revive Adserver 型（枠 × キャンペーン種別 × 優先度）で、動作基盤は Cloudflare Workers（D1 / KV / Queues）です。基盤側が広告費の資金を預かることはありません。

## 特徴

- **マルチテナント** — テナントごとに枠・広告主・集計が分離され、各テナントが自分のサイト/アプリに枠を埋め込めます
- **配信ルール** — 優先度（Override / Contract / Remnant）、重み付け、地域、曜日・時間帯、日次上限、フリークエンシーキャップ、目標インプレッション
- **クリエイティブ2形式** — HTML（Web 向け）と構造化形式（画像 URL + タイトル + 本文。アプリでネイティブ描画できます）
- **審査フロー** — バナーは承認されるまで配信されません
- **販売フロー** — プランと申込を管理し、承認すると契約キャンペーンを自動生成します
- **レポート** — 期間指定レポート（CSV 対応）と、広告主ごとの月次レポート（総表示回数 / キャンペーン別内訳 / 日別）
- **アプリ SDK** — Expo / React Native 用コンポーネントを別リポジトリ（slotly-sdk）で提供
- **バックフィル** — 枠ごとに外部タグを設定でき、直接販売のない枠・時間帯を埋められます
- **セルフテナント登録** — `/signup` からテナントが自分で登録でき、テナント専用コンソール（`/tenant`）で自テナントだけを管理できます
- **Stripe Connect（Direct charges）** — テナントは自分の Stripe アカウントを接続し、広告主への課金を自社アカウントで直接受けられます。Checkout 支払いリンクと、Stripe から送られる請求書（インボイス）に対応します。プラットフォームは資金を預かりません（手数料は application fee として設定可能）
- **デプロイ自動化** — 初回セットアップスクリプトと GitHub Actions による自動デプロイを用意しています

## クイックスタート（ローカル）

依存は Node.js のみです。

```sh
node server.mjs
```

- デモページ: http://localhost:8788/demo
- 管理画面: http://localhost:8788/admin
- レポート: http://localhost:8788/admin/report
- 月次レポート: http://localhost:8788/admin/monthly

ローカルではデータは `data-prod.json`（自動生成、git 管理外）に保存されます。管理画面にトークン認証を付ける場合は `ADMIN_TOKEN=<任意の文字列> node server.mjs` とし、リクエストヘッダ `x-admin-token` で認証します。

## テナント登録とコンソール

- テナント登録: `/signup`（テナント名・テナントID・担当者メールを入力すると、管理トークンが発行されます）
- テナントコンソール: `/tenant`（管理トークンで認証。自テナントの枠・広告主・申込・Stripe 接続のみ操作できます）
- 運営側の管理画面: `/admin`（全テナント横断。従来どおり）

## Stripe Connect（Direct charges）と請求書

1. テナントがコンソールの「Stripe を接続する」から Connect オンボーディングを完了します。アカウント種別は `STRIPE_ACCOUNT_TYPE`（既定 `standard` / `express`）。`standard` はテナント自身の Stripe アカウントをそのまま使う形で、請求書の名義・適格請求書の登録番号・振込先はアカウント側の設定が効きます
2. 申込に対して、テナントは次のどちらかで請求できます
   - **支払いリンク（Checkout）** — テナントの接続アカウント上での Direct charge。支払われると申込の支払い状態が自動で `paid` になります
   - **請求書を送る** — 接続アカウント名義の Stripe 請求書を作成し、Stripe が広告主へメール送信します（ホスト請求書ページの URL も申込に残ります）
3. 必要な環境変数: `STRIPE_SECRET_KEY`、`STRIPE_WEBHOOK_SECRET`、`PUBLIC_BASE_URL`、任意で `PLATFORM_FEE_BPS`（プラットフォーム手数料、100 = 1%。application fee として差し引かれます）
4. Webhook エンドポイント `https://<your-domain>/stripe/webhook` に `checkout.session.completed` / `invoice.paid` / `invoice.payment_failed` / `account.updated` を登録してください

## 自社利用の初期投入

デプロイ直後に `scripts/seed-rex.mjs` を実行すると、運用者自身のテナントと初期ゾーンを公開インターフェース経由で作成できます（管理トークンが表示されるので保存してください）。

```sh
node scripts/seed-rex.mjs --base https://<your-domain>
```

## Cloudflare へのデプロイ

初回はセットアップスクリプトが、リソース作成から初回デプロイまでを行います（`npx wrangler login` 済みが前提です）。

```sh
bash scripts/setup.sh
```

以降は GitHub Actions（`.github/workflows/deploy.yml`）が `main` への push で自動デプロイします。リポジトリの Secrets に `CLOUDFLARE_API_TOKEN` と `CLOUDFLARE_ACCOUNT_ID` を登録してください。手動で進める場合は次の手順です。

1. D1 データベース、KV 名前空間、Queues を作成し、`wrangler.toml` の ID を差し替えます
   ```sh
   npx wrangler d1 create bannerly
   npx wrangler kv namespace create SNAP
   npx wrangler queues create ad-events
   ```
2. スキーマを適用します
   ```sh
   npx wrangler d1 execute bannerly --remote --file=schema.sql
   ```
3. 管理トークンを設定します
   ```sh
   npx wrangler secret put ADMIN_TOKEN
   ```
4. デプロイします
   ```sh
   npx wrangler deploy
   ```
5. 管理画面（`/admin`）の前段に Cloudflare Access を置くことを推奨します
6. テナント・枠・広告主は管理画面の追加フォームから登録します

本番では、配信は KV スナップショットを参照し、計測イベントは Queues 経由で D1 に取り込まれます。毎時の Cron でスナップショット再発行と時間次集計が走ります。

## 枠の埋め込み

### Web（タグ）

```html
<script src="https://<your-domain>/tag/<zone-id>.js"></script>
```

または配信エンドポイントを直接読み込んでください。

```
GET /ad/<zone-id>            → HTML（広告表記付き）
GET /ad/<zone-id>?format=json → 構造化レスポンス（creative / imp・click URL を含む）
```

地域ルールを使う場合は `?region=<値>` または `x-region` ヘッダで地域を渡します。

### アプリ（Expo / React Native）

クライアント SDK は別リポジトリ [bannerly/sdk](https://github.com/bannerly/sdk) で提供しています。構造化クリエイティブをネイティブ描画する `AdSlot` コンポーネントが含まれます。

## 配信仕様

- 優先度は **Override > Contract > Remnant**。同優先度内は重み付きで選択されます
- Contract は目標インプレッション到達で止まります。管理画面に進捗と到達予測（未達アラート）が表示されます
- バックフィルは、配信可能なキャンペーンがない場合に枠ごとの設定 HTML を返します
- インプレッションは配信トークン単位で重複排除され、クリックは計測後にリンク先へリダイレクトします

## データモデル

`schema.sql` を参照してください。主要テーブル: `tenants` / `zones` / `advertisers` / `campaigns` / `banners`（`review_status` を持ちます）/ `plans` / `orders` / `events_raw` / `stats_hourly`。

## 状態

Phase 1（実用化）まで実装済みです。ローカル構成（JSON リポジトリ）での通し検証は完了しています。D1 構成はコード完成済みで、初回デプロイ時の動作確認を前提としています。決済連携（Stripe）と GAM 実連携は今後の段階です。

## ライセンス

MIT License
