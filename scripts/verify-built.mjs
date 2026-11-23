// Usage: node scripts/verify-built.mjs [distDir] [--require-real-url]
import { verifyDist } from "./lib/verify-dist.mjs";

const args = process.argv.slice(2);
const dist = args.find((a) => !a.startsWith("--")) ?? "dist";
const problems = verifyDist(dist, { requireRealUrl: args.includes("--require-real-url") });
if (problems.length) {
  console.error(`SEO verification failed (${problems.length}):\n - ${problems.join("\n - ")}`);
  process.exit(1);
}
console.log(`SEO verification passed for ${dist}`);
