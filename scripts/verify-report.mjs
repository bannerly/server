#!/usr/bin/env node
// 署名付き利用量レポートの検証（受信側）
// 使い方: node scripts/verify-report.mjs <report.json> [--key <LICENSE_KEY>] [--prev <前月report.json>]
import fs from "node:fs";
import { verifyReport } from "../src/report.mjs";

const args = process.argv.slice(2);
const file = args[0];
if (!file) { console.error("report.json を指定してください"); process.exit(2); }
const key = args.includes("--key") ? args[args.indexOf("--key") + 1] : "";
const prevFile = args.includes("--prev") ? args[args.indexOf("--prev") + 1] : null;
const report = JSON.parse(fs.readFileSync(file, "utf8"));
const prev = prevFile ? JSON.parse(fs.readFileSync(prevFile, "utf8")) : undefined;
const r = await verifyReport(report, key, prev);
console.log(r.ok
  ? `OK: ${report.deployment_id} ${report.period} imp=${report.totals.imp} click=${report.totals.click} hash=${report.hash.slice(0, 16)}…`
  : `NG: ${r.reason}`);
process.exit(r.ok ? 0 : 1);
