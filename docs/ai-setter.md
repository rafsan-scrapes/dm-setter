# The AI Setter

This is the complete guide to OpenSetter's AI layer: what it does, how to
configure it, and how each safety mechanism behaves. For hosting and the
Meta app, read [setup.md](setup.md) first.

## What it does

When a prospect DMs your connected Instagram account, the setter drafts a
reply in your voice: grounded in your persona, your goal, the whole
conversation history, and (optionally) your knowledge base. Depending on
mode, the reply sends itself or waits for your approval.

Two campaign-side extras:

- **AI-personalized openers**: a campaign can rewrite its DM text per
  commenter, referencing their actual comment. Toggle it per campaign in
  the builder. Links, buttons, and follow gates work exactly as before;
  any model failure falls back to your static text.
- **Window nudges**: Instagram only lets a business reply within 24 hours
  of the prospect's last message. With nudges enabled, a prospect who
  goes quiet gets one gentle follow-up before the window closes (default
  after 20 quiet hours). One nudge per window, never more.

## Modes

Set the account default on the AI Setter page:

| Mode | Behavior |
| --- | --- |
| Off | Messages are mirrored, nothing is drafted. |
| Draft | Every reply is drafted and held for review. |
| Autopilot | Confident replies send themselves; edge cases are held. |

Every conversation can override the account default from the inbox
(thread header): account default, autopilot, drafts only, or off. That
lets you run trusted threads on autopilot while a sensitive one stays in
draft mode.

Held drafts appear in two places: inline in the inbox thread (edit,
approve, dismiss right where the conversation is) and on the AI Setter
page's review queue.

## Safety gates

Before an automatic send, all of these must pass; anything that fails
holds the draft for review with the reason attached:

- model confidence at or above your threshold (default 78%)
- the model itself did not ask for review
- no sensitive topics in either direction (payments, legal, medical,
  credentials; German and English patterns)
- draft under Instagram's length limit; inbound message not a wall of text

Independent of mode, the setter never replies when: the thread's AI is
off, the sender is blocklisted, the message is a bare acknowledgement
("ok", "danke"), a newer message from the same person supersedes it, or
you replied manually in the last hours ("step aside for humans").
Manual replies are detected via message echoes, so replying from the
Instagram app pauses the setter too.

## LLM providers

Set in the environment (worker):

```bash
AI_SETTER_PROVIDER=anthropic   # anthropic | openai | claude-cli | codex-cli
AI_SETTER_MODEL=claude-opus-5
ANTHROPIC_API_KEY=sk-ant-...
```

- `anthropic`: the default. Uses the Messages API.
- `openai`: any OpenAI-compatible endpoint (`AI_SETTER_BASE_URL`,
  `OPENAI_API_KEY`). Works with local inference servers on localhost.
- `claude-cli` / `codex-cli`: shell out to a locally installed `claude`
  or `codex` binary. Zero API spend if you have a subscription. The
  binary must be logged in under the user the worker runs as.

`AI_SETTER_API_KEY` works as a generic fallback key for either API
provider.

## The knowledge base

Optional but transformative: the setter answers from facts about you,
your offer, and your positioning instead of improvising. Two backends,
picked automatically:

### Local SQLite (zero accounts, 2 minutes)

1. Create a folder of markdown files: who you are, what you sell, FAQs,
   objection handling, results.
2. Run:

```bash
npm run knowledge:ingest -- ./knowledge
```

That writes `./data/knowledge.db` (override with
`SECOND_BRAIN_SQLITE_PATH`). Embeddings are computed locally; nothing
leaves your machine. Re-run after editing your files. The setter picks
the file up automatically; no restart needed for content updates.

### Supabase (shared, remote, full-text + vector search)

1. Apply [schema/knowledge-base.sql](../schema/knowledge-base.sql) to a
   Supabase project (SQL editor).
2. Set env on web and worker:

```bash
SECOND_BRAIN_SUPABASE_URL=https://xxx.supabase.co
SECOND_BRAIN_SUPABASE_SERVICE_ROLE_KEY=...
```

3. Ingest the same way; with these vars set the script writes to
   Supabase instead.

Already have your own knowledge tables? Point the setter at existing
RPCs with `SECOND_BRAIN_HYBRID_SEARCH_RPC`, `SECOND_BRAIN_STYLE_SEARCH_RPC`,
and `SECOND_BRAIN_DOCUMENTS_TABLE`. The expected signatures are in
[schema/knowledge-base.sql](../schema/knowledge-base.sql).

### Style memory

A second, isolated index of real incoming/outgoing message pairs teaches
the setter how you actually text (register, length, slang). It is
retrieved as phrasing examples only, never as facts. Supabase backend
only; see the `opensetter_style_examples` table in the schema. If you
skip it, the setter still anchors on your verbatim messages within each
thread.

### Embeddings

Both retrieval and ingest use a local multilingual model
(`paraphrase-multilingual-MiniLM-L12-v2`, 384 dimensions) via
Transformers.js. First run downloads the model to the HuggingFace cache.
`AI_SETTER_EMBEDDINGS=off` disables embeddings entirely (keyword search
takes over where possible).

## Environment reference

| Variable | Default | Purpose |
| --- | --- | --- |
| `AI_SETTER_PROVIDER` | `anthropic` | LLM backend |
| `AI_SETTER_MODEL` | per provider | Model id |
| `AI_SETTER_BASE_URL` | `https://api.openai.com/v1` | OpenAI-compatible endpoint |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `AI_SETTER_API_KEY` | - | Credentials |
| `AI_SETTER_CLAUDE_BIN` / `AI_SETTER_CODEX_BIN` | `claude` / `codex` | CLI binaries |
| `SECOND_BRAIN_SQLITE_PATH` | `./data/knowledge.db` | Local knowledge base file |
| `SECOND_BRAIN_SUPABASE_URL` | - | Supabase knowledge base |
| `SECOND_BRAIN_SUPABASE_SERVICE_ROLE_KEY` | - | Supabase credentials |
| `SECOND_BRAIN_HYBRID_SEARCH_RPC` | `opensetter_hybrid_search` | Custom RPC name |
| `SECOND_BRAIN_STYLE_SEARCH_RPC` | `opensetter_style_search` | Custom RPC name |
| `SECOND_BRAIN_DOCUMENTS_TABLE` | `opensetter_documents` | Full-text fallback table |
| `SECOND_BRAIN_EMBEDDING_MODEL` | `Xenova/paraphrase-multilingual-MiniLM-L12-v2` | Embedding model |
| `AI_SETTER_EMBEDDINGS` | on | `off` disables local embeddings |

## Operational notes

- All AI activity is logged (`AiReplyLog`): draft text, confidence, the
  model's own reasons, and every gate that held a reply back.
- Sends share the campaign pipeline's per-account hourly rate limit and
  workspace quota.
- The debounce (default 10s, per account) collapses rapid-fire messages
  into one reply, and a second supersede check runs after generation, so
  a prospect who double-texts mid-draft never gets a stale answer.
- **No double sends.** A draft is atomically claimed (SENDING) before
  the Meta call; concurrent approvals, job retries, and crash-resumes
  all back off. If the process dies mid-send or the network drops with
  the outcome unknown, the draft is quarantined as HELD with a warning
  to check the Instagram thread; nothing ambiguous is ever auto-retried.
- **Missed webhooks heal themselves.** A reconciliation sweep (default
  every 10 minutes, `DM_POLL_INTERVAL_MS`) backfills the local mirror
  from Meta's Conversations API and routes a missed, still-answerable
  prospect message through the normal pipeline.
- Nudges are armed when the prospect's message arrives, not when the
  setter replies, so windows where you replied by hand still nudge.
- **Editing drafts teaches the setter.** An approval you edited before
  sending is recorded as your own voice and feeds the style anchor of
  every future draft in that thread (and is flagged `humanEdited` for
  threshold tuning).
- Knowledge retrieval embeds the last few thread turns together with the
  newest message, so short follow-ups ("how much is it?") still retrieve
  the right facts.
- Instagram's 24h window is enforced by Meta: an approved draft whose
  window closed will fail with Meta's own error, visible on the draft.
