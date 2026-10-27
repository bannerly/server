// ローカル実行用アダプタ（node:http → Workers風 fetch ハンドラ）
// 使い方: node server.mjs  （http://localhost:8788/ demo / /admin / /ad/portal-top）
// 管理トークンを有効にする場合: ADMIN_TOKEN=xxxx node server.mjs （ヘッダ x-admin-token で認証）
import http from "node:http";
import worker from "./src/worker.mjs";

const env = { ADMIN_TOKEN: process.env.ADMIN_TOKEN || null };
const server = http.createServer(async (req, res) => {
  try {
    const url = `http://localhost${req.url}`;
    const headers = new Headers(req.headers);
    const body = ["GET", "HEAD"].includes(req.method) ? null : await new Promise(resolve => {
      const chunks = [];
      req.on("data", c => chunks.push(c));
      req.on("end", () => resolve(Buffer.concat(chunks)));
    });
    const response = await worker.fetch(new Request(url, { method: req.method, headers, body }), env, {});
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (err) {
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end(`error: ${err.message}`);
  }
});
server.listen(8788, () => console.log("ad-platform (prod構成) http://localhost:8788  demo=/demo admin=/admin"));
