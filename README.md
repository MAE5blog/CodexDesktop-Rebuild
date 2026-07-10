# Codex Desktop Rebuild - MAE5 Fork

This fork tracks [Haleclipse/CodexDesktop-Rebuild](https://github.com/Haleclipse/CodexDesktop-Rebuild) and maintains two production targets for our own environment.

## Supported Distributions

| Platform | Architecture | Build environment | Status |
|----------|--------------|-------------------|--------|
| Windows | x64 | GitHub-hosted Windows runner and local Windows validation | Primary |
| Linux | ARM64 | Native GitHub ARM64 runner and Oracle Seoul ARM64 validation | Primary |

macOS and Linux x64 code remains available for upstream compatibility, but this fork does not publish or validate those distributions.

## Fork Goals

- Keep CPA/custom API provider support without embedding credentials.
- Preserve GPT-5.6 model visibility and all supported reasoning efforts.
- Keep Fast mode available while Standard remains the default.
- Keep plugin marketplace search and GitHub plugin visibility working.
- Preserve Browser, Chrome extension, and Computer Use integrations.
- Keep Windows session history compatible with the official Codex App data directory.
- Keep Linux ARM64 window controls and Chinese input methods working.
- Produce reproducible Windows x64 and Linux ARM64 release artifacts.

The detailed acceptance matrix and upstream policy are in [docs/TARGETS.md](docs/TARGETS.md).

## Build

```powershell
# Windows x64
npm ci
node scripts/sync-upstream.js --force --skip-mac
node scripts/patch-all.js win
npm run build:win-x64
```

```bash
# Linux ARM64, run on an ARM64 host
npm ci
node scripts/sync-upstream.js --force --skip-win
node scripts/patch-all.js mac-arm64
npm run build:linux-arm64
```

Manual and scheduled GitHub Actions workflows build only these two targets.

## Upstream Development

```bash
git fetch upstream
git merge upstream/master
```

Upstream changes are merged intentionally so MAE5 patches can be reviewed and revalidated instead of being overwritten automatically.

## Credits

- [OpenAI Codex](https://github.com/openai/codex)
- [Haleclipse/CodexDesktop-Rebuild](https://github.com/Haleclipse/CodexDesktop-Rebuild)
- [Electron Forge](https://www.electronforge.io/)

## License

This project rebuilds the Codex Desktop app for cross-platform distribution. Original Codex CLI components remain subject to their upstream licenses.
