// 署名付きライセンスファイルの発行・検証。
// 署名は ECDSA P-256 / SHA-256（WebCrypto。Workers と Node で同一実装）。
// 発行者（RE-X）が秘密鍵で署名し、各デプロイは公開鍵（JWK）で検証する。秘密鍵はリポジトリ・デプロイ先のどちらにも置かない。
// ライセンスは「警告のみ」に使う: 無効・期限切れでも配信は止めず、管理画面に状態を表示する。
const subtle = globalThis.crypto && globalThis.crypto.subtle;

function canonical(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
}
function bufToB64url(buf) {
  const b = new Uint8Array(buf);
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlToBuf(str) {
  const s = String(str).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s + "=".repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

export async function generateLicenseKeyPair() {
  const pair = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const privateJwk = await subtle.exportKey("jwk", pair.privateKey);
  const publicJwk = await subtle.exportKey("jwk", pair.publicKey);
  return { privateJwk, publicJwk };
}

export async function signLicense(payload, privateJwk, kid = "rex-license-1") {
  const key = await subtle.importKey("jwk", privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const data = new TextEncoder().encode(canonical(payload));
  const sig = await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, data);
  return { alg: "ES256", kid, payload, signature: bufToB64url(sig) };
}

export function parseLicense(text) {
  if (!text) return null;
  try {
    const o = typeof text === "string" ? JSON.parse(text) : text;
    if (!o || typeof o !== "object" || !o.payload || typeof o.payload !== "object" || !o.signature) return null;
    return o;
  } catch { return null; }
}

export async function verifyLicenseSignature(envelope, publicJwk) {
  try {
    const key = await subtle.importKey("jwk", publicJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const data = new TextEncoder().encode(canonical(envelope.payload));
    return await subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, b64urlToBuf(envelope.signature), data);
  } catch { return false; }
}

// env: { LICENSE_FILE?: string, LICENSE_PUBLIC_KEY?: string(JWK JSON), DEPLOYMENT_ID?: string }
// 戻り値: { state: "unset"|"valid"|"expired"|"invalid"|"unverifiable", payload?, reason?, daysLeft?, deploymentMismatch? }
export async function licenseStatus(env = {}, nowMs = Date.now()) {
  const raw = env.LICENSE_FILE || "";
  if (!raw.trim()) return { state: "unset" };
  const env1 = parseLicense(raw);
  if (!env1) return { state: "invalid", reason: "ライセンスファイルの形式が不正です" };
  let pub = null;
  try { pub = env.LICENSE_PUBLIC_KEY ? JSON.parse(env.LICENSE_PUBLIC_KEY) : null; } catch { pub = null; }
  if (!pub) return { state: "unverifiable", payload: env1.payload, reason: "検証用の公開鍵（LICENSE_PUBLIC_KEY）が未設定です" };
  const ok = await verifyLicenseSignature(env1, pub);
  if (!ok) return { state: "invalid", payload: env1.payload, reason: "署名が一致しません" };
  const p = env1.payload;
  const expMs = Date.parse(`${p.expires_at}T23:59:59+09:00`);
  const daysLeft = Number.isFinite(expMs) ? Math.ceil((expMs - nowMs) / 86400000) : null;
  const deploymentMismatch = !!(env.DEPLOYMENT_ID && p.deployment_id && env.DEPLOYMENT_ID !== p.deployment_id);
  if (daysLeft !== null && daysLeft < 0) return { state: "expired", payload: p, daysLeft, deploymentMismatch };
  return { state: "valid", payload: p, daysLeft, deploymentMismatch, expiringSoon: daysLeft !== null && daysLeft <= 30 };
}
