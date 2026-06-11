// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import * as React from "react";
import {
  Bot,
  Check,
  ChevronRight,
  KeyRound,
  Mail,
  Plus,
  Send,
  Shield,
  Sparkles,
} from "lucide-react";

/**
 * The first-run onboarding wizard (UI_DESIGN_BRIEF §7, Core):
 * magic-link sign-in → welcome → AI provider → assistant → first chat.
 *
 * This is the interactive UI flow as designed (local state, warm + simple).
 * Wiring each step to real provisioning — magic-link auth, the secrets
 * vault for the provider key, and agent-config for the persona — is a
 * follow-up; the flow shape and copy are the deliverable here.
 */

const PROVIDERS = [
  { id: "anthropic", name: "Anthropic", sub: "Claude — recommended", Icon: Sparkles },
  { id: "openai", name: "OpenAI", sub: "GPT-4o, o-series", Icon: Bot },
  { id: "local", name: "Local · Ollama", sub: "Runs fully on your machine", Icon: Shield },
  { id: "openrouter", name: "OpenRouter", sub: "One key, many models", Icon: KeyRound },
] as const;

const PERSONAS = [
  { id: "warm", name: "Warm", sub: "Encouraging, gentle nudges" },
  { id: "direct", name: "Direct", sub: "Brief and to the point" },
  { id: "playful", name: "Playful", sub: "Light, a little wit" },
] as const;

type Stage = "login" | 0 | 1 | 2 | 3 | "done";

export function OnboardingFlow(): React.ReactElement {
  const [stage, setStage] = React.useState<Stage>("login");
  const [sent, setSent] = React.useState(false);
  const [provider, setProvider] = React.useState<string | null>(null);
  const [keyEntered, setKeyEntered] = React.useState(false);
  const [name] = React.useState("eidan");
  const [persona, setPersona] = React.useState<string>("warm");

  let body: React.ReactNode;
  const step = typeof stage === "number" ? stage : null;

  if (stage === "login") {
    body = (
      <Login
        sent={sent}
        onSend={() => setSent(true)}
        onContinue={() => setStage(0)}
      />
    );
  } else if (stage === "done") {
    body = (
      <div className="onb-card onb-center">
        <div className="onb-sent" style={{ background: "var(--good-tint)", color: "var(--good)" }}>
          <Check className="i" aria-hidden />
        </div>
        <h1 className="onb-title">Welcome aboard</h1>
        <p className="onb-lede">Opening your assistant…</p>
        <button type="button" className="btn--quiet" onClick={() => setStage("login")}>
          Restart demo
        </button>
      </div>
    );
  } else if (stage === 0) {
    body = <Welcome onNext={() => setStage(1)} />;
  } else if (stage === 1) {
    body = (
      <ProviderStep
        value={provider}
        onPick={setProvider}
        keyEntered={keyEntered}
        onKey={() => setKeyEntered(true)}
        onNext={() => setStage(2)}
        onBack={() => setStage(0)}
      />
    );
  } else if (stage === 2) {
    body = (
      <AssistantStep
        name={name}
        persona={persona}
        onPersona={setPersona}
        onNext={() => setStage(3)}
        onBack={() => setStage(1)}
      />
    );
  } else {
    body = (
      <FirstChat name={name} onDone={() => setStage("done")} onBack={() => setStage(2)} />
    );
  }

  return (
    <div className="onb-shell">
      {step !== null ? <Stepper step={step} /> : null}
      {body}
    </div>
  );
}

function Stepper({ step, total = 4 }: { step: number; total?: number }): React.ReactElement {
  return (
    <div className="onb-steps" role="progressbar" aria-valuenow={step + 1} aria-valuemax={total}>
      {Array.from({ length: total }).map((_, i) => (
        <span
          key={i}
          className={"onb-step" + (i === step ? " is-now" : i < step ? " is-done" : "")}
        />
      ))}
    </div>
  );
}

function Mark({ size = 56 }: { size?: number }): React.ReactElement {
  return (
    <span
      className="onb-mark"
      style={{ width: size, height: size, borderRadius: size * 0.3 }}
    >
      <Sparkles className="i" aria-hidden />
    </span>
  );
}

function Login({
  sent,
  onSend,
  onContinue,
}: {
  sent: boolean;
  onSend: () => void;
  onContinue: () => void;
}): React.ReactElement {
  return (
    <div className="onb-card onb-center">
      <Mark />
      <h1 className="onb-title">eidan</h1>
      {!sent ? (
        <>
          <p className="onb-lede">
            Your private, self-hosted assistant. Sign in with a magic link — no
            password to remember.
          </p>
          <div className="field onb-field">
            <span className="field__label">Email</span>
            <div className="input">sam@example.com</div>
          </div>
          <button type="button" className="btn btn--primary btn--block btn--lg" onClick={onSend}>
            <Mail className="i-sm" aria-hidden />
            Send magic link
          </button>
          <p className="onb-fine">Self-hosted on your own server. Your data never leaves it.</p>
        </>
      ) : (
        <>
          <div className="onb-sent">
            <Mail className="i" aria-hidden />
          </div>
          <h2 className="onb-subtitle">Check your inbox</h2>
          <p className="onb-lede">
            We sent a sign-in link to <strong>sam@example.com</strong>. It expires in
            15 minutes.
          </p>
          <button type="button" className="btn btn--primary btn--block btn--lg" onClick={onContinue}>
            I&apos;ve clicked the link →
          </button>
          <button type="button" className="btn--quiet" onClick={onSend}>
            Resend
          </button>
        </>
      )}
    </div>
  );
}

function Welcome({ onNext }: { onNext: () => void }): React.ReactElement {
  return (
    <div className="onb-card onb-center">
      <Mark size={64} />
      <h1 className="onb-title">Welcome to eidan</h1>
      <p className="onb-lede">
        A calm assistant for your life and work — it remembers what matters, watches
        the numbers, and only nudges when it helps.
      </p>
      <ul className="onb-points">
        <li>
          <Shield className="i-sm" aria-hidden />
          <span>
            <strong>Private by design.</strong> Runs on your server; you hold the keys.
          </span>
        </li>
        <li>
          <Sparkles className="i-sm" aria-hidden />
          <span>
            <strong>It builds memory.</strong> Notes, dates and knowledge, kept for you.
          </span>
        </li>
        <li>
          <Plus className="i-sm" aria-hidden />
          <span>
            <strong>Grows with bundles.</strong> Add fitness, business, dev — only what
            you want.
          </span>
        </li>
      </ul>
      <button type="button" className="btn btn--primary btn--block btn--lg" onClick={onNext}>
        Get started
      </button>
    </div>
  );
}

function ProviderStep({
  value,
  onPick,
  keyEntered,
  onKey,
  onNext,
  onBack,
}: {
  value: string | null;
  onPick: (id: string) => void;
  keyEntered: boolean;
  onKey: () => void;
  onNext: () => void;
  onBack: () => void;
}): React.ReactElement {
  return (
    <div className="onb-card">
      <div className="onb-head">
        <h2 className="onb-subtitle">Connect an AI provider</h2>
        <p className="onb-lede onb-lede--tight">
          eidan needs a model to think with. Pick a provider and paste a key — it&apos;s
          stored only on your server.
        </p>
      </div>
      <div className="onb-grid">
        {PROVIDERS.map((p) => (
          <button
            key={p.id}
            type="button"
            className={"onb-opt" + (value === p.id ? " is-sel" : "")}
            onClick={() => onPick(p.id)}
          >
            <span className="onb-opt__ic">
              <p.Icon className="i-sm" aria-hidden />
            </span>
            <span className="onb-opt__main">
              <span className="onb-opt__name">{p.name}</span>
              <span className="onb-opt__sub">{p.sub}</span>
            </span>
            {value === p.id ? <Check className="i-sm onb-opt__check" aria-hidden /> : null}
          </button>
        ))}
      </div>
      {value && value !== "local" ? (
        <div className="field onb-field">
          <span className="field__label">API key</span>
          <div className="input onb-key" onClick={onKey}>
            <span className="num">
              {keyEntered ? "••••••••••••••••••••••••  sk-…a91" : "Paste your key"}
            </span>
            {keyEntered ? (
              <span className="pill pill--good" style={{ marginLeft: "auto" }}>
                <span className="pill__dot" />
                Valid
              </span>
            ) : null}
          </div>
        </div>
      ) : null}
      {value === "local" ? (
        <p className="onb-fine onb-fine--box">
          <Shield className="i-sm" aria-hidden />
          Ollama detected on localhost:11434 · no key needed.
        </p>
      ) : null}
      <div className="onb-actions">
        <button type="button" className="btn btn--ghost" onClick={onBack}>
          Back
        </button>
        <button
          type="button"
          className="btn btn--primary"
          disabled={!value}
          onClick={onNext}
        >
          Continue
        </button>
      </div>
    </div>
  );
}

function AssistantStep({
  name,
  persona,
  onPersona,
  onNext,
  onBack,
}: {
  name: string;
  persona: string;
  onPersona: (id: string) => void;
  onNext: () => void;
  onBack: () => void;
}): React.ReactElement {
  return (
    <div className="onb-card">
      <div className="onb-head">
        <h2 className="onb-subtitle">Shape your assistant</h2>
        <p className="onb-lede onb-lede--tight">
          Give it a name and a tone. You can change both later in Settings.
        </p>
      </div>
      <div className="onb-assistant">
        <span className="onb-avatar">
          <Sparkles className="i" aria-hidden />
        </span>
        <div className="field" style={{ flex: 1 }}>
          <span className="field__label">Name</span>
          <div className="input" style={{ fontWeight: 600 }}>
            {name}
          </div>
        </div>
      </div>
      <span className="field__label" style={{ marginBottom: "var(--s2)", display: "block" }}>
        Tone
      </span>
      <div className="onb-grid">
        {PERSONAS.map((p) => (
          <button
            key={p.id}
            type="button"
            className={"onb-opt" + (persona === p.id ? " is-sel" : "")}
            onClick={() => onPersona(p.id)}
          >
            <span className="onb-opt__main">
              <span className="onb-opt__name">{p.name}</span>
              <span className="onb-opt__sub">{p.sub}</span>
            </span>
            {persona === p.id ? <Check className="i-sm onb-opt__check" aria-hidden /> : null}
          </button>
        ))}
      </div>
      <div className="onb-actions">
        <button type="button" className="btn btn--ghost" onClick={onBack}>
          Back
        </button>
        <button type="button" className="btn btn--primary" onClick={onNext}>
          Continue
        </button>
      </div>
    </div>
  );
}

function FirstChat({
  name,
  onDone,
  onBack,
}: {
  name: string;
  onDone: () => void;
  onBack: () => void;
}): React.ReactElement {
  const prompts = [
    "What can you help me with?",
    "Remember my dentist is overdue",
    "What's a good first bundle for me?",
  ];
  return (
    <div className="onb-card">
      <div className="onb-head">
        <h2 className="onb-subtitle">You&apos;re all set</h2>
        <p className="onb-lede onb-lede--tight">
          Say hello to {name}. Here are a few ways to start — or just type anything.
        </p>
      </div>
      <div className="onb-chat">
        <div className="bubble bubble--asst">
          Hi, I&apos;m {name}. I&apos;ll keep things calm and remember what matters.
          What&apos;s on your mind?
        </div>
      </div>
      <div className="onb-prompts">
        {prompts.map((p) => (
          <button key={p} type="button" className="onb-prompt">
            {p}
            <ChevronRight className="i-sm onb-prompt__chev" aria-hidden />
          </button>
        ))}
      </div>
      <div
        className="composer"
        style={{ borderTop: "none", marginTop: "var(--s4)", paddingTop: 0 }}
      >
        <div className="composer__input" style={{ display: "flex", alignItems: "center", color: "var(--muted)" }}>
          Message {name}…
        </div>
        <button type="button" className="btn btn--primary composer__send">
          <Send className="i" aria-hidden />
        </button>
      </div>
      <div className="onb-actions">
        <button type="button" className="btn btn--ghost" onClick={onBack}>
          Back
        </button>
        <button type="button" className="btn btn--primary" onClick={onDone}>
          Enter eidan →
        </button>
      </div>
    </div>
  );
}
