/**
 * LLM provider abstraction for the AI setter.
 *
 * Four interchangeable backends, resolved per call from env so a key or
 * provider change needs no restart:
 *  - anthropic:  @anthropic-ai/sdk against the Messages API (default)
 *  - openai:     any OpenAI-compatible /chat/completions endpoint
 *  - claude-cli: local `claude -p` binary (no API key spend)
 *  - codex-cli:  local `codex exec` binary
 */

import { execFile } from "child_process";
import { promisify } from "util";
import Anthropic from "@anthropic-ai/sdk";

const execFileAsync = promisify(execFile);

const CLI_TIMEOUT_MS = 120_000;
const HTTP_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_TOKENS = 2048;

export type SetterLlmProvider =
  | "anthropic"
  | "openai"
  | "claude-cli"
  | "codex-cli";

export interface SetterLlmConfig {
  provider: SetterLlmProvider;
  model: string;
  baseUrl: string;
}

const DEFAULT_MODELS: Record<SetterLlmProvider, string> = {
  anthropic: "claude-opus-5",
  openai: "gpt-4o-mini",
  "claude-cli": "claude-sonnet-5",
  "codex-cli": "gpt-5-codex",
};

export function readSetterLlmConfig(): SetterLlmConfig {
  const raw = (process.env.AI_SETTER_PROVIDER ?? "anthropic").toLowerCase();
  const provider: SetterLlmProvider =
    raw === "openai" || raw === "claude-cli" || raw === "codex-cli"
      ? raw
      : "anthropic";

  return {
    provider,
    model: process.env.AI_SETTER_MODEL ?? DEFAULT_MODELS[provider],
    baseUrl: process.env.AI_SETTER_BASE_URL ?? "https://api.openai.com/v1",
  };
}

function resolveApiKey(provider: SetterLlmProvider): string | null {
  const generic = process.env.AI_SETTER_API_KEY ?? null;
  if (provider === "anthropic") return process.env.ANTHROPIC_API_KEY ?? generic;
  if (provider === "openai") return process.env.OPENAI_API_KEY ?? generic;
  return null;
}

/** Refuse to send an API key over plain http to a non-localhost host. */
export function assertSafeBaseUrl(baseUrl: string): void {
  const url = new URL(baseUrl);
  if (url.protocol === "https:") return;
  const host = url.hostname;
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return;
  throw new Error(
    `AI_SETTER_BASE_URL uses plain http to a remote host (${host}); refusing to send credentials`
  );
}

async function completeViaAnthropic(
  system: string,
  userPrompt: string,
  config: SetterLlmConfig
): Promise<string> {
  const apiKey = resolveApiKey("anthropic");
  if (!apiKey) {
    throw new Error(
      "anthropic provider needs ANTHROPIC_API_KEY or AI_SETTER_API_KEY"
    );
  }

  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model: config.model,
    max_tokens: MAX_OUTPUT_TOKENS,
    system,
    messages: [{ role: "user", content: userPrompt }],
  });

  if (response.stop_reason === "refusal") {
    throw new Error("model declined the request (stop_reason: refusal)");
  }

  return response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

async function completeViaOpenAiCompatible(
  system: string,
  userPrompt: string,
  config: SetterLlmConfig
): Promise<string> {
  const apiKey = resolveApiKey("openai");
  if (!apiKey) {
    throw new Error(
      "openai provider needs OPENAI_API_KEY or AI_SETTER_API_KEY"
    );
  }
  assertSafeBaseUrl(config.baseUrl);

  const response = await fetch(
    `${config.baseUrl.replace(/\/$/, "")}/chat/completions`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: userPrompt },
        ],
      }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    }
  );

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `openai-compatible endpoint returned ${response.status}: ${body.slice(0, 300)}`
    );
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("openai-compatible endpoint returned no content");
  return content;
}

async function completeViaClaudeCli(
  prompt: string,
  model: string
): Promise<string> {
  const bin = process.env.AI_SETTER_CLAUDE_BIN ?? "claude";
  const { stdout } = await execFileAsync(
    bin,
    ["--strict-mcp-config", "--setting-sources", "", "--model", model, "-p", prompt],
    { timeout: CLI_TIMEOUT_MS, maxBuffer: 1024 * 1024 }
  );
  return stdout;
}

async function completeViaCodexCli(
  prompt: string,
  model: string
): Promise<string> {
  const bin = process.env.AI_SETTER_CODEX_BIN ?? "codex";
  const { stdout } = await execFileAsync(
    bin,
    ["exec", "--sandbox", "read-only", "--model", model, prompt],
    { timeout: CLI_TIMEOUT_MS, maxBuffer: 1024 * 1024 }
  );
  return stdout;
}

/**
 * Run one draft completion. The system block carries the setter
 * instructions; the user prompt carries the untrusted conversation
 * material. CLI providers get both concatenated since they take a
 * single prompt string.
 */
export async function completeSetterPrompt(
  system: string,
  userPrompt: string
): Promise<string> {
  const config = readSetterLlmConfig();
  if (config.provider === "anthropic") {
    return completeViaAnthropic(system, userPrompt, config);
  }
  if (config.provider === "openai") {
    return completeViaOpenAiCompatible(system, userPrompt, config);
  }
  const combined = `${system}\n\n${userPrompt}`;
  if (config.provider === "codex-cli") {
    return completeViaCodexCli(combined, config.model);
  }
  return completeViaClaudeCli(combined, config.model);
}
