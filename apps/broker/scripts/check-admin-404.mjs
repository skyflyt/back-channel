#!/usr/bin/env node
/**
 * Does the admin area look, to someone who is not the owner, exactly like a URL
 * that does not exist? (src/proxy.ts, src/lib/no-such-page.mjs)
 *
 * For each kind of request this asks for an admin path and for a made-up path
 * of the same shape, with the same request headers, and compares what comes
 * back: status, every response header in order, and the body's bytes. It only
 * ever sends requests a stranger could send (no session), so it is safe to run
 * against production.
 *
 *   node scripts/check-admin-404.mjs                      # http://127.0.0.1:8080
 *   node scripts/check-admin-404.mjs https://back-channel.app
 *
 * Exits 1 if anything differs.
 */
import http from "node:http";
import https from "node:https";
import { createHash } from "node:crypto";

const base = new URL(process.argv[2] ?? "http://127.0.0.1:8080");
const client = base.protocol === "https:" ? https : http;

// Headers that legitimately differ between any two requests, admin or not.
const PER_REQUEST = new Set(["date", "x-cloud-trace-context", "set-cookie", "alt-svc", "server-timing", "age"]);

function send(method, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = client.request(new URL(path, base), { method, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const raw = [];
        for (let i = 0; i < res.rawHeaders.length; i += 2) {
          if (!PER_REQUEST.has(res.rawHeaders[i].toLowerCase())) raw.push(`${res.rawHeaders[i]}: ${res.rawHeaders[i + 1]}`);
        }
        const body = Buffer.concat(chunks);
        resolve({ status: res.statusCode, raw, bytes: body.length, sha: createHash("sha256").update(body).digest("hex").slice(0, 12) });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

const BROWSER = { accept: "text/html,application/xhtml+xml", "accept-encoding": "gzip, deflate, br", "user-agent": "Mozilla/5.0" };
const JSON_CLIENT = { accept: "application/json", "content-type": "application/json" };

// [what, method, admin path, made-up path of the same shape, request headers]
const cases = [
  ["page, bare request", "GET", "/admin", "/qzxvn", {}],
  ["page, as a browser", "GET", "/admin", "/qzxvn", BROWSER],
  ["page with a query", "GET", "/admin?next=1", "/qzxvn?next=1", BROWSER],
  ["page under it", "GET", "/admin/users", "/qzxvn/users", BROWSER],
  ["page, HEAD", "HEAD", "/admin", "/qzxvn", BROWSER],
  ["page, POST", "POST", "/admin", "/qzxvn", BROWSER],
  ["page, bearer key", "GET", "/admin", "/qzxvn", { authorization: "Bearer bc_x" }],
  ["page, a cookie that is not a session", "GET", "/admin", "/qzxvn", { ...BROWSER, cookie: "bc_session=zzz" }],
  ["page, escaped letter", "GET", "/%61dmin", "/%71zxvn", BROWSER],
  ["page, client navigation (RSC)", "GET", "/admin", "/qzxvn", { rsc: "1", "accept-encoding": "gzip" }],
  ["page, prefetch", "GET", "/admin", "/qzxvn", { rsc: "1", "next-router-prefetch": "1" }],
  ["page, data request", "GET", "/_next/data/x/admin.json", "/_next/data/x/qzxvn.json", {}],
  ["API, read", "GET", "/api/admin/users", "/api/qzxvn/users", JSON_CLIENT],
  ["API, read, as a browser", "GET", "/api/admin/analytics", "/api/qzxvn/analytics", BROWSER],
  ["API, connection log", "GET", "/api/admin/remote-connections", "/api/qzxvn/remote-connections", JSON_CLIENT],
  ["API, write", "POST", "/api/admin/grant", "/api/qzxvn/grant", JSON_CLIENT],
  ["API, bearer key", "GET", "/api/admin/users", "/api/qzxvn/users", { authorization: "Bearer bc_x" }],
  ["API, escaped letter", "GET", "/api/%61dmin/users", "/api/%71zxvn/users", JSON_CLIENT],
  ["Remote entitlement route", "PUT", "/api/appbridge/v1/admin/entitlements", "/api/appbridge/v1/qzxvn/entitlements", JSON_CLIENT],
];

let differences = 0;
for (const [what, method, adminPath, otherPath, headers] of cases) {
  const [a, u] = await Promise.all([send(method, adminPath, headers), send(method, otherPath, headers)]);
  const same = a.status === u.status && a.sha === u.sha && JSON.stringify(a.raw) === JSON.stringify(u.raw);
  if (!same) differences++;
  console.log(`${same ? "same" : "DIFF"}  ${what.padEnd(38)} ${method.padEnd(4)} ${adminPath.padEnd(38)} ${a.status}/${u.status}  ${a.bytes}/${u.bytes} bytes`);
  if (!same) {
    if (a.sha !== u.sha) console.log(`        body differs (${a.sha} vs ${u.sha})`);
    for (const h of a.raw) if (!u.raw.includes(h)) console.log(`        only on the admin path: ${h.slice(0, 140)}`);
    for (const h of u.raw) if (!a.raw.includes(h)) console.log(`        only on the made-up path: ${h.slice(0, 140)}`);
  }
}
console.log(differences ? `\n${differences} of ${cases.length} differ: the admin area can be told apart from a URL that does not exist.` : `\nAll ${cases.length} identical: status, headers and body.`);
process.exit(differences ? 1 : 0);
