#!/usr/bin/env python3
"""One-time adoption of the known geekom source-build Hub; --check is the default.

Never runs the fresh installer over existing data. Does not print Docker inspect,
credentials, environment values, cookies, role mappings or container logs.
"""
import argparse
from contextlib import contextmanager, nullcontext
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import signal
import shutil
import sqlite3
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
from urllib.parse import urlsplit

PROJECT = "keryx-team-hub"
ORIGIN = "https://hub.mrciphersmith.com"
IMAGE = re.compile(r"ghcr\.io/mrciphersmith/keryx-team-hub@sha256:[a-f0-9]{64}")
VERSION = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+")
REQUIRED = ("hubctl", "VERSION", "compose.base.yaml", "compose.cloudflare.yaml",
            "compose.local.yaml", "compose.https.yaml", "compose.access.example.yaml",
            "Caddyfile.in", "edge.https.conf.in", "edge.cloudflare.conf.in", "tunnel.yml.in")
TERMINAL = {"succeeded", "failed", "cancelled", "rejected", "lost", "completed"}
_ADOPTION_TOKEN = None


class MigrationError(Exception):
    pass


def require(condition, message):
    if not condition:
        raise MigrationError(message)


def sha(path):
    result = hashlib.sha256()
    with path.open("rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def private_write(path, value, mode=0o600, hub_owner=False):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    path.write_bytes(value if isinstance(value, bytes) else value.encode())
    path.chmod(mode)
    if hub_owner and os.geteuid() == 0:
        os.chown(path.parent, 1000, 1000)
        os.chown(path, 1000, 1000)


def run(args, *, input=None, stdin=None, output=None, timeout=180, allow_failure=False):
    # No shell, no credential values in argv and no raw stderr in user-facing errors.
    try:
        child_env = None
        if _ADOPTION_TOKEN and Path(args[0]).name == "hubctl":
            child_env = dict(os.environ, KERYX_HUB_ADOPTION_TOKEN=_ADOPTION_TOKEN)
        result = subprocess.run(args, input=input, stdin=stdin, stdout=output or subprocess.PIPE,
                                stderr=subprocess.PIPE, timeout=timeout, check=False, env=child_env)
    except (OSError, subprocess.TimeoutExpired):
        raise MigrationError("A required migration operation could not complete") from None
    if result.returncode and not allow_failure:
        raise MigrationError("A required migration operation failed; production data was not removed")
    return result


def docker(*args, **kwargs):
    return run(["docker", *args], **kwargs)


def inspect_service(service):
    ids = docker("ps", "-aq", "--filter", f"label=com.docker.compose.project={PROJECT}",
                 "--filter", f"label=com.docker.compose.service={service}").stdout.decode().split()
    require(len(ids) == 1, f"Expected exactly one {service} container for the legacy project")
    info = json.loads(docker("inspect", ids[0]).stdout)[0]
    require(info["Config"]["Labels"].get("com.docker.compose.project") == PROJECT,
            "Unexpected Compose project")
    require(info["State"]["Running"], f"The legacy {service} container must be running")
    return info


def environment(info):
    return dict(value.split("=", 1) for value in info["Config"].get("Env", []) if "=" in value)


def source_for(info, target):
    matches = [mount for mount in info.get("Mounts", []) if mount["Type"] == "bind" and
               (target == mount["Destination"] or target.startswith(mount["Destination"].rstrip("/") + "/"))]
    require(len(matches) == 1, "Expected one explicit credential or Access bind mount")
    mount = matches[0]
    source = Path(mount["Source"]) / target[len(mount["Destination"]):].lstrip("/")
    require(source.is_file() and not source.is_symlink(), "An expected private configuration file is missing")
    return source.resolve(), mount


def trusted_source(path, directory=False, link=False):
    info = path.lstat()
    require(info.st_uid in {0, os.geteuid()}, "Run adoption as the installation owner; foreign-owned source is not trusted")
    if link:
        require(stat.S_ISLNK(info.st_mode), "Expected a current-release symlink")
    else:
        require((stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)) and
                not (info.st_mode & 0o022), "Installation source must be a non-writable regular file/directory, not a symlink")


def bind_installation(root, current, hub, tunnel, edge):
    root, current = root.resolve(), current.resolve()
    require(current.is_relative_to(root / "releases"), "Selected release is outside its installation")
    expected_base = (current / "deploy/team-hub/compose.yaml").resolve()
    expected_overlay = (current / "compose.geekom.yaml").resolve()
    for service, info in (("hub", hub), ("tunnel", tunnel), ("edge", edge)):
        labels = info.get("Config", {}).get("Labels", {})
        require(labels.get("com.docker.compose.project") == PROJECT and
                labels.get("com.docker.compose.service") == service,
                "The inspected service is not bound to the selected legacy installation")
        working = labels.get("com.docker.compose.project.working_dir", "")
        files = labels.get("com.docker.compose.project.config_files", "")
        require(working and Path(working).is_absolute() and Path(working).resolve() == current,
                "Compose working directory does not match the selected legacy root")
        require(files and all(value for value in files.split(",")), "Compose config-file identity is missing")
        resolved = []
        for value in files.split(","):
            path = Path(value)
            require(path.is_absolute() and path.resolve().is_relative_to(current),
                    "Compose config files do not belong to the selected legacy root")
            resolved.append(path.resolve())
        require(expected_base in resolved and expected_overlay in resolved,
                "Compose config files do not match the selected legacy deployment")


def configuration(hub, tunnel, edge=None):
    env = environment(hub)
    require(env.get("KERYX_HUB_PUBLIC_ORIGIN") == ORIGIN, "This helper only adopts the known geekom Hub origin")
    require(env.get("KERYX_HUB_ACCESS_ENABLED") == "true", "Existing Cloudflare SSO must be explicitly configured")
    issuer = env.get("KERYX_HUB_ACCESS_ISSUER", "")
    require(re.fullmatch(r"https://[a-z0-9-]+\.cloudflareaccess\.com", issuer), "Unexpected Access issuer")
    audience = env.get("KERYX_HUB_ACCESS_AUDIENCE", "")
    require(re.fullmatch(r"[a-f0-9]{64}", audience), "Unexpected Access audience")
    for key in ("KERYX_HUB_OPERATOR_TOKEN", "KERYX_HUB_AGENT_TOKEN"):
        require(len(env.get(key, "")) >= 32, "The existing bootstrap credential configuration is incomplete")
    require(all("\n" not in value and "\r" not in value for key, value in env.items()
                if key.startswith("KERYX_HUB_")), "Multiline legacy configuration requires manual adoption")
    volumes = [mount for mount in hub.get("Mounts", []) if mount["Destination"] == "/data"]
    require(len(volumes) == 1 and volumes[0]["Type"] == "volume" and
            volumes[0]["Name"] == f"{PROJECT}_hub-data", "Unexpected Hub data-volume identity")
    roles, role_mount = source_for(hub, env.get("KERYX_HUB_ACCESS_ROLES_FILE", ""))
    credentials, _ = source_for(tunnel, "/run/secrets/tunnel.json")
    tunnel_id = json.loads(credentials.read_bytes()).get("TunnelID", "")
    require(re.fullmatch(r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}", tunnel_id), "Unexpected tunnel credential identity")
    ports = hub.get("NetworkSettings", {}).get("Ports", {}).get("8787/tcp")
    require(ports and len(ports) == 1 and ports[0]["HostIp"] == "127.0.0.1" and
            ports[0]["HostPort"].isdigit(), "Hub recovery port must remain loopback-only")
    agent_file = env.get("KERYX_HUB_AGENT_CREDENTIALS_FILE")
    agents = source_for(hub, agent_file)[0] if agent_file else None
    edge_ports = []
    for binding in (edge or {}).get("NetworkSettings", {}).get("Ports", {}).get("8080/tcp") or []:
        require(binding["HostIp"] == "127.0.0.1" and binding["HostPort"].isdigit(), "Unexpected public edge port")
        edge_ports.append("127.0.0.1:" + binding["HostPort"] + ":8080")
    return {"env": env, "volume": volumes[0]["Name"], "roles": roles, "roleMount": role_mount,
            "tunnelFile": credentials, "tunnelId": tunnel_id, "agents": agents, "edgePorts": edge_ports,
            "port": ports[0]["HostPort"], "team": urlsplit(issuer).hostname.split(".")[0]}


def verified_bundle(artifacts, version, destination):
    require(VERSION.fullmatch(version), "A stable release version is required")
    checks = {}
    for line in (artifacts / "SHA256SUMS").read_text().splitlines():
        fields = line.split()
        if len(fields) == 2:
            checks[fields[1].lstrip("*")] = fields[0]
    for name in ("team-hub-install.tar.gz", "team-hub-image.txt"):
        require(re.fullmatch(r"[a-f0-9]{64}", checks.get(name, "")), "Release checksum entries are missing")
        require(sha(artifacts / name) == checks[name], "Release checksum mismatch")
    image = (artifacts / "team-hub-image.txt").read_text().strip()
    require(IMAGE.fullmatch(image), "The image must be the released Hub pinned by digest")
    with tarfile.open(artifacts / "team-hub-install.tar.gz") as archive:
        members = archive.getmembers()
        require(len(members) <= 128 and sum(member.size for member in members) <= 4 * 1024 * 1024,
                "Unexpected install bundle size")
        for member in members:
            parts = Path(member.name).parts
            require(parts and parts[0] == "team-hub-install" and ".." not in parts and
                    not Path(member.name).is_absolute() and (member.isfile() or member.isdir()),
                    "Unsafe install bundle member")
        archive.extractall(destination, filter="data")
    bundle = destination / "team-hub-install"
    require(all((bundle / name).is_file() for name in REQUIRED), "Incomplete install bundle")
    require((bundle / "VERSION").read_text().strip() == version, "Install bundle version mismatch")
    require("# keryx-hub-update-protocol: 1" in (bundle / "hubctl").read_text(), "Unsupported updater protocol")
    return bundle, image


def info_for(database):
    db = sqlite3.connect(f"file:{database}?mode=ro", uri=True)
    try:
        require(db.execute("PRAGMA integrity_check").fetchall() == [("ok",)], "SQLite integrity check failed")
        row = db.execute("SELECT body FROM hub_state WHERE id=1").fetchone()
        require(row is not None, "Existing Hub state is missing")
        body = json.loads(row[0])
        summary = {key: len(body.get(key, [])) for key in ("projects", "documents", "flows", "proposals", "events")}
        summary["stateDigest"] = hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        active = 0
        tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if "remote_run" in tables:
            active += sum(1 for (raw,) in db.execute("SELECT body FROM remote_run")
                          if not (value := json.loads(raw)).get("terminalAt") and value.get("state") not in TERMINAL)
        if "remote_queue" in tables:
            active += db.execute("SELECT count(*) FROM remote_queue").fetchone()[0]
        if "remote_command" in tables:
            active += db.execute("SELECT count(*) FROM remote_command WHERE COALESCE(json_extract(body,'$.capacityReleased'),0)=0 AND COALESCE(json_extract(body,'$.status'),'unknown') NOT IN ('applied','not-applied','rejected','expired-unconfirmed')").fetchone()[0]
        if "remote_session" in tables:
            active += sum(1 for (raw,) in db.execute("SELECT body FROM remote_session")
                          if json.loads(raw).get("pending") is not None)
        history = {}
        overall = hashlib.sha256()
        for table in sorted(name for name in tables if re.fullmatch(r"remote_[A-Za-z0-9_]+", name) and name != "remote_schema_version"):
            columns = [row[1] for row in db.execute(f'PRAGMA table_info("{table}")')]
            require(all(re.fullmatch(r"[A-Za-z0-9_]+", column) for column in columns), "Unexpected remote table schema")
            ordered = ",".join('"' + column + '"' for column in columns)
            digest = hashlib.sha256(json.dumps(columns, separators=(",", ":")).encode())
            count = 0
            for row in db.execute(f'SELECT {ordered} FROM "{table}" ORDER BY {ordered}'):
                # Runtime remote tables are text/integer metadata; no history is loaded as a full list.
                require(all(value is None or isinstance(value, (str, int, float)) for value in row), "Unexpected remote metadata value")
                digest.update(json.dumps(row, separators=(",", ":"), ensure_ascii=True).encode() + b"\n")
                count += 1
            history[table] = {"count": count, "digest": digest.hexdigest()}
            overall.update(json.dumps([table, count, digest.hexdigest()], separators=(",", ":")).encode() + b"\n")
        summary["remoteHistory"] = history
        summary["remoteHistoryDigest"] = overall.hexdigest()
        summary["unresolvedWork"] = active
        return summary
    finally:
        db.close()


def snapshot(container, path):
    size = int(docker("exec", container, "stat", "-c", "%s", "/data/hub.sqlite").stdout)
    require(size <= 64 * 1024 * 1024, "Database exceeds bounded online rehearsal size; use a separately planned offline migration")
    with path.open("wb") as output:
        docker("exec", container, "bun", "-e", 'import { Database } from "bun:sqlite";const db=new Database("/data/hub.sqlite",{readonly:true});process.stdout.write(db.serialize());db.close();', output=output)
    return info_for(path)


def volume_archive(volume, image, path):
    with path.open("wb") as output:
        docker("run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
               "--user", "1000:1000", "-v", f"{volume}:/data:ro", "--entrypoint", "tar", image,
               "-C", "/data", "-cf", "-", ".", output=output)
    path.chmod(0o600)
    private_write(path.with_suffix(path.suffix + ".sha256"), sha(path) + "  " + path.name + "\n")


def prepare(root, stage, bundle, version, image, config, enable_work):
    (stage / "releases").mkdir(parents=True)
    for name in ("hubctl",):
        private_write(stage / name, (bundle / name).read_bytes(), 0o755)
    values = {key: value for key, value in config["env"].items() if key.startswith("KERYX_HUB_")}
    values.update(KERYX_HUB_MODE="cloudflare", KERYX_HUB_PROJECT=PROJECT, HUB_DOMAIN=urlsplit(ORIGIN).hostname,
                  HUB_PORT=config["port"], CF_TUNNEL_ID=config["tunnelId"], CF_ACCESS_TEAM=config["team"],
                  CF_ACCESS_AUD=config["env"]["KERYX_HUB_ACCESS_AUDIENCE"], KERYX_HUB_AGENT_CREDENTIALS_FILE="/run/keryx-agents/agents.json")
    if enable_work:
        values["KERYX_HUB_WORK_ENABLED"] = "true"
    values.setdefault("KERYX_HUB_WORK_ENABLED", "false")
    values.setdefault("KERYX_HUB_WORK_REPOSITORIES", "[]")
    private_write(stage / "secrets/hub.env", "".join(f"{key}={value}\n" for key, value in sorted(values.items())))
    agents = config["agents"].read_bytes() if config["agents"] else b'{"agents":[]}\n'
    private_write(stage / "secrets/agents/agents.json", agents, hub_owner=True)
    private_write(stage / "secrets/tunnel.json", config["tunnelFile"].read_bytes(), 0o400, True)
    role_mount = config["roleMount"]
    override = {"services": {"hub": {"environment": {key: values[key] for key in (
        "KERYX_HUB_ACCESS_ENABLED", "KERYX_HUB_ACCESS_ISSUER", "KERYX_HUB_ACCESS_AUDIENCE", "KERYX_HUB_ACCESS_ROLES_FILE")},
        "volumes": [{"type": "bind", "source": role_mount["Source"], "target": role_mount["Destination"],
                     "read_only": True, "bind": {"create_host_path": False}}]}}}
    if config["edgePorts"]:
        override["services"]["edge"] = {"ports": config["edgePorts"]}
    private_write(stage / "compose.override.yaml", json.dumps(override))
    run([str(stage / "hubctl"), "_stage", str(bundle), version, image])
    (stage / "current").symlink_to(f"releases/v{version}")
    run([str(stage / "hubctl"), "_pull"], timeout=600)
    return values


def trial(workspace, image, archive, database, stage, config, expected):
    name = "keryx-legacy-trial-" + secrets.token_hex(6)
    volume = name + "-data"
    try:
        docker("volume", "create", volume)
        with archive.open("rb") as file:
            run(["docker", "run", "--rm", "--network", "none", "--user", "1000:1000", "-i", "-v", f"{volume}:/data",
                 "--entrypoint", "tar", image, "--no-overwrite-dir", "-C", "/data", "-xf", "-"], stdin=file)
        docker("run", "--rm", "--network", "none", "--user", "1000:1000", "-i", "-v", f"{volume}:/data", "--entrypoint", "sh", image,
               "-c", "cat > /data/hub.sqlite && rm -f /data/hub.sqlite-wal /data/hub.sqlite-shm", input=database.read_bytes())
        env = environment({"Config": {"Env": (stage / "secrets/hub.env").read_text().splitlines()}})
        for key in ("KERYX_HUB_OPERATOR_TOKEN", "KERYX_HUB_AGENT_TOKEN", "KERYX_HUB_REVIEWER_TOKEN"):
            env[key] = secrets.token_hex(32)
        env["KERYX_HUB_DATA_DIR"] = "/data"
        private_write(workspace / "trial.env", "".join(f"{key}={value}\n" for key, value in sorted(env.items())))
        mount = config["roleMount"]
        docker("run", "-d", "--name", name, "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
               "--user", "1000:1000", "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m", "--env-file", str(workspace / "trial.env"),
               "-v", f"{volume}:/data", "--mount", f'type=bind,source={stage / "secrets/agents"},target=/run/keryx-agents,readonly',
               "--mount", f'type=bind,source={mount["Source"]},target={mount["Destination"]},readonly', image)
        healthy = False
        for _ in range(60):
            result = docker("exec", name, "bun", "-e", 'const r=await fetch("http://127.0.0.1:8787/healthz");process.exit(r.ok?0:1)', allow_failure=True, timeout=10)
            if result.returncode == 0:
                healthy = True
                break
            time.sleep(1)
        require(healthy, "The new release did not pass isolated health validation")
        # Exercise old authenticated reads and the new write path only on this disposable copy.
        source_db = sqlite3.connect(f"file:{database}?mode=ro", uri=True)
        try:
            state = json.loads(source_db.execute("SELECT body FROM hub_state WHERE id=1").fetchone()[0])
        finally:
            source_db.close()
        projects = state.get("projects", [])
        require(isinstance(projects, list) and projects and isinstance(projects[0].get("id"), str), "No existing project is available for authenticated rehearsal")
        project = projects[0]["id"]
        require(len(project) <= 200, "Unsupported existing project identifier")
        probe = r'''const headers={Authorization:"Bearer "+process.env.KERYX_HUB_OPERATOR_TOKEN};
const base="http://127.0.0.1:8787";
const old=await fetch(base+"/hub/v1/projects",{headers});if(!old.ok)process.exit(1);
if(process.env.KERYX_HUB_WORK_ENABLED==="true"){
 const p=encodeURIComponent(PROJECT_ID);
 const caps=await fetch(base+"/hub/work/v1/projects/"+p+"/capabilities",{headers});
 if(!caps.ok || !(await caps.json()).enabled)process.exit(2);
 const body={operationId:"legacy-adoption-rehearsal",command:"flow.create",expectedVersions:{},payload:{title:"Legacy adoption rehearsal",problem:"Verify metadata retention",expectedOutcome:"Safe release adoption",scope:"Disposable copy only",outOfScope:"Production",ownerId:null,specification:null,criteria:[{criterionId:"c1",text:"Retained",waivable:false}]}};
 const write=await fetch(base+"/hub/work/v1/projects/"+p+"/commands",{method:"POST",headers:{...headers,"Content-Type":"application/json","Idempotency-Key":body.operationId},body:JSON.stringify(body)});
 if(!write.ok)process.exit(3);
}'''
        docker("exec", name, "bun", "-e", "const PROJECT_ID=" + json.dumps(project) + ";" + probe)
        after = snapshot(name, workspace / "trial.sqlite")
        require(after["stateDigest"] == expected["stateDigest"], "Legacy project/document/Flow state changed during rehearsal")
        require(after["remoteHistoryDigest"] == expected["remoteHistoryDigest"], "Remote machine/session/run history changed during rehearsal")
        return after
    finally:
        docker("rm", "-f", name, allow_failure=True)
        docker("volume", "rm", volume, allow_failure=True)


@contextmanager
def adoption_lock(root):
    global _ADOPTION_TOKEN
    state = root / "state"
    state.mkdir(mode=0o700, exist_ok=True)
    lock = state / "lock"
    marker = state / "legacy-adoption.lock"
    token_file = state / "legacy-adoption.token"
    try:
        lock.symlink_to(str(os.getpid()))
    except FileExistsError:
        raise MigrationError("Another adoption or hubctl operation/stale lock exists; inspect it first") from None
    marked = False
    token_written = False
    previous_token = _ADOPTION_TOKEN
    try:
        require(not marker.exists() and not marker.is_symlink() and not token_file.exists(),
                "A stale adoption delegation requires inspection")
        marker.symlink_to(str(os.getpid()))
        marked = True
        token = secrets.token_hex(32)
        private_write(token_file, token)
        token_written = True
        _ADOPTION_TOKEN = token
        yield
    finally:
        _ADOPTION_TOKEN = previous_token
        if token_written:
            token_file.unlink()
        if marked and marker.is_symlink() and os.readlink(marker) == str(os.getpid()):
            marker.unlink()
        if lock.is_symlink() and os.readlink(lock) == str(os.getpid()):
            lock.unlink()


def interrupted(_signum, _frame):
    raise MigrationError("Adoption interrupted")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path.home() / "keryx-team-hub")
    parser.add_argument("--artifacts", type=Path, required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--enable-work", action="store_true")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--check", action="store_true")
    mode.add_argument("--apply", action="store_true")
    parser.add_argument("--yes", action="store_true")
    args = parser.parse_args()
    require(not args.apply or args.yes, "Apply requires explicit --yes; otherwise run --check")
    require(os.geteuid() in (0, 1000), "Run as the existing geekom user (uid1000), or root")
    root = args.root.expanduser().resolve()
    require(re.fullmatch(r"/[A-Za-z0-9._/-]+", str(root)), "Unsupported installation path")
    require((root / "current").is_symlink() and (root / "hubctl").is_file(), "Expected legacy installation layout")
    trusted_source(root, directory=True)
    trusted_source(root / "releases", directory=True)
    trusted_source(root / "current", link=True)
    trusted_source(root / "hubctl")
    current = (root / "current").resolve()
    require(current.is_relative_to(root / "releases") and (current / "compose.geekom.yaml").is_file(), "Unexpected legacy release identity")
    trusted_source(current, directory=True)
    require("keryx-hub-update-protocol" not in (root / "hubctl").read_text(), "Already release-managed: use keryx hub update")
    require(not (root / "releases" / f"v{args.version}").exists(), "Target release directory already exists; inspect it before adopting")
    with adoption_lock(root) if args.apply else nullcontext():
        fingerprint = {"current": str(current), "hubctl": sha(root / "hubctl"), "env": sha(root / "secrets/hub.env")}
        hub, tunnel, edge = inspect_service("hub"), inspect_service("tunnel"), inspect_service("edge")
        bind_installation(root, current, hub, tunnel, edge)
        config = configuration(hub, tunnel, edge)
        require(hub["State"].get("Health", {}).get("Status") == "healthy", "The existing Hub must be healthy")
        with tempfile.TemporaryDirectory(prefix="keryx-legacy-adoption-") as temporary:
            workspace = Path(temporary)
            bundle, image = verified_bundle(args.artifacts.resolve(), args.version, workspace / "bundle")
            docker("pull", image, timeout=600)
            before = snapshot(hub["Id"], workspace / "before.sqlite")
            volume_archive(config["volume"], hub["Image"], workspace / "data.tar")
            stage = workspace / "stage"
            prepare(root, stage, bundle, args.version, image, config, args.enable_work)
            trial(workspace, image, workspace / "data.tar", workspace / "before.sqlite", stage, config, before)
            require(snapshot(hub["Id"], workspace / "unchanged.sqlite")["stateDigest"] == before["stateDigest"], "Production changed during rehearsal; rerun while quiet")
            require(inspect_service("hub")["Id"] == hub["Id"] and inspect_service("edge")["Id"] == edge["Id"] and
                    inspect_service("tunnel")["Id"] == tunnel["Id"] and (root / "current").resolve() == current and
                    sha(root / "hubctl") == fingerprint["hubctl"] and sha(root / "secrets/hub.env") == fingerprint["env"], "Original installation changed during rehearsal")
            report = {"result": "REHEARSAL_PASSED", "version": args.version, "image": image,
                      "unchangedProduction": True, "state": before, "mode": "apply" if args.apply else "check"}
            if not args.apply:
                print(json.dumps(report))
                return
            require(before["unresolvedWork"] == 0, "Active or unresolved work blocks adoption; finish/reconcile it first")
            # Rebind the global Compose project immediately before the first mutation.
            bind_installation(root, current, inspect_service("hub"), inspect_service("tunnel"), inspect_service("edge"))
            # The old tool is preserved and used only for its exact known Compose project.
            backup = root / "backups" / ("legacy-adoption-" + time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()))
            backup.mkdir(mode=0o700, parents=True, exist_ok=False)
            shutil.copy2(root / "hubctl", backup / "hubctl")
            shutil.copytree(root / "secrets", backup / "secrets", symlinks=True)
            if (root / "compose.override.yaml").exists():
                shutil.copy2(root / "compose.override.yaml", backup / "compose.override.yaml")
            private_write(backup / "original.json", json.dumps(fingerprint))
            private_write(backup / "access-roles.json", config["roles"].read_bytes())
            private_write(backup / "tunnel.json", config["tunnelFile"].read_bytes())
            if config["agents"]:
                private_write(backup / "agent-credentials.json", config["agents"].read_bytes())
            candidate_started = False
            try:
                run([str(root / "hubctl"), "stop", "edge", "tunnel"])
                require(snapshot(hub["Id"], workspace / "quiet.sqlite")["unresolvedWork"] == 0, "Work arrived before ingress stopped; adoption aborted")
                run([str(root / "hubctl"), "stop", "hub"])
                # No writer remains. Copy and validate the final exact database and full volume.
                volume_archive(config["volume"], hub["Image"], backup / "hub-data.tar")
                docker("run", "--rm", "--network", "none", "--user", "1000:1000", "-v", f'{config["volume"]}:/data:ro', "--entrypoint", "bun", hub["Image"],
                       "-e", 'import{Database}from"bun:sqlite";const db=new Database("/data/hub.sqlite",{readonly:true});process.stdout.write(db.serialize());db.close();',
                       output=(final := (backup / "hub.sqlite").open("wb")))
                final.close()
                final_info = info_for(backup / "hub.sqlite")
                require(final_info["unresolvedWork"] == 0, "Work raced with shutdown; original Hub will be resumed")
                trial(workspace, image, backup / "hub-data.tar", backup / "hub.sqlite", stage, config, final_info)
                shutil.copytree(stage / "releases" / f"v{args.version}", root / "releases" / f"v{args.version}")
                # Install-owned configuration, credentials and roles are preserved privately.
                for name in ("hubctl", "compose.override.yaml"):
                    shutil.copy2(stage / name, root / name)
                for name in ("hub.env", "agents/agents.json", "tunnel.json"):
                    source = stage / "secrets" / name
                    private_write(root / "secrets" / name, source.read_bytes(), source.stat().st_mode & 0o777, name != "hub.env")
                (root / "current.new").symlink_to(f"releases/v{args.version}")
                os.replace(root / "current.new", root / "current")
                candidate_started = True  # From this boundary no automatic database rewind is allowed.
                run([str(root / "hubctl"), "up", "hub"])
                # Only the Hub first; external ingress remains stopped until it passes health.
                new_hub = inspect_service("hub")
                for _ in range(90):
                    if docker("exec", new_hub["Id"], "bun", "-e", 'const r=await fetch("http://127.0.0.1:8787/healthz");process.exit(r.ok?0:1)', allow_failure=True).returncode == 0:
                        break
                    time.sleep(1)
                else:
                    raise MigrationError("New Hub health verification failed; retain latest data for a forward repair")
                live_info = snapshot(new_hub["Id"], workspace / "live.sqlite")
                require(live_info["stateDigest"] == final_info["stateDigest"] and live_info["remoteHistoryDigest"] == final_info["remoteHistoryDigest"], "Final legacy/remote metadata verification failed")
                run([str(root / "hubctl"), "up", "edge", "tunnel"])
                run([str(root / "hubctl"), "_wait", "180"], timeout=200)
                report.update(result="ADOPTED", backup=str(backup), finalState=final_info)
                private_write(backup / "receipt.json", json.dumps(report))
                print(json.dumps(report))
            except BaseException:
                if not candidate_started:
                    # Candidate never started: data is untouched, restore only the original config.
                    shutil.copy2(backup / "hubctl", root / "hubctl")
                    shutil.copytree(backup / "secrets", root / "secrets", dirs_exist_ok=True, symlinks=True)
                    if (backup / "compose.override.yaml").exists():
                        shutil.copy2(backup / "compose.override.yaml", root / "compose.override.yaml")
                    elif (root / "compose.override.yaml").exists():
                        (root / "compose.override.yaml").unlink()
                    (root / "current.recovery").symlink_to(current)
                    os.replace(root / "current.recovery", root / "current")
                    run([str(root / "hubctl"), "up", "-d"], allow_failure=True)
                else:
                    run([str(root / "hubctl"), "stop", "edge", "tunnel", "hub"], allow_failure=True)
                    print("Adoption stopped after candidate startup; latest data preserved. Forward repair required; backup: " + str(backup), file=sys.stderr)
                raise


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGHUP, interrupted)
    try:
        main()
    except MigrationError as error:
        print(str(error), file=sys.stderr)
        print("No production volume was deleted. Keep current data and any retained backup before retrying.", file=sys.stderr)
        sys.exit(1)
    except (OSError, ValueError, sqlite3.Error, tarfile.TarError, KeyboardInterrupt):
        # Raw exceptions may contain paths/configuration values; never print their repr.
        print("Legacy adoption did not complete. No production volume was deleted. Keep the current data and inspect the retained private backup before retrying.", file=sys.stderr)
        sys.exit(1)
