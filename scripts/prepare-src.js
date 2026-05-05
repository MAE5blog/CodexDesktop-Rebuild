#!/usr/bin/env node
/**
 * Pre-build: Copy platform resources into flat src/ for forge.
 *
 * Sources:
 *   --platform mac-arm64   src/mac-arm64/
 *   --platform mac-x64     src/mac-x64/
 *   --platform win         src/win/
 *   --platform linux-x64   src/mac-x64/ + strip macOS-only + Linux binaries
 *   --platform linux-arm64 src/mac-arm64/ + strip macOS-only + Linux binaries
 *
 * Usage:
 *   node scripts/prepare-src.js --platform mac-arm64
 */
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "src");
const PROJECT_ROOT = path.join(__dirname, "..");

// macOS-only files to strip for Linux builds
const MACOS_ONLY = new Set([
  "codex",              // macOS codex binary (Linux gets its own)
  "codex_chronicle",    // macOS only tool
  "node",              // macOS node binary
  "node_repl",         // macOS node repl
  "rg",                // macOS rg binary (Linux gets its own)
  "electron.icns",     // macOS icon
  "Assets.car",        // macOS asset catalog
  "codexTemplate.png",
  "codexTemplate@2x.png",
]);
const MACOS_ONLY_DIRS = new Set([
  "native",            // macOS native modules (sparkle.node etc)
]);

function copyRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  let count = 0;
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dest, e.name);
    if (e.isDirectory()) { count += copyRecursive(s, d); }
    else if (e.isSymbolicLink()) { /* skip */ }
    else { fs.copyFileSync(s, d); count++; }
  }
  return count;
}

function copyRecursiveFiltered(src, dest, skipFiles, skipDirs) {
  fs.mkdirSync(dest, { recursive: true });
  let count = 0;
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.isDirectory() && skipDirs.has(e.name)) continue;
    if (e.isFile() && skipFiles.has(e.name)) continue;
    const s = path.join(src, e.name), d = path.join(dest, e.name);
    if (e.isDirectory()) { count += copyRecursiveFiltered(s, d, skipFiles, skipDirs); }
    else if (e.isSymbolicLink()) { /* skip */ }
    else { fs.copyFileSync(s, d); count++; }
  }
  return count;
}

function clearDir(dir) {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
}

function main() {
  const args = process.argv.slice(2);
  const platIdx = args.indexOf("--platform");
  const platform = platIdx !== -1 ? args[platIdx + 1] : null;

  const VALID = ["mac-arm64", "mac-x64", "win", "linux-x64", "linux-arm64"];
  if (!platform || !VALID.includes(platform)) {
    console.error(`[x] Usage: prepare-src.js --platform <${VALID.join("|")}>`);
    process.exit(1);
  }

  // Determine source directory
  let sourceDir;
  let isLinux = false;

  switch (platform) {
    case "mac-arm64":
    case "mac-x64":
    case "win":
      sourceDir = path.join(SRC, platform);
      break;
    case "linux-x64":
      sourceDir = path.join(SRC, "mac-x64");
      isLinux = true;
      break;
    case "linux-arm64":
      sourceDir = path.join(SRC, "mac-arm64");
      isLinux = true;
      break;
  }

  if (!fs.existsSync(sourceDir)) {
    console.error(`[x] Source not found: ${path.relative(PROJECT_ROOT, sourceDir)}/`);
    process.exit(1);
  }

  console.log(`-- prepare-src: ${platform}`);
  console.log(`   source: ${path.relative(PROJECT_ROOT, sourceDir)}/`);

  // Clear flat src/ build dirs (gitignored)
  for (const d of [".vite", "webview", "skills", "native-menu-locales", "node_modules"]) {
    clearDir(path.join(SRC, d));
  }
  // Remove flat src/ loose files
  for (const f of fs.readdirSync(SRC)) {
    const p = path.join(SRC, f);
    if (fs.statSync(p).isFile()) fs.unlinkSync(p);
  }

  // Copy
  let count;
  if (isLinux) {
    console.log("   [linux] stripping macOS-only resources");
    count = copyRecursiveFiltered(sourceDir, SRC, MACOS_ONLY, MACOS_ONLY_DIRS);

    // Add Linux binaries from @cometix/codex vendor
    const vendorLinux = resolveVendorBinaries(platform === "linux-arm64" ? "aarch64-unknown-linux-musl" : "x86_64-unknown-linux-musl");
    if (vendorLinux.codex) {
      fs.copyFileSync(vendorLinux.codex, path.join(SRC, "codex"));
      try { fs.chmodSync(path.join(SRC, "codex"), 0o755); } catch {}
      console.log("   [linux] codex binary from @cometix/codex");
      count++;
    }
    if (vendorLinux.rg) {
      fs.copyFileSync(vendorLinux.rg, path.join(SRC, "rg"));
      try { fs.chmodSync(path.join(SRC, "rg"), 0o755); } catch {}
      console.log("   [linux] rg binary from @cometix/codex");
      count++;
    }
  } else {
    count = copyRecursive(sourceDir, SRC);
  }

  // Sync version and metadata to root package.json
  const upstreamPkg = path.join(SRC, "package.json");
  if (fs.existsSync(upstreamPkg)) {
    const upstream = JSON.parse(fs.readFileSync(upstreamPkg, "utf-8"));
    const rootPkgPath = path.join(PROJECT_ROOT, "package.json");
    const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, "utf-8"));

    const oldVer = rootPkg.version;
    rootPkg.version = upstream.version || rootPkg.version;
    rootPkg.main = "src/.vite/build/bootstrap.js";

    for (const key of [
      "codexBuildNumber", "codexBuildFlavor",
      "codexSparkleFeedUrl", "codexSparklePublicKey",
      "codexWindowsUpdateUrl", "codexWindowsPackageIdentity",
      "codexWindowsPackagePublisher",
    ]) {
      if (upstream[key]) rootPkg[key] = upstream[key];
    }

    fs.writeFileSync(rootPkgPath, JSON.stringify(rootPkg, null, 2) + "\n");
    console.log(`   version: ${oldVer} -> ${rootPkg.version}`);
  }

  console.log(`   [ok] ${count} files -> src/`);
}

function resolveVendorBinaries(triple) {
  const vendorBase = path.join(PROJECT_ROOT, "node_modules", "@cometix", "codex", "vendor", triple);
  const result = {};
  const codexPath = path.join(vendorBase, "codex", "codex");
  if (fs.existsSync(codexPath)) result.codex = codexPath;
  const rgPath = path.join(vendorBase, "path", "rg");
  if (fs.existsSync(rgPath)) result.rg = rgPath;
  return result;
}

main();
