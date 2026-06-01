# SPDX-License-Identifier: AGPL-3.0-or-later
"""Tests for the bundle-freshness audit.

Two layers covered:

- ``build_context.bundle_health`` against a real throwaway git
  repo we mutate into each branch / dirty / behind state. Real
  git is the simplest way to test git-shape logic; mocking
  ``subprocess.run`` for every git invocation would be longer
  AND less honest.
- ``deploy._audit_bundles_or_abort`` against a stub node, with
  the env-var override / TTY-detection / interactive-prompt
  branches exercised via monkeypatch.

We skip the whole file when ``git`` isn't on PATH (same shape
as ``test_githooks.py``).
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest
from eidan_cli import build_context, deploy


@pytest.fixture(autouse=True)
def _skip_if_no_git() -> None:
    if shutil.which("git") is None:
        pytest.skip("git not on PATH")


def _git(cwd: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *args],
        cwd=cwd,
        capture_output=True,
        text=True,
        check=False,
    )


def _setup_clean_repo(repo: Path) -> None:
    """Bring `repo` into a state that bundle_health considers clean:
    initialized, on `main`, working tree empty, "origin" pointing
    at a sibling bare repo so the fetch + behind-check are
    meaningful."""
    repo.mkdir(parents=True, exist_ok=True)
    _git(repo, "init", "--initial-branch=main")
    _git(repo, "config", "user.email", "test@example.com")
    _git(repo, "config", "user.name", "Test")
    (repo / "plugin.yaml").write_text("schema: 1\n")
    _git(repo, "add", ".")
    _git(repo, "commit", "-m", "initial")
    # Sibling bare repo as "origin" so the behind-check has a
    # real remote ref to compare against.
    bare = repo.parent / f"{repo.name}.bare.git"
    _git(repo, "clone", "--bare", str(repo), str(bare))
    _git(repo, "remote", "add", "origin", str(bare))
    _git(repo, "fetch", "origin")
    _git(repo, "branch", "--set-upstream-to=origin/main", "main")


# ---------- bundle_health ----------------------------------------------------


def test_bundle_health_clean_main_repo_reports_clean(tmp_path: Path) -> None:
    repo = tmp_path / "eidan-pro"
    _setup_clean_repo(repo)

    health = build_context.bundle_health("eidan-pro", repo)

    assert health.is_git_repo
    assert health.branch == "main"
    assert not health.is_dirty
    assert not health.is_behind_origin
    assert health.is_clean
    assert health.problems == []


def test_bundle_health_non_git_dir_is_not_clean(tmp_path: Path) -> None:
    """A bundle dir that exists but isn't a git repo can't be
    audited. We treat it as 'not clean' so the operator
    explicitly opts in via the env-var override."""
    repo = tmp_path / "bundle-without-git"
    repo.mkdir()
    (repo / "plugin.yaml").write_text("schema: 1\n")

    health = build_context.bundle_health("bundle-without-git", repo)

    assert not health.is_git_repo
    assert not health.is_clean
    assert "not a git repo" in " ".join(health.problems)


def test_bundle_health_non_main_branch_flagged(tmp_path: Path) -> None:
    """A bundle checked out on a feature branch fails the audit
    even when the working tree is clean. Operators routinely
    forget they switched branches; the audit catches the silent
    'wrong code shipped' case."""
    repo = tmp_path / "eidan-pro"
    _setup_clean_repo(repo)
    _git(repo, "checkout", "-b", "feat/wip")

    health = build_context.bundle_health("eidan-pro", repo)

    assert health.branch == "feat/wip"
    assert not health.is_clean
    assert any("feat/wip" in p for p in health.problems)


def test_bundle_health_dirty_tree_flagged(tmp_path: Path) -> None:
    """Uncommitted changes mean the operator either forgot to
    commit or is testing local edits — either way they should
    confirm before baking into a deployed image."""
    repo = tmp_path / "eidan-pro"
    _setup_clean_repo(repo)
    (repo / "plugin.yaml").write_text("schema: 1\n# tweak\n")

    health = build_context.bundle_health("eidan-pro", repo)

    assert health.is_dirty
    assert not health.is_clean
    assert "plugin.yaml" in " ".join(health.dirty_files)


def test_bundle_health_behind_origin_flagged(tmp_path: Path) -> None:
    """When origin has commits we don't, the audit nudges
    operator to pull. Silent 'older code shipped' is the kind
    of thing that wastes a debugging hour later."""
    repo = tmp_path / "eidan-pro"
    _setup_clean_repo(repo)
    # Land a new commit on the bare 'origin' via a sibling clone.
    other = tmp_path / "eidan-pro-other"
    bare = tmp_path / "eidan-pro.bare.git"
    _git(tmp_path, "clone", str(bare), str(other))
    _git(other, "config", "user.email", "test@example.com")
    _git(other, "config", "user.name", "Test")
    (other / "new.txt").write_text("hello\n")
    _git(other, "add", ".")
    _git(other, "commit", "-m", "new commit on origin")
    _git(other, "push", "origin", "main")

    # Local `repo` is now behind. bundle_health runs `git fetch`
    # internally, so the behind-check picks up the new commit.
    health = build_context.bundle_health("eidan-pro", repo)

    assert health.is_behind_origin
    assert not health.is_clean
    assert any("behind origin" in p for p in health.problems)


# ---------- audit_bundles ----------------------------------------------------


class _NodeStub:
    """Mimics ResolvedNode's `.bundles` shape for the audit. The
    audit only reads `.bundles`, so a plain attrs-holder is
    enough — we don't import the Pydantic model."""

    def __init__(self, bundles: list[Any]) -> None:
        self.bundles = bundles


def test_audit_bundles_skips_missing_dirs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A bundle declared in topology but not cloned locally is
    silently skipped by the audit — `assemble_build_context`
    raises a better error against the same case later."""
    monkeypatch.setenv("EIDAN_BUNDLE_ROOT", str(tmp_path))
    node = _NodeStub(["never-cloned-locally"])

    results = build_context.audit_bundles(node, eidan_dir=tmp_path / "eidan")

    assert results == []


def test_audit_bundles_returns_health_per_declared_bundle(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("EIDAN_BUNDLE_ROOT", str(tmp_path))
    _setup_clean_repo(tmp_path / "eidan-pro")
    _setup_clean_repo(tmp_path / "eidan-sage")
    node = _NodeStub(["eidan-pro", "eidan-sage"])

    results = build_context.audit_bundles(node, eidan_dir=tmp_path / "eidan")

    assert [h.name for h in results] == ["eidan-pro", "eidan-sage"]
    assert all(h.is_clean for h in results)


# ---------- deploy._audit_bundles_or_abort ----------------------------------


def test_audit_returns_zero_when_no_bundles(monkeypatch: pytest.MonkeyPatch) -> None:
    """No bundles declared anywhere → audit is a no-op. We
    short-circuit BEFORE resolving the eidan dir so a non-bundle
    deploy doesn't need EIDAN_SOURCE_DIR set."""
    node = _NodeStub([])

    code = deploy._audit_bundles_or_abort([node])

    assert code == 0


def test_audit_honours_env_var_override(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """EIDAN_ALLOW_DIRTY_BUNDLES=1 lets CI / scripted re-deploys
    skip the prompt without changing the audit's findings. The
    issues still print so the operator sees what was overridden."""
    monkeypatch.setenv("EIDAN_BUNDLE_ROOT", str(tmp_path))
    monkeypatch.setenv("EIDAN_SOURCE_DIR", str(tmp_path / "eidan"))
    monkeypatch.setenv("EIDAN_ALLOW_DIRTY_BUNDLES", "1")

    repo = tmp_path / "eidan-pro"
    _setup_clean_repo(repo)
    _git(repo, "checkout", "-b", "feat/wip")  # → audit issue

    code = deploy._audit_bundles_or_abort([_NodeStub(["eidan-pro"])])

    assert code == 0


def test_audit_fails_in_non_tty_without_override(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """CI / piped runs without the env var → audit aborts with
    exit code 6. The operator's CI logs surface the issue + the
    override hint."""
    monkeypatch.setenv("EIDAN_BUNDLE_ROOT", str(tmp_path))
    monkeypatch.setenv("EIDAN_SOURCE_DIR", str(tmp_path / "eidan"))
    monkeypatch.delenv("EIDAN_ALLOW_DIRTY_BUNDLES", raising=False)

    repo = tmp_path / "eidan-pro"
    _setup_clean_repo(repo)
    _git(repo, "checkout", "-b", "feat/wip")

    # Force non-TTY: patch the stdin check on the deploy module.
    with patch.object(deploy.sys.stdin, "isatty", return_value=False):
        code = deploy._audit_bundles_or_abort([_NodeStub(["eidan-pro"])])

    assert code == 6


def test_audit_returns_zero_when_all_clean(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Happy path: every declared bundle is clean → audit returns
    0 immediately, no prompt, no environment-var dance."""
    monkeypatch.setenv("EIDAN_BUNDLE_ROOT", str(tmp_path))
    monkeypatch.setenv("EIDAN_SOURCE_DIR", str(tmp_path / "eidan"))
    _setup_clean_repo(tmp_path / "eidan-pro")

    code = deploy._audit_bundles_or_abort([_NodeStub(["eidan-pro"])])

    assert code == 0
