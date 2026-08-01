"use client";

/**
 * AI Setter
 *
 * Per-account control room for the AI DM setter: operating mode, persona
 * and goal, knowledge-base access, safety thresholds, plus the review
 * queue and activity feed.
 */

import { useCallback, useEffect, useState } from "react";
import AccountSelect, { type AccountOption } from "@/components/account-select";
import AiSetterActivity, {
  type AiReplyItem,
} from "@/components/ai-setter-activity";

const POLL_MS = 15_000;

interface SetterConfigForm {
  mode: "OFF" | "DRAFT" | "AUTO";
  persona: string;
  goal: string;
  bookingLink: string;
  language: string;
  knowledgeEnabled: boolean;
  styleExamplesEnabled: boolean;
  minConfidence: number;
  replyDelaySeconds: number;
  pauseOnHumanReply: boolean;
  windowNudgeEnabled: boolean;
  windowNudgeHours: number;
}

const DEFAULT_FORM: SetterConfigForm = {
  mode: "OFF",
  persona: "",
  goal: "",
  bookingLink: "",
  language: "",
  knowledgeEnabled: true,
  styleExamplesEnabled: true,
  minConfidence: 0.78,
  replyDelaySeconds: 10,
  pauseOnHumanReply: true,
  windowNudgeEnabled: false,
  windowNudgeHours: 20,
};

const MODES: Array<{
  value: SetterConfigForm["mode"];
  label: string;
  description: string;
}> = [
  {
    value: "OFF",
    label: "Off",
    description: "Messages are mirrored, nothing is drafted.",
  },
  {
    value: "DRAFT",
    label: "Draft",
    description: "Every reply is drafted and held for your approval.",
  },
  {
    value: "AUTO",
    label: "Autopilot",
    description: "Confident replies send themselves; edge cases wait for you.",
  },
];

function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  hint: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex w-full items-start justify-between gap-4 rounded-xl border border-border bg-surface px-4 py-3 text-left hover:border-border-hover"
    >
      <span>
        <span className="block text-sm text-foreground">{label}</span>
        <span className="mt-0.5 block text-xs text-muted">{hint}</span>
      </span>
      <span
        className={`mt-1 inline-flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors ${
          checked ? "bg-accent" : "bg-surface-hover"
        }`}
      >
        <span
          className={`h-4 w-4 rounded-full bg-white transition-transform ${
            checked ? "translate-x-4" : "translate-x-0"
          }`}
        />
      </span>
    </button>
  );
}

export default function AiSetterPage() {
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState("");

  const [form, setForm] = useState<SetterConfigForm>(DEFAULT_FORM);
  const [knowledgeBackend, setKnowledgeBackend] = useState<
    "supabase" | "sqlite" | null
  >(null);
  const [configLoading, setConfigLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saved" | "error">("idle");

  const [replies, setReplies] = useState<AiReplyItem[]>([]);
  const [repliesLoading, setRepliesLoading] = useState(true);

  useEffect(() => {
    fetch("/api/instagram/accounts")
      .then((r) => r.json())
      .then((payload) => {
        if (!payload.success) return;
        const next: AccountOption[] = payload.data.instagramAccounts ?? [];
        setAccounts(next);
        setSelectedAccountId(
          (prev) =>
            prev ||
            payload.data.selectedInstagramAccountId ||
            next[0]?.id ||
            ""
        );
      })
      .catch(() => setAccounts([]));
  }, []);

  useEffect(() => {
    if (!selectedAccountId) return;
    // Intentional reset while the new account's config loads.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setConfigLoading(true);
    setSaveState("idle");
    fetch(`/api/ai-setter/config?instagramAccountId=${selectedAccountId}`)
      .then((r) => r.json())
      .then((payload) => {
        if (!payload.success) return;
        const config = payload.data.config;
        setKnowledgeBackend(payload.data.knowledgeBackend ?? null);
        setForm({
          mode: config.mode,
          persona: config.persona ?? "",
          goal: config.goal ?? "",
          bookingLink: config.bookingLink ?? "",
          language: config.language ?? "",
          knowledgeEnabled: config.knowledgeEnabled,
          styleExamplesEnabled: config.styleExamplesEnabled,
          minConfidence: config.minConfidence,
          replyDelaySeconds: config.replyDelaySeconds,
          pauseOnHumanReply: config.pauseOnHumanReply,
          windowNudgeEnabled: config.windowNudgeEnabled ?? false,
          windowNudgeHours: config.windowNudgeHours ?? 20,
        });
      })
      .finally(() => setConfigLoading(false));
  }, [selectedAccountId]);

  const loadReplies = useCallback(
    async (silent: boolean) => {
      if (!selectedAccountId) return;
      if (!silent) setRepliesLoading(true);
      try {
        const res = await fetch(
          `/api/ai-setter/replies?instagramAccountId=${selectedAccountId}&limit=60`,
          { cache: "no-store" }
        );
        const data = await res.json();
        if (data.success) setReplies(data.data.replies);
      } catch {
        // keep whatever is shown
      } finally {
        if (!silent) setRepliesLoading(false);
      }
    },
    [selectedAccountId]
  );

  useEffect(() => {
    if (!selectedAccountId) return;
    // Initial fetch flips the loading flag synchronously on account
    // change; intentional reset, matching the inbox pattern.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadReplies(false);
    const timer = window.setInterval(() => void loadReplies(true), POLL_MS);
    return () => window.clearInterval(timer);
  }, [selectedAccountId, loadReplies]);

  async function handleSave() {
    if (!selectedAccountId || saving) return;
    setSaving(true);
    setSaveState("idle");
    try {
      const res = await fetch("/api/ai-setter/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instagramAccountId: selectedAccountId,
          mode: form.mode,
          persona: form.persona || null,
          goal: form.goal || null,
          bookingLink: form.bookingLink || null,
          language: form.language || null,
          knowledgeEnabled: form.knowledgeEnabled,
          styleExamplesEnabled: form.styleExamplesEnabled,
          minConfidence: form.minConfidence,
          replyDelaySeconds: form.replyDelaySeconds,
          pauseOnHumanReply: form.pauseOnHumanReply,
          windowNudgeEnabled: form.windowNudgeEnabled,
          windowNudgeHours: form.windowNudgeHours,
          blockedUserIds: [],
        }),
      });
      const data = await res.json();
      setSaveState(data.success ? "saved" : "error");
    } catch {
      setSaveState("error");
    } finally {
      setSaving(false);
    }
  }

  function update<K extends keyof SetterConfigForm>(
    key: K,
    value: SetterConfigForm[K]
  ) {
    setForm((prev) => ({ ...prev, [key]: value }));
    setSaveState("idle");
  }

  const held = replies.filter((r) => r.status === "HELD");
  const recent = replies.filter((r) => r.status !== "HELD").slice(0, 25);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold text-foreground">AI Setter</h1>
          <p className="mt-1 text-sm text-muted">
            An AI that answers your DMs in your voice, qualifies prospects,
            and books the right ones.
          </p>
        </div>
        {accounts.length > 1 && (
          <AccountSelect
            accounts={accounts}
            value={selectedAccountId}
            onChange={setSelectedAccountId}
            includeAll={false}
          />
        )}
      </div>

      {/* Mode selector */}
      <div className="grid gap-3 sm:grid-cols-3">
        {MODES.map((mode) => {
          const isActive = form.mode === mode.value;
          return (
            <button
              key={mode.value}
              type="button"
              onClick={() => update("mode", mode.value)}
              aria-pressed={isActive}
              className={`rounded-xl border px-4 py-3 text-left transition-colors ${
                isActive
                  ? "border-accent/60 bg-accent/10"
                  : "border-border bg-surface hover:border-border-hover"
              }`}
            >
              <span
                className={`block text-sm font-medium ${
                  isActive ? "text-accent" : "text-foreground"
                }`}
              >
                {mode.label}
              </span>
              <span className="mt-1 block text-xs text-muted">
                {mode.description}
              </span>
            </button>
          );
        })}
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,4fr)]">
        {/* Settings */}
        <div className="space-y-4">
          {configLoading ? (
            <p className="text-sm text-muted">Loading configuration…</p>
          ) : (
            <>
              <label className="block">
                <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                  Who you are
                </span>
                <textarea
                  value={form.persona}
                  onChange={(e) => update("persona", e.target.value)}
                  rows={4}
                  placeholder="Your positioning, offer, audience, and how you talk. The setter grounds every reply in this."
                  className="mt-2 w-full resize-y rounded-xl border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-zinc-600 focus:border-accent/40 focus:outline-none"
                />
              </label>

              <label className="block">
                <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                  Setter goal
                </span>
                <textarea
                  value={form.goal}
                  onChange={(e) => update("goal", e.target.value)}
                  rows={2}
                  placeholder="e.g. Qualify for the mentorship (already running a business, 2k+ budget) and book a call."
                  className="mt-2 w-full resize-y rounded-xl border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-zinc-600 focus:border-accent/40 focus:outline-none"
                />
              </label>

              <div className="grid gap-4 sm:grid-cols-2">
                <label className="block">
                  <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                    Booking link
                  </span>
                  <input
                    value={form.bookingLink}
                    onChange={(e) => update("bookingLink", e.target.value)}
                    placeholder="https://cal.com/you/call"
                    className="mt-2 w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-zinc-600 focus:border-accent/40 focus:outline-none"
                  />
                </label>
                <label className="block">
                  <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                    Reply language
                  </span>
                  <select
                    value={form.language}
                    onChange={(e) => update("language", e.target.value)}
                    className="mt-2 w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm text-foreground focus:border-accent/40 focus:outline-none"
                  >
                    <option value="">Match the incoming message</option>
                    <option value="German">Always German</option>
                    <option value="English">Always English</option>
                  </select>
                </label>
              </div>

              <Toggle
                checked={form.knowledgeEnabled}
                onChange={(v) => update("knowledgeEnabled", v)}
                label="Second brain"
                hint={
                  knowledgeBackend === "supabase"
                    ? "Pull facts about you and your offer from your connected Supabase knowledge base."
                    : knowledgeBackend === "sqlite"
                      ? "Pull facts about you and your offer from your local knowledge base file."
                      : "No knowledge base yet. Create one in 2 minutes: drop markdown files about you and your offer into ./knowledge on the server, then run: npm run knowledge:ingest -- ./knowledge (or connect Supabase, see docs/ai-setter.md)."
                }
              />
              <Toggle
                checked={form.styleExamplesEnabled}
                onChange={(v) => update("styleExamplesEnabled", v)}
                label="Style memory"
                hint="Imitate phrasing from your indexed message history, so replies sound like you texted them."
              />
              <Toggle
                checked={form.pauseOnHumanReply}
                onChange={(v) => update("pauseOnHumanReply", v)}
                label="Step aside for humans"
                hint="When you reply to a thread yourself, the setter stays out of it for a few hours."
              />
              <Toggle
                checked={form.windowNudgeEnabled}
                onChange={(v) => update("windowNudgeEnabled", v)}
                label="Follow-up nudge"
                hint={`If a prospect goes quiet, send one gentle follow-up after ${form.windowNudgeHours}h, before Instagram's 24h reply window closes. Draft mode holds it for review.`}
              />
              {form.windowNudgeEnabled && (
                <label className="block">
                  <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                    Nudge after (hours of silence)
                  </span>
                  <input
                    type="number"
                    min={1}
                    max={23}
                    value={form.windowNudgeHours}
                    onChange={(e) =>
                      update(
                        "windowNudgeHours",
                        Math.max(1, Math.min(23, Math.trunc(Number(e.target.value) || 20)))
                      )
                    }
                    className="mt-2 w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm text-foreground focus:border-accent/40 focus:outline-none"
                  />
                </label>
              )}

              <div className="grid gap-4 sm:grid-cols-2">
                <label className="block">
                  <span className="flex items-baseline justify-between text-xs font-semibold uppercase tracking-wide text-zinc-500">
                    Confidence to auto-send
                    <span className="tabular-nums text-muted">
                      {Math.round(form.minConfidence * 100)}%
                    </span>
                  </span>
                  <input
                    type="range"
                    min={0.5}
                    max={0.95}
                    step={0.01}
                    value={form.minConfidence}
                    onChange={(e) =>
                      update("minConfidence", Number(e.target.value))
                    }
                    className="mt-3 w-full accent-[--color-accent]"
                  />
                  <span className="mt-1 block text-xs text-muted">
                    Below this the reply is held for review instead of sent.
                  </span>
                </label>
                <label className="block">
                  <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                    Reply delay (seconds)
                  </span>
                  <input
                    type="number"
                    min={0}
                    max={600}
                    value={form.replyDelaySeconds}
                    onChange={(e) =>
                      update(
                        "replyDelaySeconds",
                        Math.max(0, Math.min(600, Number(e.target.value) || 0))
                      )
                    }
                    className="mt-2 w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm text-foreground focus:border-accent/40 focus:outline-none"
                  />
                  <span className="mt-1 block text-xs text-muted">
                    Lets rapid-fire messages collapse into one reply.
                  </span>
                </label>
              </div>

              <div className="flex items-center gap-3 pt-1">
                <button
                  type="button"
                  onClick={() => void handleSave()}
                  disabled={saving || !selectedAccountId}
                  className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
                >
                  {saving ? "Saving…" : "Save settings"}
                </button>
                {saveState === "saved" && (
                  <span className="text-sm text-success">Saved.</span>
                )}
                {saveState === "error" && (
                  <span className="text-sm text-error">
                    Could not save, try again.
                  </span>
                )}
              </div>
            </>
          )}
        </div>

        {/* Review queue + activity */}
        <AiSetterActivity
          held={held}
          recent={recent}
          loading={repliesLoading}
          onRefresh={() => void loadReplies(true)}
        />
      </div>
    </div>
  );
}
