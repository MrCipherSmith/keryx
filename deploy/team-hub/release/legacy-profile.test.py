#!/usr/bin/env python3
"""Generic legacy adoption profiles; no Docker or deployment mutations."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

MODULE = Path(__file__).resolve().parents[1] / "migrate-legacy.py"
spec = importlib.util.spec_from_file_location("hub_legacy_profiles", MODULE)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

class DeploymentProfiles(unittest.TestCase):
    def profile(self):
        return {"composeProject":"example-team","publicOrigin":"https://hub.example.org","imageRepository":"registry.example.org/acme/team-hub","legacyOverlay":"compose.legacy.yaml"}

    def test_generic_profile_has_no_personal_deployment_defaults(self):
        m.configure_deployment(self.profile())
        self.assertEqual(m.PROJECT,"example-team")
        self.assertEqual(m.ORIGIN,"https://hub.example.org")
        self.assertEqual(m.LEGACY_OVERLAY,"compose.legacy.yaml")
        self.assertTrue(m.IMAGE.fullmatch("registry.example.org/acme/team-hub@sha256:"+"a"*64))
        self.assertIsNone(m.IMAGE.fullmatch("ghcr.io/mrciphersmith/keryx-team-hub@sha256:"+"a"*64))

    def test_profile_is_closed_and_rejects_unsafe_identity_values(self):
        for patch in ({"extra":True},{"composeProject":"--foreign"},{"publicOrigin":"https://user:secret@hub.example.org"},{"publicOrigin":"http://hub.example.org"},{"publicOrigin":"https://hub.example.org/path"},{"imageRepository":"https://registry.example.org/acme/hub"},{"legacyOverlay":"../compose.yaml"}):
            with self.subTest(patch=patch), self.assertRaises(m.MigrationError):
                m.configure_deployment({**self.profile(),**patch})

    def test_profile_file_rejects_duplicate_fields(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/"profile.json"
            path.write_text(json.dumps(self.profile())[:-1]+',"composeProject":"other"}')
            with self.assertRaises(m.MigrationError):m.read_deployment_profile(path)

    def test_nonroot_caller_cannot_choose_a_foreign_owned_installation(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            argv=[str(MODULE),"--root",str(root),"--deployment-profile",str(root/"profile.json"),"--artifacts",str(root),"--version","0.4.4","--check"]
            with patch.object(m.os,"geteuid",return_value=root.stat().st_uid+1),patch.object(m.sys,"argv",argv):
                with self.assertRaisesRegex(m.MigrationError,"existing installation owner"):m.main()

    def test_operator_must_explicitly_select_profile_before_any_deployment_work(self):
        result=subprocess.run([sys.executable,str(MODULE),"--artifacts","/nonexistent","--version","0.4.4","--check"],capture_output=True,text=True)
        self.assertNotEqual(result.returncode,0)
        self.assertIn("--deployment-profile",result.stderr)

if __name__=="__main__":unittest.main()
