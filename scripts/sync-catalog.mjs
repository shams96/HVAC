// Copies the built catalog to the API's config. Refuses catalogs from fixture or placeholder builds so fake
// facts can never ground the production chat agent.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const src = "dist/catalog.json";
const dest = "api/config/catalog.json";
let cat;
try { cat = JSON.parse(readFileSync(src, "utf8")); } catch { console.error(`Cannot read ${src}. Run the site build first.`); process.exit(1); }
if ((cat.meta?.fixture || cat.meta?.placeholder) && process.env.ALLOW_STAGING_CATALOG !== "1") {
  console.error(`Refusing to sync: the catalog was built from ${cat.meta.fixture ? "fixture data" : "placeholder (incomplete) business facts"}. ` +
    "Supply the real owner facts and build for production. Set ALLOW_STAGING_CATALOG=1 only for a staging API.");
  process.exit(1);
}
mkdirSync("api/config", { recursive: true });
writeFileSync(dest, JSON.stringify(cat, null, 2));
console.log(`catalog synced: ${cat.services.length} services, ${cat.areas.length} ZIPs -> ${dest}`);
