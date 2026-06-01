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


def test_init_wizard_pi_path_writes_topology(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Happy path: Pi target, ollama provider (no API key), one
    bundle. Wizard collects + writes the topology under .eidan/."""
    _stub_questionary(
        monkeypatch,
        [
            "kasha",                              # node name
            "pi",                                  # target
            "192.168.1.100",                       # pi host
            "pi",                                  # pi ssh_user
            "~/.ssh/id_ed25519",                   # pi ssh_key
            "postgresql+asyncpg://e:e@127.0.0.1:5432/eidan",  # database_url
            "ops@example.com",                     # auth email
            "ollama",                              # provider name
            "phi3",                                # default model
            ["eidan-pro"],                         # bundles
        ],
    )

    target, master_key = interactive.run_init_wizard(
        target_dir=tmp_path / ".eidan",
    )

    assert target == tmp_path / ".eidan"
    topology = (target / "topology.yml").read_text(encoding="utf-8")
    assert "kasha:" in topology
    assert "target: pi" in topology
    assert "host: 192.168.1.100" in topology
    assert "ssh_user: pi" in topology
    assert "ssh_key: ~/.ssh/id_ed25519" in topology
    assert "database_url:" in topology
    # `@` in the email triggers YAML quoting (so the line stays a
    # single scalar in case the operator's domain ever has special
    # chars). Either form is valid YAML; we just assert the email
    # lands in the file.
    assert "ops@example.com" in topology
    assert "auth_allowed_email" in topology
    assert "name: ollama" in topology
    assert "default_model: phi3" in topology
    assert "bundles: [eidan-pro]" in topology
    # Master key is generated, ~64 chars (urlsafe encoding of 48 bytes
    # yields 64 chars). Stronger entropy than anything an operator
    # would invent on the spot.
    assert len(master_key) >= 60
    # Topology carries the same key so the running backend reads it.
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
    _stub_questionary(
        monkeypatch,
        [
            "prod",                                # node name
            "fly",                                  # target
            "eidan-api",                            # fly app
            "lhr",                                  # fly region
            "postgresql+asyncpg://e:e@db.example.com:5432/eidan",  # db url
            "ops@example.com",                      # auth email
            "anthropic",                            # provider
            "sk-ant-XXXX",                          # api key
            "claude-sonnet-4-6",                    # default model
            [],                                     # no bundles
        ],
    )

    target, _master_key = interactive.run_init_wizard(
        target_dir=tmp_path / ".eidan",
    )

    topology = (target / "topology.yml").read_text(encoding="utf-8")
    assert "target: fly" in topology
    assert "app: eidan-api" in topology
    assert "region: lhr" in topology
    assert "name: anthropic" in topology
    assert "api_key:" in topology
    # No bundles selected → no `bundles:` line written. Core-only deploy.
    assert "bundles:" not in topology


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
    _stub_questionary(
        monkeypatch,
        [
            "prod",                                 # node name
            "fly",                                   # target
            "eidan-api",                             # fly app
            None,                                    # Ctrl-C on fly region
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
