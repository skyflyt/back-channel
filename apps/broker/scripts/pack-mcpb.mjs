// Pack connector/ into public/back-channel.mcpb — a deterministic, STORE-only
// (no compression) zip, so the committed artifact is byte-stable across
// machines and rebuilds: fixed timestamp, fixed file order, no external deps.
//   npm run pack:mcpb
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(root, "connector");
const OUT = join(root, "public", "back-channel.mcpb");

// Fixed order = stable central directory. Add new files HERE and bump
// manifest.json + connector/package.json versions.
const FILES = ["manifest.json", "package.json", "server/index.js", "server/lib.js"];

// Fixed DOS timestamp: 2026-01-01 00:00:00 (zip has no tz; determinism > truth).
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };

const locals = [];
const centrals = [];
let offset = 0;

for (const name of FILES) {
  // Normalize to LF so a Windows checkout and a Linux CI produce the same bytes.
  const data = Buffer.from(readFileSync(join(SRC, name), "utf8").replace(/\r\n/g, "\n"), "utf8");
  const nameBuf = Buffer.from(name, "utf8");
  const crc = crc32(data);

  const local = Buffer.concat([
    u32(0x04034b50), u16(20), u16(0), u16(0) /* STORE */, u16(DOS_TIME), u16(DOS_DATE),
    u32(crc), u32(data.length), u32(data.length), u16(nameBuf.length), u16(0), nameBuf, data,
  ]);
  centrals.push(Buffer.concat([
    u32(0x02014b50), u16(20), u16(20), u16(0), u16(0) /* STORE */, u16(DOS_TIME), u16(DOS_DATE),
    u32(crc), u32(data.length), u32(data.length), u16(nameBuf.length), u16(0), u16(0),
    u16(0), u16(0), u32(0), u32(offset), nameBuf,
  ]));
  locals.push(local);
  offset += local.length;
}

const centralDir = Buffer.concat(centrals);
const eocd = Buffer.concat([
  u32(0x06054b50), u16(0), u16(0), u16(FILES.length), u16(FILES.length),
  u32(centralDir.length), u32(offset), u16(0),
]);

mkdirSync(dirname(OUT), { recursive: true });
const zip = Buffer.concat([...locals, centralDir, eocd]);
writeFileSync(OUT, zip);

const { createHash } = await import("node:crypto");
console.log(`wrote ${OUT} (${zip.length} bytes, ${FILES.length} files)`);
console.log(`sha256 ${createHash("sha256").update(zip).digest("hex")}`);
