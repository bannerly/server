// RE-X 自社利用のための初期投入スクリプト。
// デプロイ済みの Slotly に対して、公開インターフェース（/signup と /tenant）だけを使って
// テナント「re-x」と初期ゾーンを作成する。
// 使い方: node scripts/seed-rex.mjs --base https://<your-domain> [--email kaz@re-x.info]
// 実行すると管理トークンが表示される（この画面でしか取得できないので必ず保存すること）。
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => {
  if (a.startsWith("--")) acc.push([a.slice(2), arr[i + 1]]);
  return acc;
}, []));
const base = (args.base || "http://localhost:8788").replace(/\/$/, "");
const email = args.email || "kaz@re-x.info";

const ZONES = [
  { name: "代行ライド（Web）", width: 728, height: 90 },
  { name: "あにまる（アプリ）", width: 320, height: 180 },
  { name: "バイク駐車場マップ（アプリ）", width: 320, height: 180 },
];
const backfill = name => `<div style="background:#f2f2f2;display:flex;align-items:center;justify-content:center;font-family:sans-serif;color:#888;width:100%;height:100%;">広告枠（${name}）</div>`;

let cookie = "";
async function call(method, path, form) {
  const res = await fetch(base + path, {
    method, redirect: "manual",
    headers: { ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}), ...(cookie ? { cookie } : {}) },
    body: form ? new URLSearchParams(form).toString() : undefined,
  });
  const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  if (setCookie.length) cookie = setCookie.map(c => c.split(";")[0]).join("; ");
  return { status: res.status, text: await res.text() };
}

const signup = await call("POST", "/signup", { name: "RE-X", slug: "re-x", email });
if (signup.status === 409) {
  console.log("テナント re-x は既に存在します。管理トークンは既存のものを使ってください（再発行はできません）。");
  process.exit(0);
}
if (signup.status !== 200) { console.error(`signup failed: ${signup.status}`); process.exit(1); }
const token = (signup.text.match(/<code>([0-9a-f]{48})<\/code>/) || [])[1];
console.log("テナント re-x を作成しました。");
console.log(`管理トークン（必ず保存してください）: ${token}`);

for (const z of ZONES) {
  const r = await call("POST", "/tenant/zones", { name: z.name, width: z.width, height: z.height, backfill_html: backfill(z.name) });
  console.log(`ゾーン作成: ${z.name} -> ${r.status}`);
}
const consoleHtml = (await call("GET", "/tenant")).text;
const zoneIds = [...new Set([...consoleHtml.matchAll(/\/ad\/(zone-[a-z0-9-]+)/g)].map(m => m[1]))];
console.log("ゾーンID:", zoneIds.join(", ") || "(取得できませんでした。/tenant で確認してください)");
console.log(`コンソール: ${base}/tenant`);
console.log("次にやること: コンソールで Stripe を接続し、広告主を登録すると、申込から請求書を送れます。");
