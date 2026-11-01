#!/bin/sh
# Build the Team Hub install bundle for a release.
#
#   sh deploy/team-hub/release/bundle.sh <out dir> <version>
#
# Writes into <out dir>:
#   team-hub-install.tar.gz   install.sh, hubctl, the compose overlays and config templates, VERSION
#   team-hub-install.sh       the same install.sh, standalone, so it can be fetched and checked on its own
#
# The bundle is what `install.sh` and `hubctl upgrade` download and verify. It is built from the
# checkout (the Hub's source archive deliberately carries no deployment tooling), and the
# release workflow and CI build it with this same script, so what CI checks is what ships.
# With GNU tar the archive is byte-for-byte reproducible for a given SOURCE_DATE_EPOCH.
set -eu

[ $# -eq 2 ] || { echo "usage: bundle.sh <out dir> <version>" >&2; exit 2; }
out=$1
version=$2
printf '%s' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$' || { echo "bundle: '$version' is not a version" >&2; exit 2; }

here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
deploy=$(CDPATH='' cd -- "$here/.." && pwd -P)
mkdir -p "$out"
out=$(CDPATH='' cd -- "$out" && pwd -P)

sh -n "$deploy/install.sh"
sh -n "$deploy/hubctl"

work=$(mktemp -d "${TMPDIR:-/tmp}/team-hub-bundle.XXXXXX")
trap 'rm -rf "$work"' EXIT
tree=$work/team-hub-install
mkdir "$tree"

cp "$deploy/install.sh" "$tree/install.sh"
cp "$deploy/hubctl" "$tree/hubctl"
cp "$deploy/migrate-legacy.py" "$tree/migrate-legacy.py"
chmod 755 "$tree/migrate-legacy.py"
chmod 755 "$tree/install.sh" "$tree/hubctl"
for f in compose.base.yaml compose.local.yaml compose.https.yaml compose.cloudflare.yaml compose.access.example.yaml \
  Caddyfile.in edge.https.conf.in edge.cloudflare.conf.in tunnel.yml.in hub.env.example; do
  cp "$deploy/selfhost/$f" "$tree/$f"
  chmod 644 "$tree/$f"
done
printf '%s\n' "$version" > "$tree/VERSION"
chmod 644 "$tree/VERSION"

epoch=${SOURCE_DATE_EPOCH:-0}
if tar --version 2>/dev/null | grep -q 'GNU tar'; then
  (cd "$work" && tar --sort=name --mtime="@$epoch" --owner=0 --group=0 --numeric-owner -cf - team-hub-install) | gzip -9n > "$out/team-hub-install.tar.gz"
else
  # bsdtar (macOS): not reproducible byte-for-byte, otherwise the same bundle.
  (cd "$work" && COPYFILE_DISABLE=1 tar -cf - team-hub-install) | gzip -9n > "$out/team-hub-install.tar.gz"
fi
cp "$deploy/install.sh" "$out/team-hub-install.sh"
chmod 755 "$out/team-hub-install.sh"
echo "bundle: $out/team-hub-install.tar.gz and $out/team-hub-install.sh (v$version)"
