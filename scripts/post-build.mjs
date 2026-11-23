// Runs after `astro build`: writes dist/_headers (CSP hashes from the built HTML) and, when INDEXNOW_KEY is set, the key file.
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { buildHeaders } from "./lib/headers.mjs";

const dist = process.argv[2] ?? "dist";
const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
const htmlFiles = walk(dist).filter((f) => f.endsWith(".html")).map((f) => readFileSync(f, "utf8"));
const noindex = /<meta name="robots" content="noindex/.test(readFileSync(join(dist, "index.html"), "utf8"));

writeFileSync(join(dist, "_headers"), buildHeaders({ htmlFiles, noindex, apiUrls: [process.env.PUBLIC_LEADS_API, process.env.PUBLIC_CHAT_API].filter(Boolean) }));
console.log(`wrote ${dist}/_headers (${noindex ? "noindex build" : "indexable build"})`);

const key = process.env.INDEXNOW_KEY;
if (key) {
  if (!/^[A-Za-z0-9-]{8,128}$/.test(key)) throw new Error("INDEXNOW_KEY must be 8 to 128 letters, digits or dashes");
  writeFileSync(join(dist, `${key}.txt`), key);
  console.log(`wrote ${dist}/${key}.txt`);
}
