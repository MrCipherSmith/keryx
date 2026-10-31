# React frontend deployment and rollback

Target: existing private test prototype on SSH host geekom, installation `/home/<user>/keryx-team-hub`, public hostname `https://hub.example.com/`. No new public port, DNS record, Access policy or application environment is required.

## Release procedure

1. Use an exact committed candidate. Run the isolated frontend checks, root/Hub checks and generated asset freshness. Never install frontend packages into the shared root node_modules target.
2. Generate the source archive directly from the committed runtime inputs, including the generated asset module, frontend production source/configuration/lockfile and build generator. Do not include node_modules, local environment files or test runtime data.
3. Create a new physical release folder with its own image tag. Preserve the current edge/tunnel, SSO issuer/audience and read-only role directory mount. Validate Compose without printing expanded secrets.
4. Take a consistent SQLite backup through VACUUM INTO and copy it through docker exec to a protected backup directory; verify quick_check=ok. Save the previous release, wrapper and deployment configuration.
5. Build the Linux candidate before activation. Run Hub tests in that actual image with read-only source tests, no network and an isolated temporary filesystem.
6. Atomically switch current, install the verified wrapper, and recreate only Hub/edge with no rebuild. Keep the system cloudflared service and unrelated applications unchanged.
7. Verify local health, SSO mode, preserved agent API, forged-JWT and invalid-Bearer denials, public anonymous Access interception, and actual browser SSO/RU/EN/navigation. Record the exact source commit, archive hash and configuration hashes without credentials.
8. Upload the exact candidate as a review-only bundle descending from the initial attempt, attach immutable self-reported Evidence and submit for review. The owner accepts the result.

## Rollback

The previous deployed SSO runtime already includes review-bundle safety guards. Restoring that previous release and its wrapper/configuration is a code/UI rollback without restoring the database or deleting later user work. Refresh the browser after a UI rollback. Keep Cloudflare Access and native tunnel JWT verification enabled. Do not downgrade to a pre-SSO/pre-bundle-guard runtime.

When only SSO needs recovery, the existing local/SSH Bearer recovery path remains available. Do not add a public Access bypass or loosen role-file permissions. The role file must remain readable by the runtime UID through its read-only directory mount.

## Development and packaging

See [frontend development instructions](../../../apps/hub-web/README.md) and [architecture](architecture.md). Vite development uses a local proxy and a matching backend public origin so Origin checks remain intact; production uses same-origin embedded assets.
