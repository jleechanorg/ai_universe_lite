#!/usr/bin/env bash
# prepare_shared_libs.sh — mirror of jleechanorg/ai_universe's pattern
# Builds each shared-libs/packages/*/dist once, stages package.json + tsconfig.json + dist (NEVER src).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SHARED="$ROOT/shared-libs/packages"
OUT="$ROOT/backend/.shared-libs-staging"

echo "📦 Preparing shared-libs staging at $OUT"
rm -rf "$OUT"
mkdir -p "$OUT"

for pkg_dir in "$SHARED"/*/; do
  pkg_name="$(basename "$pkg_dir")"
  echo "  • Building $pkg_name"
  pushd "$pkg_dir" >/dev/null
  if [ -f "package.json" ]; then
    npm install --no-audit --no-fund --silent || true
    if npm run build --silent 2>/dev/null; then
      :
    else
      echo "    (no build script — using src as-is)"
    fi
  fi
  popd >/dev/null

  pkg_out="$OUT/$pkg_name"
  mkdir -p "$pkg_out"
  cp "$pkg_dir/package.json" "$pkg_out/" 2>/dev/null || true
  cp "$pkg_dir/tsconfig.json" "$pkg_out/" 2>/dev/null || true
  cp "$pkg_dir/README.md" "$pkg_out/" 2>/dev/null || true
  if [ -d "$pkg_dir/dist" ]; then
    cp -R "$pkg_dir/dist" "$pkg_out/"
  fi
  # Explicitly DO NOT copy src
  if [ -d "$pkg_dir/src" ]; then
    echo "    ⚠️  WARNING: src/ exists in $pkg_name — leaving in workspace, NOT staging (build uses dist only)"
  fi
done

echo "✅ Staging complete. Verify with: node $ROOT/backend/scripts/verify-shared-libs-staging.mjs"
