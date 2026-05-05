#!/usr/bin/env node
/**
 * sync-upstream.js — Extract full upstream Codex resources
 *
 * Downloads official builds, extracts everything from Resources directory.
 * ASAR is extracted (for patching), all other files kept as-is.
 *
 * Output:
 *   src/mac-arm64/   Full Resources/ from macOS arm64 Sparkle ZIP
 *   src/mac-x64/     Full Resources/ from macOS x64 Sparkle ZIP
 *   src/win/          Full resources/ from Windows MSIX
 *
 * Usage:
 *   node scripts/sync-upstream.js                 # Sync if new version
 *   node scripts/sync-upstream.js --force         # Force re-sync
 *   node scripts/sync-upstream.js --check-only    # Check versions only
 *   node scripts/sync-upstream.js --skip-mac      # Skip macOS
 *   node scripts/sync-upstream.js --skip-win      # Skip Windows
 */

const https = require("https");
const tls = require("tls");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

// ─── TLS certs for MS delivery CDN ──────────────────────────────
const certsDir = path.join(__dirname, "certs");
const extraCAs = [...tls.rootCertificates];
for (const f of ["ms-root-ca.pem", "ms-update-ca.pem"]) {
  const p = path.join(certsDir, f);
  if (fs.existsSync(p)) extraCAs.push(fs.readFileSync(p, "utf-8"));
}
https.globalAgent.options.ca = extraCAs;

// ─── Constants ──────────────────────────────────────────────────
const PROJECT_ROOT = path.resolve(__dirname, "..");
const SRC_DIR = path.join(PROJECT_ROOT, "src");
const TEMP_DIR = path.join(require("os").tmpdir(), "codex-sync");
const VERSION_FILE = path.join(__dirname, ".versions.json");

const APPCAST_ARM64 = "https://persistent.oaistatic.com/codex-app-prod/appcast.xml";
const APPCAST_X64 = "https://persistent.oaistatic.com/codex-app-prod/appcast-x64.xml";

// ─── Args ───────────────────────────────────────────────────────
const args = process.argv.slice(2);
const FORCE = args.includes("--force");
const CHECK_ONLY = args.includes("--check-only");
const SKIP_MAC = args.includes("--skip-mac");
const SKIP_WIN = args.includes("--skip-win");

// ─── Helpers ────────────────────────────────────────────────────

function httpGet(url) {
  const mod = url.startsWith("https") ? https : http;
  return new Promise((resolve, reject) => {
    mod.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
        return httpGet(res.headers.location).then(resolve, reject);
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    }).on("error", reject);
  });
}

function curlDownload(url, dest, label) {
  console.log(`  [dl] ${label}`);
  execSync(`curl -L --retry 3 --retry-delay 2 -o "${dest}" "${url}"`, { stdio: "inherit" });
}

function extract7z(archive, dest) {
  // Try 7zz then 7z — tolerate CRC warnings (Sparkle/MSIX quirks)
  for (const bin of ["7zz", "7z"]) {
    try {
      execSync(`${bin} x -y -o"${dest}" "${archive}"`, { stdio: "pipe" });
      return;
    } catch {
      // Check if extraction succeeded despite error
      if (fs.readdirSync(dest).length > 0) return;
    }
  }
  throw new Error(`Failed to extract ${archive}`);
}

function findFile(dir, name) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isFile() && e.name === name) return full;
    if (e.isDirectory()) { const r = findFile(full, name); if (r) return r; }
  }
  return null;
}

function copyRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  let count = 0;
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dest, e.name);
    if (e.isDirectory()) { count += copyRecursive(s, d); }
    else if (e.isSymbolicLink()) { /* skip symlinks — macOS framework links */ }
    else { fs.copyFileSync(s, d); count++; }
  }
  return count;
}

function clearDir(dir) {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
}

// ─── Version detection ──────────────────────────────────────────

async function getAppcastVersion(url) {
  const { XMLParser } = require("fast-xml-parser");
  const res = await httpGet(url);
  if (res.status !== 200) throw new Error(`Appcast fetch failed: ${res.status}`);
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", removeNSPrefix: true });
  const parsed = parser.parse(res.body.toString());
  const items = parsed.rss?.channel?.item;
  const latest = Array.isArray(items) ? items[0] : items;
  let enc = latest.enclosure;
  if (Array.isArray(enc)) enc = enc[0];
  return {
    version: latest.shortVersionString || latest.title,
    build: String(latest.version || ""),
    url: enc?.["@_url"] || "",
  };
}

async function getWindowsVersion() {
  const msstore = require("./fetch-msstore");
  const cookie = await msstore.getCookie();
  const info = await msstore.getAppInfo("9plm9xgg6vks", "US");
  if (!info.categoryId) throw new Error("No CategoryID");
  const pkgs = await msstore.getFileList(cookie, info.categoryId, "Retail");
  if (pkgs.length === 0) throw new Error("No packages");
  const pkg = pkgs[0];
  const url = await msstore.getDownloadUrl(pkg.updateID, pkg.revisionNumber, "Retail", pkg.digest);
  const verMatch = pkg.name.match(/_(\d+\.\d+\.\d+(?:\.\d+)?)_/);
  return { version: verMatch?.[1] || "unknown", url, packageName: pkg.name };
}

// ─── Extract macOS platform ─────────────────────────────────────

async function syncMac(variant, appcastUrl, destDir) {
  const label = `macOS-${variant}`;
  console.log(`\n-- ${label}`);

  const info = await getAppcastVersion(appcastUrl);
  console.log(`   version: ${info.version} (build ${info.build})`);

  const zipPath = path.join(TEMP_DIR, `Codex-${variant}-${info.version}.zip`);
  const extractDir = path.join(TEMP_DIR, `${variant}-extract`);

  // Download
  if (!fs.existsSync(zipPath)) {
    curlDownload(info.url, zipPath, label);
  } else {
    console.log(`   [cache] ${zipPath}`);
  }

  // Extract ZIP
  console.log("   [unzip]");
  clearDir(extractDir);
  extract7z(zipPath, extractDir);

  // Find Resources dir
  const resourcesDir = findResourcesDir(extractDir);
  if (!resourcesDir) throw new Error(`${label}: Resources directory not found`);

  // Find and extract ASAR
  const asarPath = path.join(resourcesDir, "app.asar");
  if (!fs.existsSync(asarPath)) throw new Error(`${label}: app.asar not found`);

  console.log("   [asar extract]");
  const asarTmp = path.join(TEMP_DIR, `${variant}-asar`);
  clearDir(asarTmp);
  execSync(`npx asar extract "${asarPath}" "${asarTmp}"`);

  // Assemble output: ASAR content + all other Resources files
  console.log(`   [assemble] -> ${path.relative(PROJECT_ROOT, destDir)}/`);
  clearDir(destDir);

  // 1. Copy extracted ASAR content (JS code for patching)
  copyRecursive(asarTmp, destDir);

  // 2. Copy all non-ASAR resources from Resources/ (binaries, plugins, etc.)
  for (const e of fs.readdirSync(resourcesDir, { withFileTypes: true })) {
    if (e.name === "app.asar" || e.name === "app.asar.unpacked") continue;
    if (e.name.endsWith(".lproj")) continue; // locale bundles (handled by Electron)
    const s = path.join(resourcesDir, e.name);
    const d = path.join(destDir, e.name);
    if (e.isDirectory()) {
      copyRecursive(s, d);
    } else if (!e.isSymbolicLink()) {
      fs.copyFileSync(s, d);
    }
  }

  const fileCount = countFiles(destDir);
  console.log(`   [ok] ${fileCount} files`);
  return info;
}

function findResourcesDir(extractDir) {
  // macOS: Codex.app/Contents/Resources/
  const appDir = findFile(extractDir, "app.asar");
  return appDir ? path.dirname(appDir) : null;
}

// ─── Extract Windows platform ───────────────────────────────────

async function syncWin(destDir) {
  console.log("\n-- Windows");

  const info = await getWindowsVersion();
  console.log(`   version: ${info.version}`);

  const msixPath = path.join(TEMP_DIR, info.packageName || `codex-win-${info.version}.msix`);
  const extractDir = path.join(TEMP_DIR, "win-extract");

  // Download
  if (!fs.existsSync(msixPath)) {
    curlDownload(info.url, msixPath, "Windows MSIX");
  } else {
    console.log(`   [cache] ${msixPath}`);
  }

  // Extract MSIX
  console.log("   [unzip]");
  clearDir(extractDir);
  extract7z(msixPath, extractDir);

  // Find resources dir (MSIX: app/resources/)
  const resourcesDir = path.join(extractDir, "app", "resources");
  if (!fs.existsSync(resourcesDir)) {
    // Try alternative paths
    const altAsar = findFile(extractDir, "app.asar");
    if (!altAsar) throw new Error("Windows: resources dir not found");
    throw new Error(`Windows: unexpected structure, app.asar at ${altAsar}`);
  }

  const asarPath = path.join(resourcesDir, "app.asar");
  if (!fs.existsSync(asarPath)) throw new Error("Windows: app.asar not found");

  console.log("   [asar extract]");
  const asarTmp = path.join(TEMP_DIR, "win-asar");
  clearDir(asarTmp);
  execSync(`npx asar extract "${asarPath}" "${asarTmp}"`);

  // Assemble output
  console.log(`   [assemble] -> ${path.relative(PROJECT_ROOT, destDir)}/`);
  clearDir(destDir);

  // 1. ASAR content
  copyRecursive(asarTmp, destDir);

  // 2. All non-ASAR resources
  for (const e of fs.readdirSync(resourcesDir, { withFileTypes: true })) {
    if (e.name === "app.asar" || e.name === "app.asar.unpacked") continue;
    const s = path.join(resourcesDir, e.name);
    const d = path.join(destDir, e.name);
    if (e.isDirectory()) {
      copyRecursive(s, d);
    } else if (!e.isSymbolicLink()) {
      fs.copyFileSync(s, d);
    }
  }

  const fileCount = countFiles(destDir);
  console.log(`   [ok] ${fileCount} files`);
  return info;
}

// ─── Utilities ──────────────────────────────────────────────────

function countFiles(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) n += countFiles(path.join(dir, e.name));
    else n++;
  }
  return n;
}

function loadVersions() {
  try { return JSON.parse(fs.readFileSync(VERSION_FILE, "utf-8")); } catch { return {}; }
}

function saveVersions(v) {
  fs.writeFileSync(VERSION_FILE, JSON.stringify(v, null, 2) + "\n");
}

// ─── Main ───────────────────────────────────────────────────────

async function main() {
  console.log("== Codex upstream sync ==\n");
  fs.mkdirSync(TEMP_DIR, { recursive: true });

  const saved = loadVersions();
  const results = {};

  // macOS arm64
  if (!SKIP_MAC) {
    try {
      const info = await syncMac("arm64", APPCAST_ARM64, path.join(SRC_DIR, "mac-arm64"));
      results["mac-arm64"] = info;
    } catch (e) {
      console.error(`   [x] mac-arm64: ${e.message}`);
    }

    // macOS x64
    try {
      const info = await syncMac("x64", APPCAST_X64, path.join(SRC_DIR, "mac-x64"));
      results["mac-x64"] = info;
    } catch (e) {
      console.error(`   [x] mac-x64: ${e.message}`);
    }
  }

  // Windows
  if (!SKIP_WIN) {
    try {
      const info = await syncWin(path.join(SRC_DIR, "win"));
      results.win = info;
    } catch (e) {
      console.error(`   [x] win: ${e.message}`);
    }
  }

  // Save versions
  const newSaved = { ...saved };
  for (const [key, info] of Object.entries(results)) {
    newSaved[key] = {
      version: info.version,
      build: info.build || "",
      checkedAt: new Date().toISOString(),
    };
  }
  saveVersions(newSaved);

  console.log("\n== Done ==");
  for (const [key, info] of Object.entries(results)) {
    console.log(`   ${key}: ${info.version}`);
  }
}

main().catch((e) => {
  console.error(`\n[x] ${e.message}`);
  process.exit(1);
});
