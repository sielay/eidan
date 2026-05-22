"""Phase 4 acceptance tests for ``eidan admin plugin install``.

Covers (per issue #47):

- ``--from-dir`` short-circuits ``EIDAN_PLUGIN_SOURCE`` and copies the
  bundle's plugins into the install's ``plugins/`` directory.
- ``EIDAN_PLUGIN_SOURCE=local:<path>`` resolves the bundle via its name.
- An existing ``plugins/<name>/`` is refused unless ``--force`` is passed.
- ``EIDAN_PLUGIN_LINK=1`` materialises a symlink rather than a copy.
- A bundle's ``bundle.yaml`` ``depends_on`` is auto-installed via the
  same mechanism (paid-baseline auto-install — ``docs/018 §3``).
- The GitHub clone path surfaces ``auth failed; check
  EIDAN_GITHUB_TOKEN`` when no PAT is set.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from eidan_cli import admin

FIXTURES = Path(__file__).parent / "fixtures" / "bundles"


@pytest.fixture
def plugins_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A throwaway ``plugins/`` directory wired into the admin module."""
    target = tmp_path / "plugins"
    target.mkdir()
    monkeypatch.setattr(admin, "PLUGINS_DIR", target)
    # Ensure no stray test-runner env leaks into the install path.
    monkeypatch.delenv("EIDAN_PLUGIN_SOURCE", raising=False)
    monkeypatch.delenv("EIDAN_PLUGIN_LINK", raising=False)
    monkeypatch.delenv("EIDAN_GITHUB_TOKEN", raising=False)
    return target


def test_from_dir_copies_every_plugin(plugins_dir: Path) -> None:
    rc = admin.plugin_install(
        bundle="example-bundle",
        from_dir=str(FIXTURES / "example-bundle"),
    )
    assert rc == 0
    assert (plugins_dir / "example-foo" / "plugin.yaml").is_file()
    assert (plugins_dir / "example-bar" / "plugin.yaml").is_file()
    # Default mode is a copy, not a symlink.
    assert not (plugins_dir / "example-foo").is_symlink()


def test_from_dir_short_circuits_env_var(
    plugins_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # If --from-dir wins, this bogus env var must not be consulted.
    monkeypatch.setenv("EIDAN_PLUGIN_SOURCE", "gh:does-not-exist")
    rc = admin.plugin_install(
        bundle="example-bundle",
        from_dir=str(FIXTURES / "example-bundle"),
    )
    assert rc == 0
    assert (plugins_dir / "example-foo").is_dir()


def test_local_source_resolves_bundle_by_name(
    plugins_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("EIDAN_PLUGIN_SOURCE", f"local:{FIXTURES}")
    rc = admin.plugin_install(bundle="example-bundle", from_dir=None)
    assert rc == 0
    assert (plugins_dir / "example-foo").is_dir()
    assert (plugins_dir / "example-bar").is_dir()
    # Baseline auto-installs via bundle.yaml depends_on.
    assert (plugins_dir / "example-baseline-plugin").is_dir()


def test_refuses_to_overwrite_without_force(plugins_dir: Path) -> None:
    (plugins_dir / "example-foo").mkdir()
    (plugins_dir / "example-foo" / "stamp").write_text("pre-existing")

    rc = admin.plugin_install(
        bundle="example-bundle",
        from_dir=str(FIXTURES / "example-bundle"),
    )
    assert rc == 1
    # The pre-existing tree is untouched.
    assert (plugins_dir / "example-foo" / "stamp").read_text() == "pre-existing"
    # The other plugin is not partially installed.
    assert not (plugins_dir / "example-bar").exists()


def test_force_overwrites(plugins_dir: Path) -> None:
    (plugins_dir / "example-foo").mkdir()
    (plugins_dir / "example-foo" / "stamp").write_text("pre-existing")

    rc = admin.plugin_install(
        bundle="example-bundle",
        from_dir=str(FIXTURES / "example-bundle"),
        force=True,
    )
    assert rc == 0
    assert not (plugins_dir / "example-foo" / "stamp").exists()
    assert (plugins_dir / "example-foo" / "plugin.yaml").is_file()


def test_env_link_materialises_a_symlink(
    plugins_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("EIDAN_PLUGIN_LINK", "1")
    rc = admin.plugin_install(
        bundle="example-bundle",
        from_dir=str(FIXTURES / "example-bundle"),
    )
    assert rc == 0
    foo = plugins_dir / "example-foo"
    assert foo.is_symlink()
    assert foo.resolve() == (FIXTURES / "example-bundle" / "example-foo").resolve()


def test_from_dir_pointing_directly_at_bundle_root(plugins_dir: Path) -> None:
    # The acceptance criterion: `--from-dir ./tests/fixtures/bundles/example-bundle`
    # works when no `<bundle>/` subdir exists under the path.
    rc = admin.plugin_install(
        bundle=None,
        from_dir=str(FIXTURES / "example-bundle"),
    )
    assert rc == 0
    assert (plugins_dir / "example-foo").is_dir()


def test_missing_from_dir_errors_cleanly(
    plugins_dir: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    rc = admin.plugin_install(bundle="example-bundle", from_dir="/no/such/path")
    assert rc == 1
    err = capsys.readouterr().err
    assert "does not exist" in err


def test_no_source_configured_errors_cleanly(
    plugins_dir: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    rc = admin.plugin_install(bundle="example-bundle", from_dir=None)
    assert rc == 1
    err = capsys.readouterr().err
    assert "EIDAN_PLUGIN_SOURCE" in err


def test_github_path_requires_token(
    plugins_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setenv("EIDAN_PLUGIN_SOURCE", "gh:some-org")
    # No EIDAN_GITHUB_TOKEN — fast-fail before invoking git.
    rc = admin.plugin_install(bundle="example-bundle", from_dir=None)
    assert rc == 1
    err = capsys.readouterr().err
    assert "EIDAN_GITHUB_TOKEN" in err


def test_github_path_auth_failure_message(
    plugins_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setenv("EIDAN_PLUGIN_SOURCE", "gh:some-org")
    monkeypatch.setenv("EIDAN_GITHUB_TOKEN", "not-a-real-token")

    class _FakeProc:
        returncode = 128
        stdout = ""
        stderr = (
            "remote: Invalid username or password.\n"
            "fatal: Authentication failed for "
            "'https://github.com/some-org/example-bundle.git/'\n"
        )

    def _fake_run(cmd, capture_output, text):  # type: ignore[no-untyped-def]
        assert cmd[0] == "git"
        assert cmd[1] == "clone"
        return _FakeProc()

    monkeypatch.setattr(admin.subprocess, "run", _fake_run)
    rc = admin.plugin_install(bundle="example-bundle", from_dir=None)
    assert rc == 1
    err = capsys.readouterr().err
    assert "auth failed" in err
    assert "EIDAN_GITHUB_TOKEN" in err


def test_github_path_success(
    plugins_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The git-clone path drops plugins into PLUGINS_DIR on success.

    We fake ``git clone`` by populating the destination tree with the
    example-bundle fixture — i.e. the same on-disk shape a real clone
    would produce.
    """
    monkeypatch.setenv("EIDAN_PLUGIN_SOURCE", "gh:some-org")
    monkeypatch.setenv("EIDAN_GITHUB_TOKEN", "stub-token")

    def _fake_run(cmd, capture_output, text):  # type: ignore[no-untyped-def]
        # cmd shape: ["git", "clone", "--depth", "1", url, dest].
        # The bundle name is the penultimate path segment of the URL.
        assert cmd[0] == "git" and cmd[1] == "clone"
        import shutil

        url = cmd[4]
        bundle_name = url.rsplit("/", 1)[-1].removesuffix(".git")
        shutil.copytree(FIXTURES / bundle_name, Path(cmd[5]))

        class _Proc:
            returncode = 0
            stdout = ""
            stderr = ""

        return _Proc()

    monkeypatch.setattr(admin.subprocess, "run", _fake_run)
    rc = admin.plugin_install(bundle="example-bundle", from_dir=None)
    assert rc == 0
    assert (plugins_dir / "example-foo" / "plugin.yaml").is_file()
    # The bundle.yaml dependency was auto-cloned + installed.
    assert (plugins_dir / "example-baseline-plugin" / "plugin.yaml").is_file()


def test_unknown_source_scheme_errors_cleanly(
    plugins_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setenv("EIDAN_PLUGIN_SOURCE", "ftp:example.org")
    rc = admin.plugin_install(bundle="example-bundle", from_dir=None)
    assert rc == 1
    err = capsys.readouterr().err
    assert "scheme" in err
