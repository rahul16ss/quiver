# Changelog

All notable public-surface changes to Quiver are documented here. The format is
Keep a Changelog-compatible and the project follows Semantic Versioning.

## [Unreleased]

### Added

- cwd-independent `npm run build`, `npm run lint`, `npm run format:check`, and
  `npm run check` quality gates.
- Compiled `dist/` runtime build for the CLI and loopback browser daemon.
- OSS readiness ledger in `docs/status/READINESS.md`.
- Public surface and semver contract in `docs/STABILITY.md`.

### Fixed

- Runtime TypeScript imports that could not compile to a production `dist/` build.
- Stale lockfile entries for retired Electron packaging dependencies.

### Security

- Production dependency audit (`npm audit --omit=dev --audit-level=high`) reports
  zero high/critical vulnerabilities.
