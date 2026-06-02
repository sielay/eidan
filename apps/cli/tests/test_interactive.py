# SPDX-License-Identifier: AGPL-3.0-or-later
"""Tests for the interactive CLI surfaces.

We mock ``questionary`` rather than spinning up a real PTY — the
prompts are pure-function in the sense that they accept a question
and return an answer. Replacing each prompt class with a stub that
yields a queued list of answers exercises the wizard's control
flow without the actual TUI redraws.

What we cover:
- ``run_init_wizard`` produces a topology.yml with the operator's
  chosen values.
- The master key is generated, not asked, and is 64+ chars (urlsafe
  encoding of 48 bytes).
- Pi vs Fly branches collect the right target-specific fields.
- Ctrl-C at any prompt raises :class:`InteractiveCancelled` and
  does NOT write a partial topology.
"""

from __future__ import annotations

from collections import deque
from pathlib import Path
from typing import Any

import pytest
from eidan_cli import interactive


class _FakePrompt:
    """Replaces a questionary prompt's ``.ask()`` with a pre-queued
    answer. The queue is shared across all prompts in a test so the
    order of answers matches the order the wizard asks them."""

    def __init__(self, answers: deque[Any]) -> None:
        self._answers = answers

    def ask(self) -> Any:
        if not self._answers:
            raise AssertionError(
                "wizard asked more questions than the test queued — "
                "extend the answers deque"
            )
        return self._answers.popleft()


def _stub_questionary(monkeypatch: pytest.MonkeyPatch, answers: list[Any]) -> deque[Any]:
    """Patch every prompt class on :mod:`questionary` so each call
    returns the next answer in ``answers``. Returns the deque so
    the test can assert it was fully drained."""
    queue: deque[Any] = deque(answers)

    def _factory(*args: Any, **kwargs: Any) -> _FakePrompt:
        return _FakePrompt(queue)

    for name in ("select", "text", "password", "checkbox", "confirm"):
        monkeypatch.setattr(interactive.questionary, name, _factory)
    # `questionary.print` is non-interactive (prints a styled line);
    # patch to a no-op so the test output stays clean.
    monkeypatch.setattr(
        interactive.questionary, "print", lambda *args, **kwargs: None
    )
    return queue


# ---------- run_init_wizard ---------------------------------------------------


def _stub_bundle_fetch(
    monkeypatch: pytest.MonkeyPatch, bundles: list[str] | None
) -> None:
    """Replace the gh-CLI bundle fetcher with a canned list so wizard
    tests don't shell out to a real `gh repo list`."""
    monkeypatch.setattr(
        interactive, "_list_eidan_bundles", lambda _org: bundles
    )


def test_init_wizard_pi_path_writes_topology(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Happy path: Pi target, ollama provider (no API key), one
    bundle. Wizard collects + writes the topology under .eidan/.

    The DB URL is now collected as five separate prompts
    (host / port / db / user / password) and assembled to the
    asyncpg URL before write. Password is URL-encoded so chars
    like `@` don't break the URL parser."""
    _stub_bundle_fetch(monkeypatch, ["eidan-pro", "eidan-coding"])
    _stub_questionary(
        monkeypatch,
        [
            "kasha",                # node name
            "pi",                    # target
            "192.168.1.100",         # pi host
            "pi",                    # pi ssh_user
            "~/.ssh/id_ed25519",     # pi ssh_key
            "127.0.0.1",             # db host
            "5432",                  # db port
            "eidan",                 # db name
            "eidan_app",             # db user
            "secret-pw",             # db password
            "ops@example.com",       # auth email
            "generate",              # auth: generate new key (no existing)
            "ollama",                # provider name
            "phi3",                  # default model
            ["eidan-pro"],           # bundles
        ],
    )

    target, master_key, key_is_new = interactive.run_init_wizard(
        target_dir=tmp_path / ".eidan",
    )

    assert target == tmp_path / ".eidan"
    assert key_is_new is True  # generated path
    topology = (target / "topology.yml").read_text(encoding="utf-8")
    assert "kasha:" in topology
    assert "target: pi" in topology
    assert "host: 192.168.1.100" in topology
    assert "ssh_user: pi" in topology
    assert "ssh_key: ~/.ssh/id_ed25519" in topology
    # DB fields assembled into the asyncpg URL.
    assert "postgresql+asyncpg://eidan_app:secret-pw@127.0.0.1:5432/eidan" in topology
    assert "ops@example.com" in topology
    assert "auth_allowed_email" in topology
    assert "name: ollama" in topology
    assert "default_model: phi3" in topology
    assert "bundles: [eidan-pro]" in topology
    # Master key is generated, ~64 chars (urlsafe encoding of 48 bytes).
    assert len(master_key) >= 60
    assert master_key in topology


def test_init_wizard_fly_path_collects_app_and_region(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Fly target collects `app` + `region` instead of Pi's SSH fields.
    Also exercises a non-ollama provider (API key prompted).

    We stub the Fly app-existence probe to "exists" so the test
    doesn't try to shell out to a real fly binary. The
    auto-create branch has its own focused tests below."""
    monkeypatch.setattr(
        interactive, "_ensure_fly_app", lambda app: None
    )
    _stub_bundle_fetch(monkeypatch, ["eidan-pro"])
    _stub_questionary(
        monkeypatch,
        [
            "prod",                # node name
            "fly",                  # target
            "eidan-api",            # fly app
            "lhr",                  # fly region
            "https://e.sielay.com/",  # cors origins (trailing slash → stripped)
            "db.example.com",       # db host
            "5432",                 # db port
            "eidan",                # db name
            "eidan_app",            # db user
            "fly-secret",           # db password
            "ops@example.com",      # auth email
            "generate",             # auth: generate new key
            "anthropic",            # provider
            "sk-ant-XXXX",          # api key
            "claude-sonnet-4-6",    # default model
            [],                     # no bundles
        ],
    )

    target, _master_key, key_is_new = interactive.run_init_wizard(
        target_dir=tmp_path / ".eidan",
    )

    assert key_is_new is True
    topology = (target / "topology.yml").read_text(encoding="utf-8")
    assert "target: fly" in topology
    assert "app: eidan-api" in topology
    assert "region: lhr" in topology
    # Wizard collected the frontend origin + stripped the trailing
    # slash. Browsers send `Origin: https://e.sielay.com` (no
    # trailing slash), so an origin written with one would fail
    # the literal compare on the backend. The `:` in the URL
    # triggers YAML quoting; we assert the unquoted-or-quoted
    # forms by checking the bare origin appears + the slashed
    # form doesn't.
    assert "cors_origins:" in topology
    assert "https://e.sielay.com" in topology
    assert "https://e.sielay.com/" not in topology
    assert "postgresql+asyncpg://eidan_app:fly-secret@db.example.com:5432/eidan" in topology
    assert "name: anthropic" in topology
    assert "api_key:" in topology
    assert "bundles:" not in topology


def test_init_wizard_url_encodes_password(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Passwords with URL-reserved chars (`@`, `:`, `#`, `/`) MUST
    be percent-encoded before assembly, otherwise the URL parser
    downstream treats them as delimiters and the connection
    silently targets the wrong host."""
    _stub_bundle_fetch(monkeypatch, [])
    _stub_questionary(
        monkeypatch,
        [
            "kasha", "pi",
            "192.168.1.100", "pi", "~/.ssh/id_ed25519",
            "127.0.0.1", "5432", "eidan", "eidan_app",
            "p@ss:word#1",          # password with three reserved chars
            "ops@example.com", "generate",
            "ollama", "phi3",
            [],
        ],
    )

    target, _, _ = interactive.run_init_wizard(
        target_dir=tmp_path / ".eidan",
    )

    topology = (target / "topology.yml").read_text(encoding="utf-8")
    # `@` → %40, `:` → %3A, `#` → %23. quote_plus also encodes `+`
    # but we don't use that here.
    assert "p%40ss%3Aword%231" in topology
    # The raw password MUST NOT appear in the URL — that would mean
    # we didn't encode it.
    assert "p@ss:word#1" not in topology


def test_init_wizard_reuses_existing_master_key(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Re-running the wizard against an existing topology.yml reads
    the prior auth_master_key and offers to reuse it. Operator
    confirms → wizard preserves the key, key_is_new flag is False."""
    # Plant a topology with an existing key. Mimics a prior init.
    eidan_dir = tmp_path / ".eidan"
    eidan_dir.mkdir()
    existing_key = "OLD-KEY-FROM-A-PREVIOUS-INIT-RUN-PRESERVE-ME-PLEASE-1234567890"
    (eidan_dir / "topology.yml").write_text(
        "schema: 1\nnodes:\n  kasha:\n"
        f'    auth_master_key: "{existing_key}"\n',
        encoding="utf-8",
    )

    _stub_bundle_fetch(monkeypatch, [])
    _stub_questionary(
        monkeypatch,
        [
            "kasha", "pi",
            "192.168.1.100", "pi", "~/.ssh/id_ed25519",
            "127.0.0.1", "5432", "eidan", "eidan_app", "secret",
            "ops@example.com",
            True,                   # reuse existing? → yes
            "ollama", "phi3",
            [],
        ],
    )

    target, master_key, key_is_new = interactive.run_init_wizard(
        target_dir=eidan_dir,
        force=True,                  # scaffold over the existing .eidan/
    )

    assert master_key == existing_key
    assert key_is_new is False
    topology = (target / "topology.yml").read_text(encoding="utf-8")
    assert existing_key in topology


def test_init_wizard_accepts_pasted_master_key(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """When the operator declines reuse (or when there's no existing
    key), they can pick 'paste' and provide the key from another
    node. Wizard treats it like the reused case — no fresh-key
    reminder, since the operator already has it."""
    _stub_bundle_fetch(monkeypatch, [])
    pasted = "PASTED-KEY-FROM-ANOTHER-NODE-OF-THIS-DEPLOYMENT-XYZ"
    _stub_questionary(
        monkeypatch,
        [
            "kasha", "pi",
            "192.168.1.100", "pi", "~/.ssh/id_ed25519",
            "127.0.0.1", "5432", "eidan", "eidan_app", "secret",
            "ops@example.com",
            "paste",                 # auth: paste existing (no existing-key prompt
                                     #        because no topology.yml exists yet)
            pasted,                  # the pasted value
            "ollama", "phi3",
            [],
        ],
    )

    target, master_key, key_is_new = interactive.run_init_wizard(
        target_dir=tmp_path / ".eidan",
    )

    assert master_key == pasted
    assert key_is_new is False  # pasted, not generated → no reminder


# ---------- _ensure_fly_app branches ------------------------------------------


class _SubprocessResult:
    """Lightweight stand-in for ``subprocess.CompletedProcess`` so
    tests can return canned shell-output without touching the real
    subprocess module's constructor (which validates args we don't
    care about)."""

    def __init__(self, *, returncode: int, stdout: str = "", stderr: str = "") -> None:
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


def _patch_fly_subprocess(
    monkeypatch: pytest.MonkeyPatch,
    *,
    fly_on_path: bool = True,
    apps_list_returncode: int = 0,
    apps_list_stdout: str = "[]",
    apps_list_stderr: str = "",
    create_returncode: int = 0,
) -> dict[str, list[Any]]:
    """Patch ``shutil.which`` + ``subprocess.run`` to simulate the
    Fly subprocess world. Returns a dict the test can inspect to
    confirm which commands were invoked."""
    import shutil as _shutil
    import subprocess as _subprocess

    calls: dict[str, list[Any]] = {"run": []}

    def _fake_which(name: str) -> str | None:
        if name == "fly" and fly_on_path:
            return "/usr/local/bin/fly"
        return None

    def _fake_run(cmd: list[str], **kwargs: Any) -> _SubprocessResult:
        calls["run"].append(list(cmd))
        if cmd[:3] == ["fly", "apps", "list"]:
            return _SubprocessResult(
                returncode=apps_list_returncode,
                stdout=apps_list_stdout,
                stderr=apps_list_stderr,
            )
        if cmd[:3] == ["fly", "apps", "create"]:
            return _SubprocessResult(returncode=create_returncode)
        return _SubprocessResult(returncode=0)

    monkeypatch.setattr(_shutil, "which", _fake_which)
    monkeypatch.setattr(_subprocess, "run", _fake_run)
    return calls


def test_ensure_fly_app_no_action_when_app_exists(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """If `fly apps list --json` already returns the named app, the
    helper does nothing — no prompt, no create call."""
    calls = _patch_fly_subprocess(
        monkeypatch,
        apps_list_stdout='[{"Name": "eidan-api"}]',
    )
    _stub_questionary(monkeypatch, [])  # no answers needed; nothing prompts

    interactive._ensure_fly_app("eidan-api")

    list_calls = [c for c in calls["run"] if c[:3] == ["fly", "apps", "list"]]
    create_calls = [c for c in calls["run"] if c[:3] == ["fly", "apps", "create"]]
    assert len(list_calls) == 1
    assert create_calls == []


def test_ensure_fly_app_creates_when_operator_accepts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Happy path: app missing, operator confirms, `fly apps create`
    runs with the chosen org."""
    calls = _patch_fly_subprocess(
        monkeypatch,
        apps_list_stdout='[{"Name": "some-other-app"}]',
        create_returncode=0,
    )
    _stub_questionary(
        monkeypatch,
        [
            True,         # confirm "Create it now?" → yes
            "personal",   # org slug
        ],
    )

    interactive._ensure_fly_app("eidan-api")

    create_calls = [c for c in calls["run"] if c[:3] == ["fly", "apps", "create"]]
    assert len(create_calls) == 1
    assert create_calls[0] == [
        "fly", "apps", "create", "eidan-api", "--org", "personal",
    ]


def test_ensure_fly_app_skips_when_operator_declines(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """App missing, operator declines — no create call, no error.
    Operator gets a hint that they need to create it before deploy."""
    calls = _patch_fly_subprocess(
        monkeypatch,
        apps_list_stdout="[]",
    )
    _stub_questionary(monkeypatch, [False])  # decline

    interactive._ensure_fly_app("eidan-api")

    create_calls = [c for c in calls["run"] if c[:3] == ["fly", "apps", "create"]]
    assert create_calls == []


def test_ensure_fly_app_no_op_when_fly_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`fly` not on PATH → helper does nothing (no prompt). The
    deploy step will probe again and the operator gets the
    "install flyctl" message at the right moment."""
    calls = _patch_fly_subprocess(monkeypatch, fly_on_path=False)
    _stub_questionary(monkeypatch, [])  # no answers needed

    interactive._ensure_fly_app("eidan-api")

    # No `fly apps list` should fire at all when fly is missing.
    assert calls["run"] == []


def test_ensure_fly_app_no_op_when_not_authed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`fly apps list` returns non-zero (most often: `fly auth
    login` not done). We surface the stderr inline (mocked
    questionary.print no-ops it here) and skip the create prompt.
    The deploy step's own probe handles the user-facing error."""
    calls = _patch_fly_subprocess(
        monkeypatch,
        apps_list_returncode=1,
        apps_list_stderr="Error: not authenticated",
    )
    _stub_questionary(monkeypatch, [])  # no prompts

    interactive._ensure_fly_app("eidan-api")

    create_calls = [c for c in calls["run"] if c[:3] == ["fly", "apps", "create"]]
    assert create_calls == []


def test_init_wizard_cancelled_at_first_prompt_raises_cancelled(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Ctrl-C anywhere mid-wizard raises :class:`InteractiveCancelled`
    and leaves no partial topology behind. Operators must see
    "cancelled", not a half-baked file in `.eidan/`."""
    _stub_questionary(monkeypatch, [None])  # first prompt returns None (Ctrl-C)

    with pytest.raises(interactive.InteractiveCancelled):
        interactive.run_init_wizard(target_dir=tmp_path / ".eidan")

    # No .eidan/ created because the wizard bailed before scaffold().
    assert not (tmp_path / ".eidan").exists()


def test_init_wizard_cancelled_mid_flow_writes_nothing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Ctrl-C partway through (after some answers collected) still
    leaves no topology — the scaffold step runs last."""
    monkeypatch.setattr(
        interactive, "_ensure_fly_app", lambda app: None
    )
    _stub_questionary(
        monkeypatch,
        [
            "prod",                  # node name
            "fly",                    # target
            "eidan-api",              # fly app
            None,                     # Ctrl-C on fly region
        ],
    )

    with pytest.raises(interactive.InteractiveCancelled):
        interactive.run_init_wizard(target_dir=tmp_path / ".eidan")

    assert not (tmp_path / ".eidan").exists()


# ---------- run_menu ----------------------------------------------------------


def test_menu_routes_to_chosen_callback(monkeypatch: pytest.MonkeyPatch) -> None:
    """Selecting an option from the menu calls the matching callback."""
    _stub_questionary(monkeypatch, ["deploy"])

    calls: list[str] = []
    interactive.run_menu(
        on_init=lambda: calls.append("init"),
        on_deploy=lambda: calls.append("deploy"),
        on_plugin=lambda: calls.append("plugin"),
        on_node=lambda: calls.append("node"),
    )

    assert calls == ["deploy"]


def test_menu_exit_choice_is_a_no_op(monkeypatch: pytest.MonkeyPatch) -> None:
    """Picking ``exit`` returns without calling any route."""
    _stub_questionary(monkeypatch, ["exit"])

    calls: list[str] = []
    interactive.run_menu(
        on_init=lambda: calls.append("init"),
        on_deploy=lambda: calls.append("deploy"),
        on_plugin=lambda: calls.append("plugin"),
        on_node=lambda: calls.append("node"),
    )

    assert calls == []


def test_menu_ctrl_c_returns_quietly(monkeypatch: pytest.MonkeyPatch) -> None:
    """Ctrl-C at the menu (questionary returns ``None``) returns
    without raising — the caller in main.py catches it the same
    way the wizard does, but the menu's contract is "silently
    exit"."""
    _stub_questionary(monkeypatch, [None])

    interactive.run_menu(
        on_init=lambda: pytest.fail("init should not be called on Ctrl-C"),
        on_deploy=lambda: pytest.fail("deploy should not be called on Ctrl-C"),
        on_plugin=lambda: pytest.fail("plugin should not be called on Ctrl-C"),
        on_node=lambda: pytest.fail("node should not be called on Ctrl-C"),
    )
