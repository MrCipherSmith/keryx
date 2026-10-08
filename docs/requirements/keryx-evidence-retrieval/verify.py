"""Structure/JSON/ref checks only; no metaschema, payload or runtime validation."""
import json
import re
from pathlib import Path
ROOT = Path(__file__).resolve().parent
errors = []
def check(condition, message):
    if not condition:
        errors.append(message)
for name in ("README.md", "prd.md", "specification.md"):
    check((ROOT / name).is_file(), f"missing {name}")
readme = (ROOT / "README.md").read_text()
spec = (ROOT / "specification.md").read_text()
for file in sorted(ROOT.rglob("*")):
    if not file.is_file() or "__pycache__" in file.parts:
        continue
    relative = file.relative_to(ROOT).as_posix()
    if file.name != "README.md":
        check(f"]({relative})" in readme, f"README missing link: {relative}")
    if file.suffix == ".md":
        text = file.read_text()
        check(re.match(r"# [^\n]+\nVersion: \d+\.\d+\.\d+\n", text), f"Version: {relative}")
        for link in re.findall(r"\]\(([^)]+)\)", text):
            if "://" not in link and not link.startswith("#"):
                check((file.parent / link.split("#")[0]).is_file(), f"broken link: {relative}: {link}")
    if file.suffix == ".json":
        try:
            schema = json.loads(file.read_text())
            check(schema.get("$schema") == "https://json-schema.org/draft/2020-12/schema", f"dialect: {relative}")
            check(f"]({relative})" in spec, f"spec missing schema: {relative}")
            def refs(value):
                if isinstance(value, dict):
                    for key, child in value.items():
                        if key == "$ref":
                            target, _, pointer = child.partition("#")
                            doc = json.loads((file.parent / target).read_text()) if target else schema
                            for part in pointer.split("/")[1:]:
                                doc = doc[part.replace("~1", "/").replace("~0", "~")]
                        else:
                            refs(child)
                elif isinstance(value, list):
                    for child in value:
                        refs(child)
            refs(schema)
        except (ValueError, KeyError, TypeError, OSError) as exc:
            errors.append(f"JSON/ref: {relative}: {exc}")
prd = (ROOT / "prd.md").read_text()
requirements = re.findall(r"### (R\d+)[^\n]*\n(.*?)(?=\n### |\n## |\Z)", prd, re.S)
check(len(requirements) == 10, "expected R1-R10")
for name, body in requirements:
    check(re.search(r"Verification: (judged|(?:exec|invariant) `[^`]+`|none — .+)", body), f"Verification: {name}")
for heading in ("### Release criteria", "### Outcome criteria"):
    check(heading in prd, f"missing {heading}")
check("keryx-evidence-retrieval/README.md" in (ROOT.parent / "roadmap.md").read_text(), "roadmap link")
if errors:
    raise SystemExit("FAIL\n" + "\n".join(errors))
print("PASS: files, versions, links, JSON/schema refs, PRD fields, roadmap")
