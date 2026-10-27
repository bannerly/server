#!/usr/bin/env node
// 署名付きライセンスファイルを発行する（発行者＝RE-X 専用）。
// 使い方:
//   LICENSE_PRIVATE_KEY_FILE=./license-private.jwk.json \
//   node scripts/issue-license.mjs --licensee "株式会社○○" --deployment dep-xxxx \
//     --expires 2027-10-27 --features core,line --report-endpoint https://... --out license.json
// --days N を使うと有効期限 = 発行日 + N 日。--expires と --days はどちらか必須。
import fs from "node:fs";
import { signLicense } from "../src/license.mjs";

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
const keyFile = process.env.LICENSE_PRIVATE_KEY_FILE || args.key;
if (!keyFile || !args.licensee || !args.deployment || (!args.expires && !args.days)) {
  console.error("必須: --key（または LICENSE_PRIVATE_KEY_FILE）, --licensee, --deployment, --expires か --days");
  process.exit(1);
}
const privateJwk = JSON.parse(fs.readFileSync(keyFile, "utf8"));
const issued = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10); // JST の日付
const expires = args.expires || new Date(Date.parse(`${issued}T00:00:00+09:00`) + parseInt(args.days, 10) * 86400000 + 9 * 3600000).toISOString().slice(0, 10);
const payload = {
  v: 1,
  licensee: args.licensee,
  deployment_id: args.deployment,
  issued_at: issued,
  expires_at: expires,
  features: (args.features || "core").split(",").map(s => s.trim()).filter(Boolean),
  report_endpoint: args["report-endpoint"] || "",
};
const envelope = await signLicense(payload, privateJwk, args.kid || "rex-license-1");
const out = args.out || "license.json";
fs.writeFileSync(out, JSON.stringify(envelope, null, 1));
console.log(`${out} を発行しました: ${payload.licensee} / ${payload.deployment_id} / 期限 ${payload.expires_at}`);
