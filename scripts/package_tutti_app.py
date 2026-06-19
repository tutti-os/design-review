#!/usr/bin/env python3
"""Assemble the publishable Tutti app package for design-review.

The repository root is the *development* tree (it also carries tests, CI config,
local scratch, and these build scripts). This script produces the immutable,
publishable package under ``build/tutti-app/package`` containing only the files
Tutti ships and runs, then validates it with the vendored factory validator.

It is the app's ``package:tutti`` step: the GitHub release workflow points
``package_command`` at it and uploads ``package_dir`` (``build/tutti-app/package``).

Usage:
    python3 scripts/package_tutti_app.py [--out build/tutti-app/package]
"""

from __future__ import annotations

import argparse
import json
import shutil
import stat
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SCRIPTS_DIR = Path(__file__).resolve().parent
DEFAULT_OUT = REPO_ROOT / "build" / "tutti-app" / "package"

# Files and directories that make up the published package. Everything else in
# the repo (server_test.py, scripts/, .github/, .claude/, build/, caches) stays
# in the dev tree and is intentionally excluded.
PACKAGE_FILES = [
    "tutti.app.json",
    "tutti.cli.json",
    "COMMANDS.md",
    "AGENTS.md",
    "bootstrap.sh",
    "icon.svg",
    "server.py",
]
PACKAGE_DIRS = ["static", "locales"]

# Never copy these into the package, even if they appear inside a packaged dir.
IGNORED_NAMES = {"__pycache__", ".DS_Store", "Thumbs.db"}
IGNORED_SUFFIXES = {".pyc", ".pyo", ".log"}


def fail(message: str) -> "NoReturn":  # type: ignore[name-defined]
    print(f"package-tutti-app: {message}", file=sys.stderr)
    raise SystemExit(1)


def reject_symlinks(source: Path) -> None:
    """Refuse to package symlinks (they would escape the immutable package)."""
    if source.is_symlink():
        fail(f"refusing to package symlink: {source.relative_to(REPO_ROOT)}")
    if source.is_dir():
        for child in source.rglob("*"):
            if child.is_symlink():
                fail(f"refusing to package symlink: {child.relative_to(REPO_ROOT)}")


def _ignore(_dir: str, names: list[str]) -> set[str]:
    ignored = set()
    for name in names:
        if name in IGNORED_NAMES or Path(name).suffix in IGNORED_SUFFIXES:
            ignored.add(name)
    return ignored


def assemble(out_dir: Path) -> None:
    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    missing = [name for name in PACKAGE_FILES if not (REPO_ROOT / name).is_file()]
    missing += [name for name in PACKAGE_DIRS if not (REPO_ROOT / name).is_dir()]
    if missing:
        fail("missing required package entries: " + ", ".join(sorted(missing)))

    for name in PACKAGE_FILES:
        source = REPO_ROOT / name
        reject_symlinks(source)
        shutil.copy2(source, out_dir / name)  # copy2 preserves the +x bit

    for name in PACKAGE_DIRS:
        source = REPO_ROOT / name
        reject_symlinks(source)
        shutil.copytree(source, out_dir / name, ignore=_ignore)

    # bootstrap.sh must stay executable inside the package.
    bootstrap = out_dir / "bootstrap.sh"
    bootstrap.chmod(bootstrap.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def check_manifest_links(out_dir: Path) -> None:
    """Confirm manifest/CLI-manifest referenced files landed in the package."""
    manifest = json.loads((out_dir / "tutti.app.json").read_text(encoding="utf-8"))

    icon_src = (manifest.get("icon") or {}).get("src")
    if icon_src and not (out_dir / icon_src).is_file():
        fail(f"manifest icon missing from package: {icon_src}")

    cli = manifest.get("cli") or {}
    cli_manifest_path = cli.get("manifest")
    if cli_manifest_path:
        cli_manifest_file = out_dir / cli_manifest_path
        if not cli_manifest_file.is_file():
            fail(f"cli.manifest missing from package: {cli_manifest_path}")
        cli_manifest = json.loads(cli_manifest_file.read_text(encoding="utf-8"))
        doc = (cli_manifest.get("documentation") or {}).get("file")
        if doc and not (out_dir / doc).is_file():
            fail(f"CLI documentation file missing from package: {doc}")

    for entry in (manifest.get("localizationInfo") or {}).get("additionalLocales", []):
        locale_file = entry.get("file")
        if locale_file and not (out_dir / locale_file).is_file():
            fail(f"localization file missing from package: {locale_file}")


def validate(out_dir: Path) -> None:
    validator = SCRIPTS_DIR / "validate_tutti_app_package.py"
    result = subprocess.run([sys.executable, str(validator), str(out_dir)])
    if result.returncode != 0:
        fail("package failed validation (see errors above)")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", default=str(DEFAULT_OUT), help="package output directory")
    args = parser.parse_args()

    out_dir = Path(args.out).resolve()
    assemble(out_dir)
    check_manifest_links(out_dir)
    validate(out_dir)

    file_count = sum(1 for path in out_dir.rglob("*") if path.is_file())
    print(f"Packaged Tutti app -> {out_dir} ({file_count} files)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
