# SPDX-License-Identifier: AGPL-3.0-or-later
"""Integration tests for the tracked .githooks/ + bootstrap.sh.

These exercise the actual hook scripts inside a throwaway git
repo. We mock `uv` by putting a fake `uv` binary on PATH that
records its arguments to a file. The hook then thinks it's
reinstalling the CLI, but the test reads the recorded call to
verify the right arguments were passed.

What we cover:

- bootstrap.sh wires core.hooksPath to .githooks and runs
  `uv tool install` once.
- post-merge fires `uv tool install --reinstall` ONLY when files
  under apps/cli/ changed in the merge.
- post-checkout fires the same way on a branch switch that moves
  apps/cli/.
- A change outside apps/cli/ does NOT trigger a reinstall.
- Missing `uv` on PATH prints a warning but doesn't fail the
  surrounding git command.

We don't unit-test the bash itself — too much friction. The
integration suite is the right shape: real git, real hooks, fake
`uv`.
"""

from __future__ import annotations

import os
import shutil
import stat
import subprocess
from pathlib import Path

import pytest

# Path to the tracked hooks + bootstrap relative to the test file.
_REPO_ROOT = Path(__file__).resolve().parents[3]
_GITHOOKS = _REPO_ROOT / ".githooks"
_BOOTSTRAP = _REPO_ROOT / "scripts" / "bootstrap.sh"


def _git(repo: Path, *args: str) -> subprocess.CompletedProcess[str]:
    """Run git in ``repo`` and capture stdout/stderr as strings.
    Tests assert on returncode + captured streams."""
    return subprocess.run(
        ["git", *args],
        cwd=repo,
        capture_output=True,
        text=True,
        check=False,
    )


def _setup_fake_repo(tmp_path: Path) -> Path:
    """Make a throwaway repo with the tracked hooks + apps/cli/
    placeholder. The hooks expect `apps/cli/` to exist relative to
    the repo root, so we mirror that minimum."""
    repo = tmp_path / "fake-eidan"
    repo.mkdir()
    _git(repo, "init", "--initial-branch=main")
    _git(repo, "config", "user.email", "test@example.com")
    _git(repo, "config", "user.name", "Test")

    # Copy the tracked hooks into the fake repo.
    fake_hooks = repo / ".githooks"
    fake_hooks.mkdir()
    for hook in _GITHOOKS.iterdir():
        dest = fake_hooks / hook.name
        shutil.copy2(hook, dest)
        # `shutil.copy2` preserves mode on most platforms, but be
        # explicit so the test is robust to ::.
        dest.chmod(
            dest.stat().st_mode
            | stat.S_IXUSR
            | stat.S_IXGRP
            | stat.S_IXOTH
        )

    # apps/cli/ placeholder so the post-merge diff sees it.
    cli_dir = repo / "apps" / "cli"
    cli_dir.mkdir(parents=True)
    (cli_dir / "marker.txt").write_text("v1\n")
    (repo / "README.md").write_text("# fake\n")

    _git(repo, "add", ".")
    _git(repo, "commit", "-m", "initial")

    return repo


def _install_fake_uv(
    bin_dir: Path, *, record_to: Path, behaviour: str = "ok"
) -> dict[str, str]:
    """Place a fake `uv` script on a tmp PATH that records its argv
    to ``record_to``. ``behaviour`` controls exit:
    - "ok"  → exit 0
    - "fail" → exit 1 (simulates `uv tool install` failure)
    - "missing" → no script installed; caller verifies the hook's
      warning path.

    Returns the env dict to pass to subprocess so it picks up the
    fake PATH."""
    bin_dir.mkdir(parents=True, exist_ok=True)
    if behaviour != "missing":
        fake = bin_dir / "uv"
        exit_code = "0" if behaviour == "ok" else "1"
        fake.write_text(
            "#!/bin/bash\n"
            f'echo "$@" >> "{record_to}"\n'
            f"exit {exit_code}\n"
        )
        fake.chmod(0o755)

    # Path: only the fake bin + /usr/bin (for git itself).
    env = os.environ.copy()
    env["PATH"] = f"{bin_dir}:/usr/bin:/bin"
    return env


# ---------- post-merge --------------------------------------------------------


def test_post_merge_reinstalls_when_apps_cli_changed(tmp_path: Path) -> None:
    """A merge that touches apps/cli/ triggers `uv tool install
    --reinstall`. We simulate the merge by checking out a feature
    branch that bumps the CLI marker, then merging back to main."""
    repo = _setup_fake_repo(tmp_path)
    _git(repo, "config", "core.hooksPath", ".githooks")

    record = tmp_path / "uv-calls.txt"
    env = _install_fake_uv(tmp_path / "bin", record_to=record)

    # Make a CLI change on a feature branch.
    _git(repo, "checkout", "-b", "feat/cli-change")
    (repo / "apps" / "cli" / "marker.txt").write_text("v2\n")
    _git(repo, "commit", "-am", "bump cli marker")

    # Back to main + merge.
    _git(repo, "checkout", "main")
    subprocess.run(
        ["git", "merge", "--no-ff", "-m", "merge feat", "feat/cli-change"],
        cwd=repo,
        env=env,
        check=True,
        capture_output=True,
    )

    # uv was called once with the install arguments.
    assert record.exists(), "fake uv was never invoked"
    invocation = record.read_text(encoding="utf-8").strip()
    assert "tool install --reinstall --from" in invocation
    assert "apps/cli" in invocation
    assert invocation.endswith("eidan-cli")


def test_post_merge_skips_reinstall_when_apps_cli_untouched(
    tmp_path: Path,
) -> None:
    """A merge that doesn't touch apps/cli/ MUST NOT trigger a
    reinstall — operators don't want a 5-second pause on every
    pull of a backend / docs change."""
    repo = _setup_fake_repo(tmp_path)
    _git(repo, "config", "core.hooksPath", ".githooks")

    record = tmp_path / "uv-calls.txt"
    env = _install_fake_uv(tmp_path / "bin", record_to=record)

    # Change a non-CLI file on a feature branch.
    _git(repo, "checkout", "-b", "docs/typo")
    (repo / "README.md").write_text("# fake (typo fixed)\n")
    _git(repo, "commit", "-am", "doc tweak")

    _git(repo, "checkout", "main")
    subprocess.run(
        ["git", "merge", "--no-ff", "-m", "merge docs", "docs/typo"],
        cwd=repo,
        env=env,
        check=True,
        capture_output=True,
    )

    # Hook ran but skipped the install.
    assert not record.exists(), (
        f"uv should not be called for non-CLI merges, but got: "
        f"{record.read_text() if record.exists() else '<none>'}"
    )


def test_post_merge_warns_when_uv_missing_but_does_not_fail(
    tmp_path: Path,
) -> None:
    """If `uv` is not on PATH the hook should warn (stderr) and
    return 0 so the surrounding git command still succeeds.
    Operators on a fresh machine should not have their `git pull`
    blocked by a missing dev tool."""
    repo = _setup_fake_repo(tmp_path)
    _git(repo, "config", "core.hooksPath", ".githooks")

    record = tmp_path / "uv-calls.txt"
    env = _install_fake_uv(
        tmp_path / "bin", record_to=record, behaviour="missing"
    )

    _git(repo, "checkout", "-b", "feat/cli-change")
    (repo / "apps" / "cli" / "marker.txt").write_text("v2\n")
    _git(repo, "commit", "-am", "bump cli marker")

    _git(repo, "checkout", "main")
    result = subprocess.run(
        ["git", "merge", "--no-ff", "-m", "merge feat", "feat/cli-change"],
        cwd=repo,
        env=env,
        check=False,
        capture_output=True,
        text=True,
    )

    # Merge succeeded.
    assert result.returncode == 0, (
        f"git merge should succeed even when uv is missing; "
        f"stderr was:\n{result.stderr}"
    )
    # Hook printed its warning.
    assert "eidan-hook" in result.stderr
    assert "PATH" in result.stderr


# ---------- post-checkout -----------------------------------------------------


def test_post_checkout_reinstalls_when_branch_switch_changes_apps_cli(
    tmp_path: Path,
) -> None:
    """Switching branches forward to one that touches apps/cli/
    should reinstall too — the operator's eidan command now needs
    to match the new branch's source."""
    repo = _setup_fake_repo(tmp_path)
    _git(repo, "config", "core.hooksPath", ".githooks")

    record = tmp_path / "uv-calls.txt"
    env = _install_fake_uv(tmp_path / "bin", record_to=record)

    _git(repo, "checkout", "-b", "feat/cli-change")
    (repo / "apps" / "cli" / "marker.txt").write_text("v2\n")
    _git(repo, "commit", "-am", "bump cli marker")

    # Switch back to main (which doesn't have the CLI bump) → hook
    # diffs old_head (feat) vs new_head (main), sees the apps/cli
    # change, reinstalls.
    subprocess.run(
        ["git", "checkout", "main"],
        cwd=repo,
        env=env,
        check=True,
        capture_output=True,
    )

    assert record.exists(), "fake uv was never invoked on branch switch"
    invocation = record.read_text(encoding="utf-8").strip()
    assert "tool install --reinstall" in invocation


# ---------- bootstrap.sh ------------------------------------------------------


def test_bootstrap_wires_hookspath_and_runs_initial_install(
    tmp_path: Path,
) -> None:
    """`bootstrap.sh` is idempotent post-clone setup. It must (1)
    set core.hooksPath, (2) run `uv tool install` once. We run it
    inside a fake repo that also contains a copy of the script."""
    repo = _setup_fake_repo(tmp_path)

    # Copy the tracked bootstrap into the fake repo.
    bootstrap_dest = repo / "scripts" / "bootstrap.sh"
    bootstrap_dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(_BOOTSTRAP, bootstrap_dest)
    bootstrap_dest.chmod(0o755)

    record = tmp_path / "uv-calls.txt"
    env = _install_fake_uv(tmp_path / "bin", record_to=record)

    result = subprocess.run(
        ["./scripts/bootstrap.sh"],
        cwd=repo,
        env=env,
        check=False,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, (
        f"bootstrap failed:\nstdout={result.stdout}\nstderr={result.stderr}"
    )
    # hooksPath now points at .githooks.
    config = _git(repo, "config", "--get", "core.hooksPath")
    assert config.stdout.strip() == ".githooks"
    # uv was invoked with the install args.
    assert record.exists()
    invocation = record.read_text(encoding="utf-8").strip()
    assert "tool install --from" in invocation
    assert invocation.endswith("eidan-cli")


def test_bootstrap_fails_clearly_when_uv_missing(tmp_path: Path) -> None:
    """When `uv` is not on PATH, bootstrap.sh must fail loudly
    with a link to the installer rather than silently configuring
    half the setup."""
    repo = _setup_fake_repo(tmp_path)

    bootstrap_dest = repo / "scripts" / "bootstrap.sh"
    bootstrap_dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(_BOOTSTRAP, bootstrap_dest)
    bootstrap_dest.chmod(0o755)

    record = tmp_path / "uv-calls.txt"
    env = _install_fake_uv(
        tmp_path / "bin", record_to=record, behaviour="missing"
    )

    result = subprocess.run(
        ["./scripts/bootstrap.sh"],
        cwd=repo,
        env=env,
        check=False,
        capture_output=True,
        text=True,
    )

    assert result.returncode != 0
    assert "uv" in result.stderr
    assert "astral.sh" in result.stderr  # installer URL


@pytest.fixture(autouse=True)
def _skip_if_no_git() -> None:
    """Skip the whole file on systems without git on PATH (rare,
    but matters for clean CI containers)."""
    if shutil.which("git") is None:
        pytest.skip("git not on PATH")
