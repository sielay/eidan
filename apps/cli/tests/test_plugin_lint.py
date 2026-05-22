"""Acceptance tests for ``eidan admin plugin lint`` (issue #49).

Covers the surface pinned in `docs/001 §1.2`:

- ``os.environ["UNDECLARED"]`` (and friends) triggers a lint warning
  when the key is not in ``env:``; declaring it makes the same source
  pass.
- ``ctx.secret.get(user_id, "key")`` against an undeclared key is
  flagged; declaring the key in ``vault:`` clears the finding.
- Manifest schema violations surface as a single targeted finding
  (reuses :func:`eidan_backend.plugins.manifest.load_manifest`).
- A directory whose name does not match ``manifest.name`` fails via
  the manifest check.
- A ``pyproject.toml`` whose ``[project].name`` is not the snake_case
  of the manifest name fails.
- ``--all`` walks every plugin under ``plugins/``; the CLI exits
  non-zero on any finding so CI gates merges automatically.
- A clean plugin passes with exit code 0.
"""

from __future__ import annotations

from pathlib import Path
from textwrap import dedent

import pytest
from eidan_cli import admin, lint

_CLEAN_MANIFEST = dedent(
    """\
    schema: 1
    name: example-lint
    version: 0.1.0
    tier: core
    license: AGPL
    backend:
      entrypoint: example_lint.plugin:Plugin
    """
)


def _write_plugin(
    plugins_dir: Path,
    plugin_name: str,
    *,
    manifest_text: str,
    sources: dict[str, str] | None = None,
    pyproject: str | None = None,
) -> Path:
    """Materialise a synthetic plugin under ``plugins_dir/<plugin_name>/``."""
    root = plugins_dir / plugin_name
    root.mkdir()
    (root / "plugin.yaml").write_text(manifest_text, encoding="utf-8")
    if pyproject is not None:
        (root / "pyproject.toml").write_text(pyproject, encoding="utf-8")
    pkg = root / plugin_name.replace("-", "_")
    pkg.mkdir()
    (pkg / "__init__.py").write_text("", encoding="utf-8")
    for filename, body in (sources or {}).items():
        (pkg / filename).write_text(body, encoding="utf-8")
    return root


@pytest.fixture
def plugins_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    target = tmp_path / "plugins"
    target.mkdir()
    monkeypatch.setattr(admin, "PLUGINS_DIR", target)
    return target


# ---------------------------------------------------------------------------
# acceptance: undeclared os.environ
# ---------------------------------------------------------------------------


def test_undeclared_os_environ_triggers_warning(plugins_dir: Path) -> None:
    """Acceptance criterion 1: a plugin that reads ``os.environ['UNDECLARED']``
    without declaring it in ``env:`` fails lint."""
    _write_plugin(
        plugins_dir,
        "example-lint",
        manifest_text=_CLEAN_MANIFEST,
        sources={
            "plugin.py": (
                "import os\n"
                "VALUE = os.environ['UNDECLARED']\n"
            )
        },
    )

    findings = lint.lint_plugin(plugins_dir / "example-lint")
    messages = [f.message for f in findings]
    assert any("UNDECLARED" in m and "env" in m for m in messages), messages


def test_declared_env_var_passes_lint(plugins_dir: Path) -> None:
    """Acceptance criterion 2: declaring the env var in the manifest clears
    the warning even when the source still reads ``os.environ``."""
    manifest = _CLEAN_MANIFEST + dedent(
        """\
        env:
          - name: UNDECLARED
            required: true
        """
    )
    _write_plugin(
        plugins_dir,
        "example-lint",
        manifest_text=manifest,
        sources={
            "plugin.py": (
                "import os\n"
                "VALUE = os.environ['UNDECLARED']\n"
            )
        },
    )

    findings = lint.lint_plugin(plugins_dir / "example-lint")
    assert findings == []


def test_os_getenv_with_literal_key_is_flagged(plugins_dir: Path) -> None:
    _write_plugin(
        plugins_dir,
        "example-lint",
        manifest_text=_CLEAN_MANIFEST,
        sources={
            "plugin.py": (
                "import os\n"
                "VALUE = os.getenv('SECRET_KEY', 'fallback')\n"
            )
        },
    )

    findings = lint.lint_plugin(plugins_dir / "example-lint")
    assert any("SECRET_KEY" in f.message for f in findings)


def test_os_environ_get_with_literal_key_is_flagged(plugins_dir: Path) -> None:
    _write_plugin(
        plugins_dir,
        "example-lint",
        manifest_text=_CLEAN_MANIFEST,
        sources={
            "plugin.py": (
                "import os\n"
                "VALUE = os.environ.get('OTHER_KEY')\n"
            )
        },
    )

    findings = lint.lint_plugin(plugins_dir / "example-lint")
    assert any("OTHER_KEY" in f.message for f in findings)


def test_dynamic_env_access_is_silently_ignored(plugins_dir: Path) -> None:
    """Non-literal subscripts cannot be statically resolved; runtime catches them."""
    _write_plugin(
        plugins_dir,
        "example-lint",
        manifest_text=_CLEAN_MANIFEST,
        sources={
            "plugin.py": (
                "import os\n"
                "KEY = 'DYNAMIC_KEY'\n"
                "VALUE = os.environ[KEY]\n"
            )
        },
    )

    findings = lint.lint_plugin(plugins_dir / "example-lint")
    assert findings == []


# ---------------------------------------------------------------------------
# vault keys
# ---------------------------------------------------------------------------


def test_undeclared_ctx_secret_get_is_flagged(plugins_dir: Path) -> None:
    _write_plugin(
        plugins_dir,
        "example-lint",
        manifest_text=_CLEAN_MANIFEST,
        sources={
            "plugin.py": (
                "async def run(ctx, user_id):\n"
                "    return await ctx.secret.get(user_id, 'undeclared.key')\n"
            )
        },
    )

    findings = lint.lint_plugin(plugins_dir / "example-lint")
    assert any(
        "undeclared.key" in f.message and "vault" in f.message for f in findings
    )


def test_declared_vault_key_passes(plugins_dir: Path) -> None:
    manifest = _CLEAN_MANIFEST + dedent(
        """\
        vault:
          - key: undeclared.key
            required: true
        """
    )
    _write_plugin(
        plugins_dir,
        "example-lint",
        manifest_text=manifest,
        sources={
            "plugin.py": (
                "async def run(ctx, user_id):\n"
                "    return await ctx.secret.get(user_id, 'undeclared.key')\n"
            )
        },
    )

    findings = lint.lint_plugin(plugins_dir / "example-lint")
    assert findings == []


def test_ctx_secret_set_and_delete_are_scanned(plugins_dir: Path) -> None:
    """`ctx.secret.set` and `.delete` share the second-arg key convention."""
    _write_plugin(
        plugins_dir,
        "example-lint",
        manifest_text=_CLEAN_MANIFEST,
        sources={
            "plugin.py": (
                "async def store(ctx, user_id):\n"
                "    await ctx.secret.set(user_id, 'unset.one', 'v')\n"
                "    await ctx.secret.delete(user_id, 'unset.two')\n"
            )
        },
    )

    findings = lint.lint_plugin(plugins_dir / "example-lint")
    keys = {f.message for f in findings}
    assert any("unset.one" in m for m in keys)
    assert any("unset.two" in m for m in keys)


# ---------------------------------------------------------------------------
# manifest + directory + pyproject checks
# ---------------------------------------------------------------------------


def test_manifest_schema_violation_is_reported(plugins_dir: Path) -> None:
    """A manifest missing a required field surfaces as a single finding."""
    bad_manifest = dedent(
        """\
        schema: 1
        name: example-lint
        # version omitted on purpose
        tier: core
        license: AGPL
        """
    )
    _write_plugin(
        plugins_dir,
        "example-lint",
        manifest_text=bad_manifest,
        sources={"plugin.py": "pass\n"},
    )

    findings = lint.lint_plugin(plugins_dir / "example-lint")
    assert any("manifest invalid" in f.message for f in findings)


def test_directory_name_mismatch_is_reported(plugins_dir: Path) -> None:
    """`docs/001 §1.2`: directory name MUST equal manifest.name."""
    _write_plugin(
        plugins_dir,
        "wrong-dir",
        manifest_text=_CLEAN_MANIFEST,  # declares name: example-lint
        sources={"plugin.py": "pass\n"},
    )

    findings = lint.lint_plugin(plugins_dir / "wrong-dir")
    assert findings, "expected a directory/name mismatch finding"
    assert any(
        "does not match directory name" in f.message
        or "directory name" in f.message
        for f in findings
    )


def test_pyproject_name_mismatch_is_reported(plugins_dir: Path) -> None:
    """`pyproject.toml [project].name` MUST be snake_case of manifest.name."""
    _write_plugin(
        plugins_dir,
        "example-lint",
        manifest_text=_CLEAN_MANIFEST,
        sources={"plugin.py": "pass\n"},
        pyproject=dedent(
            """\
            [project]
            name = "totally-different"
            version = "0.1.0"
            """
        ),
    )

    findings = lint.lint_plugin(plugins_dir / "example-lint")
    assert any(
        "pyproject" in f.location and "totally-different" in f.message
        for f in findings
    )


def test_pyproject_with_matching_name_passes(plugins_dir: Path) -> None:
    _write_plugin(
        plugins_dir,
        "example-lint",
        manifest_text=_CLEAN_MANIFEST,
        sources={"plugin.py": "pass\n"},
        pyproject=dedent(
            """\
            [project]
            name = "example_lint"
            version = "0.1.0"
            """
        ),
    )

    assert lint.lint_plugin(plugins_dir / "example-lint") == []


def test_pyproject_with_hyphenated_name_passes(plugins_dir: Path) -> None:
    """PEP 621 permits hyphens in the distribution name; accept either form."""
    _write_plugin(
        plugins_dir,
        "example-lint",
        manifest_text=_CLEAN_MANIFEST,
        sources={"plugin.py": "pass\n"},
        pyproject=dedent(
            """\
            [project]
            name = "example-lint"
            version = "0.1.0"
            """
        ),
    )

    assert lint.lint_plugin(plugins_dir / "example-lint") == []


# ---------------------------------------------------------------------------
# scan boundary
# ---------------------------------------------------------------------------


def test_skip_dirs_are_not_scanned(plugins_dir: Path) -> None:
    """`migrations/`, `tests/`, `web/` are excluded so noise stays out."""
    root = _write_plugin(
        plugins_dir,
        "example-lint",
        manifest_text=_CLEAN_MANIFEST,
        sources={"plugin.py": "pass\n"},
    )
    # Stage code that *would* fail lint, but in a skipped directory.
    (root / "tests").mkdir()
    (root / "tests" / "test_x.py").write_text(
        "import os\nos.environ['UNDECLARED_IN_TESTS']\n", encoding="utf-8"
    )
    (root / "migrations").mkdir()
    (root / "migrations" / "env.py").write_text(
        "import os\nos.environ['UNDECLARED_IN_MIG']\n", encoding="utf-8"
    )

    findings = lint.lint_plugin(root)
    assert findings == []


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------


def test_plugin_lint_returns_one_when_findings_exist(
    plugins_dir: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    _write_plugin(
        plugins_dir,
        "example-lint",
        manifest_text=_CLEAN_MANIFEST,
        sources={
            "plugin.py": "import os\nVALUE = os.environ['UNDECLARED']\n"
        },
    )

    rc = lint.plugin_lint("example-lint", False)
    assert rc == 1
    out = capsys.readouterr()
    assert "UNDECLARED" in out.out
    assert "lint finding" in out.err


def test_plugin_lint_returns_zero_when_clean(
    plugins_dir: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    _write_plugin(
        plugins_dir,
        "example-lint",
        manifest_text=_CLEAN_MANIFEST,
        sources={"plugin.py": "pass\n"},
    )

    rc = lint.plugin_lint("example-lint", False)
    assert rc == 0
    out = capsys.readouterr().out
    assert "lint OK" in out


def test_plugin_lint_all_walks_every_plugin(
    plugins_dir: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    _write_plugin(
        plugins_dir,
        "example-lint",
        manifest_text=_CLEAN_MANIFEST,
        sources={"plugin.py": "pass\n"},
    )
    _write_plugin(
        plugins_dir,
        "example-other",
        manifest_text=_CLEAN_MANIFEST.replace("example-lint", "example-other"),
        sources={"plugin.py": "import os\nos.environ['BAD_KEY']\n"},
    )

    rc = lint.plugin_lint(None, True)
    assert rc == 1
    out = capsys.readouterr().out
    assert "BAD_KEY" in out
    assert "example-other" in out


def test_plugin_lint_all_with_no_plugins_returns_zero(
    plugins_dir: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    rc = lint.plugin_lint(None, True)
    assert rc == 0
    assert "(no plugins installed)" in capsys.readouterr().out


def test_plugin_lint_missing_target_returns_usage(
    plugins_dir: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    rc = lint.plugin_lint(None, False)
    assert rc == 2
    assert "usage" in capsys.readouterr().err


def test_plugin_lint_unknown_target_errors(
    plugins_dir: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    rc = lint.plugin_lint("does-not-exist", False)
    assert rc == 1
    assert "does-not-exist" in capsys.readouterr().err


def test_plugin_lint_rejects_both_target_and_all(
    plugins_dir: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    rc = lint.plugin_lint("example-lint", True)
    assert rc == 2
    assert "OR" in capsys.readouterr().err
