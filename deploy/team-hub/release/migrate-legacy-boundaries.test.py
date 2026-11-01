#!/usr/bin/env python3
"""Negative adoption contracts over disposable installations and databases."""
import importlib.util
from pathlib import Path
import io
import json
import os
import sqlite3
import subprocess
import tarfile
import unittest
from contextlib import contextmanager, ExitStack, nullcontext, redirect_stdout, redirect_stderr
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("adoption_fixtures", Path(__file__).with_name("migrate-legacy.test.py"))
fixtures = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixtures)
m = fixtures.m


class AdoptionBoundaries(fixtures.MigrationSafety):
    @contextmanager
    def apply_ports(self, fixture, **overrides):
        root, current, info, hub, config, calls, prepare, run, archive, trial = fixture
        values = {"trusted_source": lambda *a, **k: None, "bind_installation": lambda *a: None,
                  "configuration": lambda *a: config, "verified_bundle": lambda *a: (self.root, "new-image"),
                  "snapshot": lambda *a: dict(info), "info_for": lambda *a: dict(info),
                  "inspect_service": lambda name: {**hub, "Id": name}, "prepare": prepare,
                  "trial": lambda *a, **k: None, "volume_archive": archive,
                  "docker": lambda *a, **k: run(list(a), **k), "run": run,
                  "adoption_lock": lambda *a: nullcontext()}
        values.update(overrides)
        profile = self.root / "deployment-profile.json"
        profile.write_text(json.dumps({"composeProject":"keryx-team-hub","publicOrigin":"https://hub.mrciphersmith.com","imageRepository":"ghcr.io/mrciphersmith/keryx-team-hub","legacyOverlay":"compose.geekom.yaml"}))
        with ExitStack() as stack:
            for name, value in values.items():
                stack.enter_context(patch.object(m, name, value))
            stack.enter_context(patch.object(m.os, "geteuid", return_value=root.stat().st_uid))
            stack.enter_context(patch.object(m.sys, "argv", [str(fixtures.MODULE), "--deployment-profile", str(profile), "--root", str(root),
                "--artifacts", str(self.root), "--version", "0.4.4", "--apply", "--yes"]))
            yield

    def test_apply_fences_unresolved_work_before_stopping_services(self):
        fixture = self.apply_fixture()
        fixture[2]["unresolvedWork"] = 1
        with self.apply_ports(fixture), self.assertRaisesRegex(m.MigrationError, "Active or unresolved"):
            m.main()
        self.assertFalse(any("stop" in call for call in fixture[5]))
        self.assertEqual((fixture[0] / "current").resolve(), fixture[1].resolve())

    def test_apply_fingerprint_change_blocks_before_stopping_services(self):
        fixture = self.apply_fixture()
        def changed_trial(*args, **kwargs):
            (fixture[0] / "hubctl").write_text("changed externally")
        with self.apply_ports(fixture, trial=changed_trial), self.assertRaisesRegex(m.MigrationError, "installation changed"):
            m.main()
        self.assertFalse(any("stop" in call for call in fixture[5]))

    def test_apply_shutdown_work_race_resumes_original_installation(self):
        fixture = self.apply_fixture()
        count = 0
        def snapshot(*args):
            nonlocal count
            count += 1
            return {**fixture[2], "unresolvedWork": 1 if count == 3 else 0}
        with self.apply_ports(fixture, snapshot=snapshot), self.assertRaisesRegex(m.MigrationError, "Work arrived"):
            m.main()
        self.assertIn([str(fixture[0].resolve() / "hubctl"), "up", "-d"], fixture[5])
        self.assertEqual((fixture[0] / "current").resolve(), fixture[1].resolve())

    def test_apply_candidate_start_failure_never_rewinds_data_or_pointer(self):
        fixture = self.apply_fixture()
        def run(args, **kwargs):
            result = fixture[7](args, **kwargs)
            if args[-2:] == ["up", "hub"]:
                raise m.MigrationError("injected candidate start failure")
            return result
        with self.apply_ports(fixture, run=run), self.assertRaisesRegex(m.MigrationError, "candidate start"):
            m.main()
        self.assertEqual((fixture[0] / "current").resolve().name, "v0.4.4")
        self.assertIn([str(fixture[0].resolve() / "hubctl"), "stop", "edge", "tunnel", "hub"], fixture[5])
        self.assertNotIn([str(fixture[0].resolve() / "hubctl"), "up", "-d"], fixture[5])
        self.assertFalse(any("restore" in part or "rm" == part for call in fixture[5] for part in call))

    def test_apply_new_local_writes_keep_healthy_hub_running_for_manual_verification(self):
        fixture = self.apply_fixture()
        count = 0
        def snapshot(*args):
            nonlocal count
            count += 1
            return {**fixture[2], "stateDigest": "new-local-write" if count == 4 else "legacy"}
        output = io.StringIO()
        with self.apply_ports(fixture, snapshot=snapshot), redirect_stdout(output), redirect_stderr(io.StringIO()):
            m.main()
        self.assertEqual(json.loads(output.getvalue())["result"], "LIVE_METADATA_CHANGED_REVIEW_REQUIRED")
        self.assertNotIn([str(fixture[0].resolve() / "hubctl"), "stop", "edge", "tunnel", "hub"], fixture[5])
        self.assertNotIn([str(fixture[0].resolve() / "hubctl"), "up", "edge", "tunnel"], fixture[5])
        self.assertEqual((fixture[0] / "current").resolve().name, "v0.4.4")

    def test_snapshot_refuses_large_wal_before_serialization(self):
        calls = []
        def docker(*args, **kwargs):
            calls.append(args)
            return fixtures.SimpleNamespace(stdout=b"4096" if "stat" in args else str(64 * 1024 * 1024).encode())
        with patch.object(m, "docker", side_effect=docker), self.assertRaisesRegex(m.MigrationError, "plus WAL"):
            m.snapshot("fixture", self.root / "snapshot.sqlite")
        self.assertFalse(any("bun" in call for call in calls))
        self.assertFalse((self.root / "snapshot.sqlite").exists())

    def checksum(self, artifacts):
        (artifacts / "SHA256SUMS").write_text("".join(m.sha(artifacts / name) + "  " + name + "\n"
            for name in ("team-hub-install.tar.gz", "team-hub-image.txt")))

    def archive(self, artifacts, change):
        files = self.root / "bundle/team-hub-install"
        change(files)
        with tarfile.open(artifacts / "team-hub-install.tar.gz", "w:gz") as archive:
            archive.add(files, arcname="team-hub-install")
        self.checksum(artifacts)

    def test_correctly_checksummed_mutable_image_is_rejected_before_extract(self):
        artifacts = self.artifacts()
        (artifacts / "team-hub-image.txt").write_text("ghcr.io/mrciphersmith/keryx-team-hub:latest")
        self.checksum(artifacts)
        with self.assertRaisesRegex(m.MigrationError, "pinned"):
            m.verified_bundle(artifacts, "0.4.4", self.root / "extract")
        self.assertFalse((self.root / "extract").exists())

    def test_bundle_protocol_and_required_file_checks_are_reachable(self):
        artifacts = self.artifacts()
        for name, content, diagnostic in [("hubctl", "#!/bin/sh\n", "protocol"),
                                           ("VERSION", "0.4.5\n", "version mismatch")]:
            with self.subTest(name=name):
                original = (self.root / "bundle/team-hub-install" / name).read_bytes()
                self.archive(artifacts, lambda files: (files / name).write_text(content))
                with self.assertRaisesRegex(m.MigrationError, diagnostic):
                    m.verified_bundle(artifacts, "0.4.4", self.root / ("extract-" + name))
                (self.root / "bundle/team-hub-install" / name).write_bytes(original)
        self.archive(artifacts, lambda files: (files / "compose.base.yaml").unlink())
        with self.assertRaisesRegex(m.MigrationError, "Incomplete"):
            m.verified_bundle(artifacts, "0.4.4", self.root / "extract-missing")

    def test_bundle_rejects_traversal_links_member_and_byte_limits(self):
        artifacts = self.artifacts()
        for kind, diagnostic in [("traversal", "Unsafe"), ("symlink", "Unsafe"),
                                  ("members", "size"), ("bytes", "size")]:
            with self.subTest(kind=kind):
                with tarfile.open(artifacts / "team-hub-install.tar.gz", "w:gz") as archive:
                    if kind == "traversal":
                        member = tarfile.TarInfo("team-hub-install/../escape")
                        archive.addfile(member, io.BytesIO())
                    elif kind == "symlink":
                        member = tarfile.TarInfo("team-hub-install/link")
                        member.type = tarfile.SYMTYPE
                        member.linkname = "/etc/passwd"
                        archive.addfile(member)
                    else:
                        for number in range(129 if kind == "members" else 1):
                            member = tarfile.TarInfo("team-hub-install/file" + str(number))
                            data = b"x" * (4 * 1024 * 1024 + 1 if kind == "bytes" else 0)
                            member.size = len(data)
                            archive.addfile(member, io.BytesIO(data))
                self.checksum(artifacts)
                with self.assertRaisesRegex(m.MigrationError, diagnostic):
                    m.verified_bundle(artifacts, "0.4.4", self.root / ("extract-" + kind))
                self.assertFalse((self.root / ("extract-" + kind)).exists())

    def test_queue_and_command_capacity_each_block_rehearsal(self):
        path = self.root / "commands.sqlite"
        db = sqlite3.connect(path)
        db.executescript('CREATE TABLE hub_state(id INTEGER PRIMARY KEY,body TEXT);CREATE TABLE remote_queue(id TEXT);CREATE TABLE remote_command(id TEXT,body TEXT);')
        db.execute("INSERT INTO hub_state VALUES(1,'{}')")
        db.execute("INSERT INTO remote_queue VALUES('q')")
        db.commit()
        self.assertEqual(m.info_for(path)["unresolvedWork"], 1)
        db.execute("DELETE FROM remote_queue")
        for status, released, expected in [("admitted", False, 1), ("admitted", True, 0),
                                            ("unknown", False, 1), ("applied", False, 0)]:
            with self.subTest(status=status, released=released):
                db.execute("DELETE FROM remote_command")
                db.execute("INSERT INTO remote_command VALUES('c',?)", (json.dumps({"status": status, "capacityReleased": released}),))
                db.commit()
                self.assertEqual(m.info_for(path)["unresolvedWork"], expected)
        db.close()

    def test_configuration_rejects_each_identity_and_auth_gate(self):
        hub, tunnel = self.configuration()
        original = list(hub["Config"]["Env"])
        cases = [("KERYX_HUB_PUBLIC_ORIGIN", "https://other.example", "origin"),
                 ("KERYX_HUB_ACCESS_ENABLED", "false", "SSO"),
                 ("KERYX_HUB_ACCESS_ISSUER", "https://invalid.example", "issuer"),
                 ("KERYX_HUB_ACCESS_AUDIENCE", "bad", "audience"),
                 ("KERYX_HUB_OPERATOR_TOKEN", "short", "credential"),
                 ("KERYX_HUB_AGENT_TOKEN", "short", "credential"),
                 ("KERYX_HUB_WORK_REPOSITORIES", "one\ntwo", "Multiline")]
        for key, value, diagnostic in cases:
            with self.subTest(key=key):
                hub["Config"]["Env"] = [row for row in original if not row.startswith(key + "=")] + [key + "=" + value]
                with self.assertRaisesRegex(m.MigrationError, diagnostic):
                    m.configuration(hub, tunnel)
        hub["Config"]["Env"] = original
        edge = {"NetworkSettings": {"Ports": {"8080/tcp": [{"HostIp": "127.0.0.1", "HostPort": "8081"}]}}}
        self.assertEqual(m.configuration(hub, tunnel, edge)["edgePorts"], ["127.0.0.1:8081:8080"])
        edge["NetworkSettings"]["Ports"]["8080/tcp"][0]["HostIp"] = "0.0.0.0"
        with self.assertRaisesRegex(m.MigrationError, "public edge"):
            m.configuration(hub, tunnel, edge)
        (self.root / "tunnel.json").write_text(json.dumps({"TunnelID": "invalid"}))
        with self.assertRaisesRegex(m.MigrationError, "tunnel credential"):
            m.configuration(hub, tunnel)

    def test_lock_capability_rejects_bad_token_missing_token_pid_mismatch_and_grandchild(self):
        library = fixtures.re.sub(r'^main "\$@"\s*$', "", (m.Path(m.__file__).parent / "hubctl").read_text(), flags=fixtures.re.M)
        (self.root / "library.sh").write_text(library)
        helper = self.root / "hubctl"
        helper.write_text('#!/bin/sh\n. "$(dirname "$0")/library.sh"\nlock_try\n')
        helper.chmod(0o755)
        with m.adoption_lock(self.root):
            token = m._ADOPTION_TOKEN
            for supplied in ("wrong", ""):
                result = subprocess.run([str(helper)], env={**os.environ, "KERYX_HUB_ADOPTION_TOKEN": supplied}, capture_output=True)
                self.assertNotEqual(result.returncode, 0)
            token_file = self.root / "state/legacy-adoption.token"
            token_file.unlink()
            result = subprocess.run([str(helper)], env={**os.environ, "KERYX_HUB_ADOPTION_TOKEN": token}, capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            m.private_write(token_file, token)
            lock = self.root / "state/lock"
            lock.unlink(); lock.symlink_to("999999999")
            result = subprocess.run([str(helper)], env={**os.environ, "KERYX_HUB_ADOPTION_TOKEN": token}, capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            lock.unlink(); lock.symlink_to(str(os.getpid()))
            # A shell that waits after the call cannot optimize the grandchild into exec.
            result = subprocess.run(["sh", "-c", '"$1"; status=$?; exit "$status"', "child", str(helper)],
                                    env={**os.environ, "KERYX_HUB_ADOPTION_TOKEN": token}, capture_output=True)
            self.assertNotEqual(result.returncode, 0)
        self.assertIsNone(m._ADOPTION_TOKEN)
        for name in ("lock", "legacy-adoption.lock", "legacy-adoption.token"):
            path = self.root / "state" / name
            self.assertFalse(path.exists() or path.is_symlink())

    def test_stale_marker_refuses_without_removing_foreign_state(self):
        state = self.root / "state"; state.mkdir()
        marker = state / "legacy-adoption.lock"; marker.symlink_to("999999999")
        with self.assertRaisesRegex(m.MigrationError, "stale adoption"):
            with m.adoption_lock(self.root):
                self.fail("stale adoption entered")
        self.assertTrue(marker.is_symlink())
        self.assertFalse((state / "lock").is_symlink())
        self.assertIsNone(m._ADOPTION_TOKEN)


if __name__ == "__main__":
    unittest.main()
