# One-time geekom Hub adoption
Version: 0.1.0

Status: helper implemented; owner executes the final production change after a successful rehearsal. No production adoption is implied by this document or its unit tests.

The current geekom Hub is a source-build installation under `/home/altsay/keryx-team-hub`. Its old `hubctl` is a Compose wrapper, so `keryx hub update` correctly refuses it. `migrate-legacy.py` from the verified install bundle converts this known installation once. It is deliberately restricted to the existing `keryx-team-hub` Compose project, its original named data volume, the `hub.mrciphersmith.com` origin and its configured Cloudflare SSO. It does not run the fresh installer, create a replacement production volume, rebuild source or regenerate credentials.

## Download the actual successor release

Run as `altsay` on geekom. Set `release` to the version whose release workflow completed successfully; do not use an unpublished version or replace an existing tag. The example assumes the planned successor0.4.4.

```sh
umask 077
release=0.4.4
mkdir -p "$HOME/keryx-hub-release-$release"
cd "$HOME/keryx-hub-release-$release"
base="https://github.com/MrCipherSmith/keryx/releases/download/v$release"
curl -fL --proto '=https' --proto-redir '=https' -O "$base/SHA256SUMS"
curl -fL --proto '=https' --proto-redir '=https' -O "$base/team-hub-install.tar.gz"
curl -fL --proto '=https' --proto-redir '=https' -O "$base/team-hub-image.txt"
sha256sum --check --ignore-missing SHA256SUMS
mkdir -p verified-install
tar -xzf team-hub-install.tar.gz -C verified-install --strip-components=1
```

The helper verifies the bundle and image checksums again, checks the stable version and requires the official Hub image pinned by SHA256 digest. No credentials are entered into a command or printed by it.

## Rehearse first

```sh
python3 verified-install/migrate-legacy.py \
  --artifacts "$PWD" --version "$release" --enable-work --check
```

The default is also `--check`; `--enable-work` applies to the copied trial configuration during rehearsal. It derives the actual running configuration privately, preserves role and agent mappings, pulls the released images, takes a consistent online SQLite image and copies the data to a disposable volume. The target runs with no network or published port. It checks database integrity, exact legacy Hub state, authenticated reads and an enabled Work write on the disposable copy. It then checks the original container identities, current pointer, Hub state and configuration hashes. Production is neither stopped nor updated.

A successful report contains `REHEARSAL_PASSED`, a pinned image and record counts. If production changes during rehearsal, rerun while quiet rather than ignoring the result. The bounded online rehearsal refuses databases over64MiB; larger installations need a separately planned offline procedure. Temporary trial data is removed; production data is never removed.

## Owner applies the change

Finish or reconcile all active/queued/unknown runs first. Allow a maintenance window: browsers and agents disconnect while the Hub is stopped. Then run the same verified helper explicitly:

```sh
python3 verified-install/migrate-legacy.py \
  --artifacts "$PWD" --version "$release" --enable-work --apply --yes
```

Apply repeats the rehearsal, takes an exclusive adoption lock, preserves original configuration/credentials/tooling, pauses edge/tunnel ingress, rechecks active work, stops the Hub and takes a final full-volume backup. It checks the stopped snapshot again and repeats the trial before switching. The new release keeps the original volume, credentials, recovery port and role mapping. It starts the Hub first, verifies retained state, then resumes ingress and checks the complete stack.

The private backup is under `~/keryx-team-hub/backups/legacy-adoption-<UTC timestamp>/`: original configuration, SQLite image, full volume tar and checksum, role/agent/tunnel configuration, original pointer and final receipt. Retain it. Before candidate startup a failure restores original configuration and resumes the legacy service on untouched data. After candidate startup a failure stops the candidate and preserves the latest data for a forward repair; it never automatically rewinds the database.

Open [the Hub](https://hub.mrciphersmith.com/), sign in through existing Cloudflare Access and inspect Keryx documents, existing Flows, machines and Work. New Work records do not convert old Flows automatically. Product acceptance remains a separate human action.

## Future updates

After successful adoption, use the new installed CLI on the Hub host:

```sh
keryx hub update --check
keryx hub update <next-version> --dry-run
keryx hub update <next-version>
```

The lower-level `~/keryx-team-hub/hubctl` remains available. The helper refuses a second adoption; upgrades now follow the release mechanism. After managed writes activate writer3, original writer2 binaries cannot read the current database: use a compatible release or forward fix. An explicit restore of older data is a separate decision and can discard newer work.
