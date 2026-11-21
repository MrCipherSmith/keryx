"""Run one Flow 511 acceptance criterion from the repository root."""

import argparse
import subprocess
import sys
import tempfile
from pathlib import Path
from xml.etree import ElementTree


SUITES = {
    "board": (1, 2, 3, 5, 6),
    "launch": (7, 8, 9, 10, 11, 12),
    "projects": (13, 14),
}
CASES = {
    f"AC{number}": Path(f"src/integrations/issues-{suite}.test.ts")
    for suite, numbers in SUITES.items()
    for number in numbers
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("criterion", choices=CASES)
    criterion = parser.parse_args().criterion
    suite = CASES[criterion]
    if not suite.is_file():
        sys.exit(f"{criterion}: missing T12 acceptance suite {suite}")
    with tempfile.TemporaryDirectory() as tmp:
        report = Path(tmp) / "results.xml"
        subprocess.run(
            ["bun", "test", f"./{suite}", "--reporter=junit", f"--reporter-outfile={report}"],
            check=True,
        )
        cases = [
            case for case in ElementTree.parse(report).iter("testcase")
            if case.get("name", "").startswith(criterion + " ")
        ]
        if not cases:
            sys.exit(f"{criterion}: no named scenario in the JUnit report")
        for case in cases:
            if any(case.find(tag) is not None for tag in ("skipped", "failure", "error")):
                sys.exit(f"{criterion}: scenario did not pass: {case.get('name')}")
        print(f"{criterion}: {len(cases)} passing scenarios")


if __name__ == "__main__":
    main()
