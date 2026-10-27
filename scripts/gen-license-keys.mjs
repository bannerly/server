#!/usr/bin/env node
// ライセンス署名用の鍵ペアを生成する（発行者＝RE-X が自分の環境で実行する）。
// 秘密鍵は標準ではファイルへ書き出し、公開鍵（JWK）は標準出力へ出す。
// 使い方: node scripts/gen-license-keys.mjs [秘密鍵の出力先=./license-private.jwk.json]
// 注意: 秘密鍵ファイルは絶対にリポジトリへコミットしないこと。
import fs from "node:fs";
import { generateLicenseKeyPair } from "../src/license.mjs";

const out = process.argv[2] || "./license-private.jwk.json";
const { privateJwk, publicJwk } = await generateLicenseKeyPair();
fs.writeFileSync(out, JSON.stringify(privateJwk, null, 1), { mode: 0o600 });
console.log(`秘密鍵を ${out} に書きました（mode 600）。安全な場所に保管し、リポジトリには入れないでください。`);
console.log("公開鍵（JWK）: 各デプロイの LICENSE_PUBLIC_KEY に設定します");
console.log(JSON.stringify(publicJwk));
