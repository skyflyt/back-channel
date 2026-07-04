import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const EXTS = ["", ".ts", ".mjs", ".js"];

function resolveWithExt(full) {
  for (const ext of EXTS) {
    if (fs.existsSync(full + ext) && fs.statSync(full + ext).isFile()) return full + ext;
  }
  return full;
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    const full = path.join(SRC_ROOT, specifier.slice(2));
    return nextResolve(pathToFileURL(resolveWithExt(full)).href, context);
  }
  // Test-only shim: Next's package.json `exports` map requires an explicit
  // .js extension for subpath imports (e.g. "next/server") under plain
  // Node resolution; Next's own bundler resolves the extensionless form for
  // production code, so route files correctly import "next/server" as-is.
  // Only patch it up HERE, for the test runner.
  try {
    return await nextResolve(specifier, context);
  } catch (e) {
    if (e?.code === "ERR_MODULE_NOT_FOUND" && !specifier.endsWith(".js")) {
      try {
        return await nextResolve(specifier + ".js", context);
      } catch {
        // Fall through to the relative-import shim below (e.g. "./db" from a
        // .ts file under src/lib/ — same extensionless-import problem as the
        // "@/" case above, just via a relative specifier instead of the
        // alias. Only engage this for specifiers that plain Node resolution
        // already failed on, and only when the importer lives under
        // SRC_ROOT, so nothing outside src/ (e.g. node_modules internals) is
        // ever affected.
        if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL?.startsWith(pathToFileURL(SRC_ROOT).href)) {
          const parentDir = path.dirname(fileURLToPath(context.parentURL));
          const full = path.resolve(parentDir, specifier);
          const resolved = resolveWithExt(full);
          if (resolved !== full) return nextResolve(pathToFileURL(resolved).href, context);
        }
        throw e;
      }
    }
    throw e;
  }
}
