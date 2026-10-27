#!/usr/bin/env node
// ライセンスファイルの署名と期限を検証する。
// 使い方: LICENSE_PUBLIC_KEY_FILE=./license-public.jwk.json node scripts/verify-license.mjs license.json
import fs from "node:fs";
import { licenseStatus } from "../src/license.mjs";

const file = process.argv[2];
if (!file) { console.error("ライセンスファイルのパスが必要です"); process.exit(1); }
const pub = process.env.LICENSE_PUBLIC_KEY_FILE ? fs.readFileSync(process.env.LICENSE_PUBLIC_KEY_FILE, "utf8") : (process.env.LICENSE_PUBLIC_KEY || "");
const st = await licenseStatus({ LICENSE_FILE: fs.readFileSync(file, "utf8"), LICENSE_PUBLIC_KEY: pub, DEPLOYMENT_ID: process.env.DEPLOYMENT_ID || "" });
console.log(JSON.stringify(st, null, 1));
process.exit(st.state === "valid" ? 0 : 1);
