#!/usr/bin/env python3
"""Bounded tests of the adoption safety boundaries; no Docker or production IO."""
import importlib.util
import json
import os
import re
from pathlib import Path
import sqlite3
import stat
import subprocess
import sys
import tarfile
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

MODULE = Path(__file__).resolve().parents[1] / "migrate-legacy.py"
spec = importlib.util.spec_from_file_location("hub_migrate_legacy", MODULE)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class MigrationSafety(unittest.TestCase):
    def setUp(self):
        m.SOURCE_OWNER = None
        m.configure_deployment({"composeProject":"keryx-team-hub","publicOrigin":"https://hub.mrciphersmith.com","imageRepository":"ghcr.io/mrciphersmith/keryx-team-hub","legacyOverlay":"compose.geekom.yaml"})
        self.temp = tempfile.TemporaryDirectory(prefix="hub-legacy-test-")
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def artifacts(self):
        files = self.root / "bundle/team-hub-install"
        files.mkdir(parents=True)
        for name in m.REQUIRED:
            (files / name).parent.mkdir(parents=True, exist_ok=True)
            (files / name).write_text("fixture\n")
        (files / "hubctl").write_text("#!/bin/sh\n# keryx-hub-update-protocol: 1\n")
        (files / "VERSION").write_text("0.4.4\n")
        artifacts = self.root / "artifacts"
        artifacts.mkdir()
        with tarfile.open(artifacts / "team-hub-install.tar.gz", "w:gz") as archive:
            archive.add(files, arcname="team-hub-install")
        (artifacts / "team-hub-image.txt").write_text("ghcr.io/mrciphersmith/keryx-team-hub@sha256:" + "a" * 64)
        (artifacts / "SHA256SUMS").write_text("".join(m.sha(artifacts / name) + "  " + name + "\n"
            for name in ("team-hub-install.tar.gz", "team-hub-image.txt")))
        return artifacts

    def configuration(self):
        roles = self.root / "roles"
        roles.mkdir()
        (roles / "roles.json").write_text('[{"email":"fixture@example.test","role":"operator"}]')
        creds = self.root / "tunnel.json"
        creds.write_text(json.dumps({"TunnelID": "00000000-0000-4000-8000-000000000000", "TunnelSecret": "synthetic-only"}))
        env = {"KERYX_HUB_PUBLIC_ORIGIN": m.ORIGIN, "KERYX_HUB_ACCESS_ENABLED": "true",
            "KERYX_HUB_ACCESS_ISSUER": "https://fixture.cloudflareaccess.com", "KERYX_HUB_ACCESS_AUDIENCE": "a" * 64,
            "KERYX_HUB_ACCESS_ROLES_FILE": "/run/access/roles.json", "KERYX_HUB_OPERATOR_TOKEN": "dummy-operator-" + "o" * 40,
            "KERYX_HUB_AGENT_TOKEN": "dummy-agent-" + "a" * 40}
        hub = {"Config": {"Env": [key + "=" + value for key, value in env.items()]},
            "Mounts": [{"Type": "volume", "Name": "keryx-team-hub_hub-data", "Destination": "/data"},
                {"Type": "bind", "Source": str(roles), "Destination": "/run/access"}],
            "NetworkSettings": {"Ports": {"8787/tcp": [{"HostIp": "127.0.0.1", "HostPort": "8787"}]}}}
        tunnel = {"Mounts": [{"Type": "bind", "Source": str(creds), "Destination": "/run/secrets/tunnel.json"}]}
        return hub, tunnel

    def apply_fixture(self):
        root = self.root / "install"
        current = root / "releases/legacy-source"
        current.mkdir(parents=True)
        (current / "compose.geekom.yaml").write_text("legacy")
        (root / "current").symlink_to("releases/legacy-source")
        (root / "hubctl").write_text("#!/bin/sh\nlegacy wrapper\n")
        (root / "hubctl").chmod(0o755)
        (root / "secrets").mkdir()
        (root / "secrets/hub.env").write_text("private fixture")
        (root / "secrets/tunnel.json").write_text("private tunnel")
        info = {"unresolvedWork": 0, "stateDigest": "legacy", "remoteHistoryDigest": "remote"}
        hub = {"Id": "hub", "Image": "old-image", "State": {"Health": {"Status": "healthy"}}}
        config = {"volume": "fixture-volume", "roles": root / "secrets/hub.env",
                  "tunnelFile": root / "secrets/tunnel.json", "agents": None}
        calls = []
        trial_calls = 0

        def prepare(*args, **kwargs):
            stage = next(value for value in args if isinstance(value, Path) and value.name == "stage")
            (stage / "releases/v0.4.4").mkdir(parents=True)
            (stage / "hubctl").write_text("candidate")
            (stage / "compose.override.yaml").write_text("candidate overlay")
            for name in ("hub.env", "agents/agents.json", "tunnel.json"):
                destination = stage / "secrets" / name
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_text("candidate private")

        def run(args, **kwargs):
            calls.append(args)
            output = kwargs.get("output")
            if output:
                output.write(b"fixture database")
            return SimpleNamespace(returncode=0, stdout=b"")

        def archive(volume, image, path):
            path.write_bytes(b"volume archive")

        def trial(*args, **kwargs):
            nonlocal trial_calls
            trial_calls += 1
            if trial_calls == 2:
                raise m.MigrationError("injected final trial failure")

        return root, current, info, hub, config, calls, prepare, run, archive, trial

    def test_apply_recovery_attempts_restart_even_if_a_restore_step_fails(self):
        root, current, info, hub, config, calls, prepare, run, archive, trial = self.apply_fixture()
        original_copytree = m.shutil.copytree

        def copytree(source, destination, *args, **kwargs):
            if kwargs.get("dirs_exist_ok"):
                raise PermissionError("private fixture: restore denied")
            return original_copytree(source, destination, *args, **kwargs)

        profile = self.root / "deployment-profile.json"
        profile.write_text(json.dumps({"composeProject":"keryx-team-hub","publicOrigin":"https://hub.mrciphersmith.com","imageRepository":"ghcr.io/mrciphersmith/keryx-team-hub","legacyOverlay":"compose.geekom.yaml"}))
        argv = [str(MODULE), "--deployment-profile", str(profile), "--root", str(root), "--artifacts", str(self.root), "--version", "0.4.4", "--apply", "--yes"]
        from contextlib import ExitStack, nullcontext
        with ExitStack() as stack:
            for target, value in [("trusted_source", lambda *a, **k: None), ("bind_installation", lambda *a: None),
                                  ("configuration", lambda *a: config), ("verified_bundle", lambda *a: (self.root, "new-image")),
                                  ("snapshot", lambda *a: dict(info)), ("info_for", lambda *a: dict(info)),
                                  ("inspect_service", lambda name: {**hub, "Id": name}), ("prepare", prepare),
                                  ("trial", trial), ("volume_archive", archive), ("docker", lambda *a, **k: run(list(a), **k)),
                                  ("run", run), ("adoption_lock", lambda *a: nullcontext())]:
                stack.enter_context(patch.object(m, target, value))
            stack.enter_context(patch.object(m.os, "geteuid", return_value=root.stat().st_uid))
            stack.enter_context(patch.object(m.sys, "argv", argv))
            stack.enter_context(patch.object(m.shutil, "copytree", side_effect=copytree))
            with self.assertRaises(Exception):
                m.main()
        self.assertIn([str(root.resolve() / "hubctl"), "up", "-d"], calls)
        self.assertEqual((root / "current").resolve(), current.resolve())

    def test_private_write_atomically_replaces_readonly_secret_with_private_mode(self):
        path = self.root / "private/credential"
        path.parent.mkdir()
        path.write_bytes(b"old")
        path.chmod(0o400)
        original_inode = path.stat().st_ino
        m.private_write(path, b"replacement", 0o400)
        self.assertEqual(path.read_bytes(), b"replacement")
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o400)
        self.assertNotEqual(path.stat().st_ino, original_inode)
        self.assertEqual(list(path.parent.iterdir()), [path])

    def test_release_checksum_and_pin_before_extraction(self):
        artifacts = self.artifacts()
        bundle, image = m.verified_bundle(artifacts, "0.4.4", self.root / "extract")
        self.assertEqual((bundle / "VERSION").read_text().strip(), "0.4.4")
        self.assertTrue(image.endswith("a" * 64))
        (artifacts / "team-hub-image.txt").write_text("ghcr.io/mrciphersmith/keryx-team-hub:latest")
        with self.assertRaisesRegex(m.MigrationError, "checksum"):
            m.verified_bundle(artifacts, "0.4.4", self.root / "never-extract")
        self.assertFalse((self.root / "never-extract").exists())

    def test_fixed_project_volume_origin_and_existing_sso(self):
        hub, tunnel = self.configuration()
        config = m.configuration(hub, tunnel)
        self.assertEqual(config["volume"], "keryx-team-hub_hub-data")
        self.assertEqual(config["team"], "fixture")
        hub["Mounts"][0]["Name"] = "some-other-project_hub-data"
        with self.assertRaisesRegex(m.MigrationError, "volume"):
            m.configuration(hub, tunnel)
        hub["Mounts"][0]["Name"] = "keryx-team-hub_hub-data"
        hub["NetworkSettings"]["Ports"]["8787/tcp"][0]["HostIp"] = "0.0.0.0"
        with self.assertRaisesRegex(m.MigrationError, "loopback"):
            m.configuration(hub, tunnel)

    def test_snapshot_integrity_semantics_and_unresolved_run(self):
        path = self.root / "hub.sqlite"
        db = sqlite3.connect(path)
        db.execute("CREATE TABLE hub_state(id INTEGER PRIMARY KEY,body TEXT)")
        body = {"projects": [{"id": "p"}], "documents": [{"id": "d"}], "flows": [], "proposals": [], "events": []}
        db.execute("INSERT INTO hub_state VALUES(1,?)", (json.dumps(body),))
        db.execute("CREATE TABLE remote_run(body TEXT)")
        db.execute("INSERT INTO remote_run VALUES(?)", (json.dumps({"state": "running"}),))
        db.commit()
        result = m.info_for(path)
        self.assertEqual((result["projects"], result["documents"], result["unresolvedWork"]), (1, 1, 1))
        db.execute("UPDATE remote_run SET body=?", (json.dumps({"state": "succeeded", "terminalAt": "done"}),))
        db.commit()
        self.assertEqual(m.info_for(path)["unresolvedWork"], 0)
        self.assertEqual(m.info_for(path)["stateDigest"], result["stateDigest"])
        db.close()

    def test_apply_requires_explicit_yes_before_any_docker_call(self):
        result = subprocess.run([sys.executable, str(MODULE), "--deployment-profile", str(self.root / "profile.json"), "--artifacts", str(self.root), "--version", "0.4.4", "--apply"], capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b"requires explicit --yes", result.stderr)
        self.assertEqual(result.stdout, b"")
        self.assertEqual(list(self.root.iterdir()), [])

    def test_adoption_lock_is_exclusive_and_removed_after_failure(self):
        with self.assertRaisesRegex(m.MigrationError, "another test failure"):
            with m.adoption_lock(self.root):
                self.assertEqual(os.readlink(self.root / "state/legacy-adoption.lock"), str(os.getpid()))
                with self.assertRaisesRegex(m.MigrationError, "Another adoption"):
                    with m.adoption_lock(self.root):
                        self.fail("A second adoption entered the maintenance window")
                raise m.MigrationError("another test failure")
        self.assertFalse((self.root / "state/legacy-adoption.lock").is_symlink())

    def test_shared_atomic_lock_rejects_normal_hubctl_but_delegates_exact_child(self):
        source = (MODULE.parent / "hubctl").read_text()
        library = re.sub(r'^main "\$@"\s*$', "", source, flags=re.M)
        (self.root / "library.sh").write_text(library)
        program = '#!/bin/sh\n. "$(dirname "$0")/library.sh"\nlock_try\n'
        (self.root / "probe.sh").write_text(program)
        (self.root / "hubctl").write_text(program)
        (self.root / "hubctl").chmod(0o755)
        with m.adoption_lock(self.root):
            self.assertEqual(os.readlink(self.root / "state/lock"), str(os.getpid()))
            blocked = subprocess.run(["sh", str(self.root / "probe.sh")], capture_output=True)
            self.assertNotEqual(blocked.returncode, 0)
            # Only the helper dispatcher passes the private delegation capability.
            self.assertEqual(m.run([str(self.root / "hubctl")]).returncode, 0)
            self.assertEqual(os.readlink(self.root / "state/lock"), str(os.getpid()))
        self.assertFalse((self.root / "state/lock").is_symlink())

    def test_pending_session_projection_blocks_even_after_applied_receipt(self):
        path = self.root / "pending.sqlite"
        db = sqlite3.connect(path)
        db.executescript('CREATE TABLE hub_state(id INTEGER PRIMARY KEY,body TEXT);CREATE TABLE remote_session(id TEXT,body TEXT);CREATE TABLE remote_command(id TEXT,body TEXT);')
        db.execute("INSERT INTO hub_state VALUES(1,?)", (json.dumps({"projects": [], "documents": [], "flows": []}),))
        db.execute("INSERT INTO remote_session VALUES(?,?)", ("s", json.dumps({"record": {"state": "idle"}, "pending": {"commandId": "c"}})))
        db.execute("INSERT INTO remote_command VALUES(?,?)", ("c", json.dumps({"status": "applied", "capacityReleased": False})))
        db.commit(); db.close()
        self.assertGreater(m.info_for(path)["unresolvedWork"], 0)

    def test_all_compose_services_bind_to_the_selected_tree(self):
        current = self.root / "releases/source"
        (current / "deploy/team-hub").mkdir(parents=True)
        files = [current / "deploy/team-hub/compose.yaml", current / "compose.geekom.yaml"]
        for file in files:
            file.write_text("synthetic")
        def info(service):
            return {"Config": {"Labels": {
                "com.docker.compose.project": m.PROJECT, "com.docker.compose.service": service,
                "com.docker.compose.project.working_dir": str(current),
                "com.docker.compose.project.config_files": ",".join(str(file) for file in files)}}}
        hub, tunnel, edge = info("hub"), info("tunnel"), info("edge")
        m.bind_installation(self.root, current, hub, tunnel, edge)
        edge["Config"]["Labels"]["com.docker.compose.project.working_dir"] = "/another/install/releases/source"
        with self.assertRaisesRegex(m.MigrationError, "working directory"):
            m.bind_installation(self.root, current, hub, tunnel, edge)
        edge = info("edge")
        edge["Config"]["Labels"]["com.docker.compose.project.config_files"] += ",/another/install/compose.yaml"
        with self.assertRaisesRegex(m.MigrationError, "config files"):
            m.bind_installation(self.root, current, hub, tunnel, edge)

    def test_privileged_invoker_refuses_foreign_owned_or_writable_source(self):
        info = SimpleNamespace(st_uid=1000, st_mode=stat.S_IFREG | 0o755)
        with patch.object(Path, "lstat", return_value=info), patch.object(m.os, "geteuid", return_value=0):
            with self.assertRaisesRegex(m.MigrationError, "installation owner"):
                m.trusted_source(self.root / "hubctl")
        with patch.object(Path, "lstat", return_value=info), patch.object(m.os, "geteuid", return_value=1000):
            m.trusted_source(self.root / "hubctl")
        for mode in (stat.S_IFREG | 0o777, stat.S_IFLNK | 0o777):
            with patch.object(Path, "lstat", return_value=SimpleNamespace(st_uid=os.geteuid(), st_mode=mode)):
                with self.assertRaisesRegex(m.MigrationError, "regular file/directory"):
                    m.trusted_source(self.root / "hubctl")

    def test_remote_history_rows_are_hashed_beyond_hub_state_and_writer_marker(self):
        path = self.root / "history.sqlite"
        db = sqlite3.connect(path)
        db.executescript('CREATE TABLE hub_state(id INTEGER PRIMARY KEY,body TEXT);CREATE TABLE remote_session(id TEXT,body TEXT);CREATE TABLE remote_schema_version(version INTEGER);')
        db.execute("INSERT INTO hub_state VALUES(1,?)", (json.dumps({"projects": [], "documents": [], "flows": []}),))
        db.execute("INSERT INTO remote_session VALUES(?,?)", ("s", json.dumps({"record": {"state": "idle"}, "pending": None})))
        db.execute("INSERT INTO remote_schema_version VALUES(2)")
        db.commit()
        before = m.info_for(path)
        db.execute("UPDATE remote_schema_version SET version=3"); db.commit()
        self.assertEqual(m.info_for(path)["remoteHistoryDigest"], before["remoteHistoryDigest"])
        db.execute("UPDATE remote_session SET body=?", (json.dumps({"record": {"state": "closed"}}),)); db.commit()
        changed = m.info_for(path)
        self.assertEqual(changed["stateDigest"], before["stateDigest"])
        self.assertNotEqual(changed["remoteHistoryDigest"], before["remoteHistoryDigest"])
        db.execute("DELETE FROM remote_session"); db.commit(); db.close()
        self.assertEqual(m.info_for(path)["remoteHistory"]["remote_session"]["count"], 0)


    def test_v4_artifact_hydration_and_retention_preserve_verified_history_digest(self):
        import base64
        import hashlib
        contents = b"accepted immutable bytes"
        digest = hashlib.sha256(contents).hexdigest()
        encoded = base64.b64encode(contents).decode()
        revision = {"id": "r", "projectId": "p", "files": [{"path": "a", "mode": "100644", "contentDigest": digest, "contentBase64": encoded}]}
        def document(version):
            content = "version " + str(version)
            return {"id": "d", "projectId": "p", "path": "wiki.md", "kind": "wiki", "version": version, "content": content, "contentDigest": hashlib.sha256(content.encode()).hexdigest()}
        changes = [{"projectId": "p", "revision": version, "document": document(version)} for version in range(1, 5002)]
        body = {"projects": [{"id": "p"}], "documents": [document(5001)], "flows": [{"id": "f", "status": "done", "acceptedBy": "human"}], "proposals": [], "events": [], "documentChanges": changes, "revisions": [revision], "replays": {"operation": {"digest": "request", "status": 200, "body": revision}}}
        old_path = self.root / "old.sqlite"
        old = sqlite3.connect(old_path)
        old.execute("CREATE TABLE hub_state(id INTEGER PRIMARY KEY,body TEXT)")
        old.execute("INSERT INTO hub_state VALUES(1,?)", (json.dumps(body),)); old.commit(); old.close()
        before = m.info_for(old_path)
        candidate_path = self.root / "candidate.sqlite"
        candidate = sqlite3.connect(candidate_path)
        candidate.executescript("CREATE TABLE hub_state(id INTEGER PRIMARY KEY,body TEXT);CREATE TABLE hub_revision_blobs(digest TEXT PRIMARY KEY,content_base64 TEXT);CREATE TABLE hub_work_documents(body TEXT)")
        normalized = json.loads(json.dumps(body))
        normalized["revisions"][0]["files"][0].pop("contentBase64")
        normalized["revisions"][0]["files"][0]["blobDigest"] = hashlib.sha256(encoded.encode()).hexdigest()
        normalized["replays"]["operation"] = {"digest": "request", "status": 200, "revisionId": "r"}
        normalized["documentChanges"] = normalized["documentChanges"][-5000:]
        candidate.execute("INSERT INTO hub_state VALUES(1,?)", (json.dumps(normalized),))
        candidate.execute("INSERT INTO hub_revision_blobs VALUES(?,?)", (hashlib.sha256(encoded.encode()).hexdigest(), encoded))
        candidate.executemany("INSERT INTO hub_work_documents VALUES(?)", ((json.dumps(change["document"]),) for change in changes)); candidate.commit()
        self.assertEqual(m.info_for(candidate_path)["stateDigest"], before["stateDigest"])
        candidate.execute("DELETE FROM hub_work_documents WHERE json_extract(body,'$.version')=1"); candidate.commit()
        self.assertNotEqual(m.info_for(candidate_path)["stateDigest"], before["stateDigest"])
        candidate.execute("UPDATE hub_revision_blobs SET content_base64=?", (base64.b64encode(b"tampered").decode(),)); candidate.commit()
        with self.assertRaisesRegex(m.MigrationError, "(?:blob|encoding) digest mismatch"):
            m.info_for(candidate_path)
        candidate.close()


if __name__ == "__main__":
    unittest.main()
