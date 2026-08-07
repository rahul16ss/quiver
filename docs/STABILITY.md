# Public surface and stability contract

Quiver's stable public surface for the current 1.x line is intentionally narrow:

- the `quiver` CLI and its documented flags;
- workflow pack manifests under `workflow-packs/**/workflow.yaml`;
- customer-pack files under `packs/**`;
- documented environment variables in `.env.example`;
- the deterministic reference examples under `examples/`.

The following are internal unless a document explicitly says otherwise:

- `src/**` modules and their TypeScript import paths;
- daemon HTTP routes not listed in `docs/tools.md` or the browser UI contract;
- test helpers and fixtures;
- generated `dist/**` layout.

## Semver policy

- **Patch:** fixes that do not change documented commands, config keys, or output contracts.
- **Minor:** backward-compatible additions to the CLI, workflow manifests, or documented configuration.
- **Major:** removal or incompatible change to a documented command, config key, workflow manifest field, or output artifact contract.

Deprecated public behavior receives one minor-version warning window where
feasible. Experimental surfaces are labeled in docs and may change in a minor
release.

## Configuration and secrets

`.env.example` is the configuration schema reference. Secrets belong in the OS
credential store or a local gitignored `.env`; examples must never contain real
keys. Invalid or missing engagement-sensitive configuration must fail closed
with an actionable error naming the missing key.
