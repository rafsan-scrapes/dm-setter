<div align="center">

# OpenSetter

Open source Instagram comment-to-DM automation with an AI DM setter.

Built by [Obiri Mensah](https://github.com/obirimensah05) on top of [OpenReply](https://github.com/diwenne/openreply) by Diwen Huang.

[![License: MIT](https://img.shields.io/badge/License-MIT-black.svg)](LICENSE)
[![Built with Next.js](https://img.shields.io/badge/Next.js-16-black.svg)](https://nextjs.org)

</div>

Someone comments `LINK` on your reel and gets your DM a second later. That part is OpenReply, and it works exactly as before. OpenSetter adds what happens next: when the prospect replies, an AI setter answers in your voice, keeps the conversation going, qualifies them, and moves the right people toward a booked call. You stay in control the whole time.

## What the AI setter does

- **Replies in your voice.** The setter drafts short, human DMs grounded in your persona, your goal, and (optionally) real examples of how you actually text, pulled from a style index.
- **Knows your business.** Connect a knowledge base (a Supabase project with your notes, offer docs, and positioning) and the setter retrieves relevant facts before every reply. It never cites the source, it just knows things.
- **Qualifies and books.** You give it a goal ("qualify for the mentorship, book a call") and a booking link. It hands out the link only when the conversation has earned it.
- **Draft mode or autopilot.** In draft mode every reply waits for your approval in the dashboard. On autopilot, confident replies send themselves and edge cases are held for review: low confidence, sensitive topics, payment or legal questions, walls of text.
- **Steps aside for humans.** Reply to a thread yourself (from the IG app or the dashboard) and the setter backs off. Toggle it per conversation from the inbox.
- **Full audit trail.** Every draft, send, hold, and skip is logged with the model's confidence and reasons.

## How it works

1. Meta delivers the DM to your webhook.
2. The message is mirrored into your own Postgres, so the setter remembers more than Meta's 20-message API window.
3. A short debounce collapses rapid-fire messages into one reply.
4. The worker gathers context: thread history, your own verbatim messages, knowledge-base facts, style examples.
5. One LLM call drafts the reply and rates its own confidence.
6. Safety gates decide: send it, or hold it for your review.
7. Sends respect the same per-account hourly rate limit and workspace quota as campaign DMs.

The LLM provider is pluggable: Anthropic API (default), any OpenAI-compatible endpoint, or a local `claude` / `codex` CLI if you want zero API spend. Retrieval embeddings run locally (no message content leaves your server for embedding).

Everything OpenReply does is still here: keyword campaigns, tracked links, follow gates, workspaces and roles, the inbox, templates, reports, and follower analytics. See the [OpenReply README](https://github.com/diwenne/openreply#readme) for the full feature list.

## Quick start

You need a Meta developer app, a Resend account for login emails, and somewhere to host (Vercel for the web app, Railway or a VPS for the worker plus Postgres and Redis). The Instagram account must be Business or Creator.

Read [docs/setup.md](docs/setup.md) first. It covers hosting, the Meta app, and every wrong turn. Then, for the AI setter, add to your worker's environment:

```bash
# Reply generation (pick one provider)
AI_SETTER_PROVIDER=anthropic        # anthropic | openai | claude-cli | codex-cli
AI_SETTER_MODEL=claude-opus-5
ANTHROPIC_API_KEY=sk-ant-...

# Optional: knowledge base + style index (Supabase)
SECOND_BRAIN_SUPABASE_URL=https://xxx.supabase.co
SECOND_BRAIN_SUPABASE_SERVICE_ROLE_KEY=...
```

Turn the setter on per account under **AI Setter** in the dashboard: pick draft mode or autopilot, describe who you are and what the goal is, drop your booking link, save. Start in draft mode, approve a few dozen replies, then flip to autopilot when you trust it.

### The knowledge base

The setter's retrieval expects a Supabase project with a hybrid-search RPC (`onyankopon_hybrid_search`) over embedded document chunks and, optionally, a style-example RPC (`onyankopon_whatsapp_style_search`). Embeddings are 384-dimensional vectors from `paraphrase-multilingual-MiniLM-L12-v2`, generated locally at query time. If you skip this, the setter still works from persona, goal, and chat history alone.

## Credits

OpenSetter is a fork of [OpenReply](https://github.com/diwenne/openreply) by [Diwen Huang](https://github.com/diwenne) (with contributions by Anish Raj), which provides the entire comment-to-DM engine, dashboard, and Meta integration this project stands on. If OpenSetter is useful to you, star their repo too.

The AI reply engine is adapted from a private WhatsApp auto-reply bridge by Obiri Mensah, rebuilt for Instagram on top of OpenReply's queue and worker.

## License

MIT. See [LICENSE](LICENSE).
