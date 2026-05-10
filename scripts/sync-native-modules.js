#!/usr/bin/env node
/**
 * sync-native-modules.js — Copy rebuilt native modules to src/node_modules/
 *
 * After electron-rebuild compiles native .node files for the target platform,
 * this script copies the relevant production dependencies from the project
 * root node_modules/ into src/node_modules/ so forge packs the correct
 * binaries into the ASAR.
 *
 * Only copies modules listed in the upstream _asar/package.json dependencies.
 * Skips macOS-only modules (objc-js) on Linux.
 *
 * Usage:
 *   node scripts/sync-native-modules.js --platform linux-x64
 */
const fs = require("fs");
const path = require("path");

const PROJECT_ROOT = path.join(__dirname, "..");
const SRC = path.join(PROJECT_ROOT, "src");
const ROOT_MODULES = path.join(PROJECT_ROOT, "node_modules");
const SRC_MODULES = path.join(SRC, "node_modules");

const MACOS_ONLY = new Set(["objc-js"]);

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

function main() {
  const args = process.argv.slice(2);
  const platIdx = args.indexOf("--platform");
  const platform = platIdx !== -1 ? args[platIdx + 1] : null;
  const isLinux = platform?.startsWith("linux");

  // Read upstream dependency list from _asar/package.json
  const sourceDir = isLinux
    ? path.join(SRC, platform === "linux-arm64" ? "mac-arm64" : "mac-x64")
    : null;

  let deps;
  const asarPkg = sourceDir
    ? path.join(sourceDir, "_asar", "package.json")
    : path.join(SRC, "package.json");

  if (fs.existsSync(asarPkg)) {
    const pkg = JSON.parse(fs.readFileSync(asarPkg, "utf-8"));
    deps = Object.keys(pkg.dependencies || {});
  } else {
    console.error("[x] Cannot find upstream package.json for dependency list");
    process.exit(1);
  }

  // Filter out macOS-only modules on Linux
  if (isLinux) {
    deps = deps.filter((d) => !MACOS_ONLY.has(d));
  }

  console.log(`-- sync-native-modules: ${platform || "unknown"}`);
  console.log(`   ${deps.length} production dependencies`);

  fs.mkdirSync(SRC_MODULES, { recursive: true });

  let totalCopied = 0;
  let nativeCount = 0;

  for (const dep of deps) {
    const rootDir = path.join(ROOT_MODULES, dep);
    if (!fs.existsSync(rootDir)) {
      // Check if it's a bundled/internal module from upstream (not in our package.json)
      continue;
    }

    const destDir = path.join(SRC_MODULES, dep);
    if (fs.existsSync(destDir)) fs.rmSync(destDir, { recursive: true });

    const count = copyRecursive(rootDir, destDir);
    totalCopied += count;

    // Check if this module has native binaries
    const hasNative = findFiles(destDir, ".node").length > 0;
    if (hasNative) {
      nativeCount++;
      console.log(`   [native] ${dep} (${count} files)`);
    }
  }

  // Also copy scoped dependency sub-trees (@sentry/*, etc.)
  for (const dep of deps) {
    if (!dep.startsWith("@")) continue;
    const [scope] = dep.split("/");
    const scopeRoot = path.join(ROOT_MODULES, scope);
    const scopeDest = path.join(SRC_MODULES, scope);
    if (!fs.existsSync(scopeRoot)) continue;
    if (fs.existsSync(scopeDest)) continue; // already copied

    const count = copyRecursive(scopeRoot, scopeDest);
    totalCopied += count;
  }

  console.log(`   [ok] ${totalCopied} files synced, ${nativeCount} native module(s)`);
}

function findFiles(dir, ext) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) results.push(...findFiles(p, ext));
    else if (e.name.endsWith(ext)) results.push(p);
  }
  return results;
}

main();
