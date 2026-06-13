#!/usr/bin/env node
// verify-shared-libs-staging.mjs — fail if src/ accidentally staged
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(process.argv[2] || "backend/.shared-libs-staging");
if (!fs.existsSync(ROOT)) {
  console.error(`❌ staging dir not found: ${ROOT}`);
  console.error("Run: cd backend && npm run prepare:shared-libs");
  process.exit(1);
}

let failed = false;
for (const pkg of fs.readdirSync(ROOT)) {
  const pkgPath = path.join(ROOT, pkg);
  if (!fs.statSync(pkgPath).isDirectory()) continue;
  if (fs.existsSync(path.join(pkgPath, "src"))) {
    console.error(`❌ ${pkg}: src/ should NOT be in staging (build uses dist only)`);
    failed = true;
  }
  if (!fs.existsSync(path.join(pkgPath, "package.json"))) {
    console.error(`❌ ${pkg}: missing package.json`);
    failed = true;
  }
}

if (failed) process.exit(1);
console.log(`✅ Staging OK: ${ROOT}`);
