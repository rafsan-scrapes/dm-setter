/**
 * Draft generation: retrieval, prompt assembly, model call, parsing.
 */

import { completeSetterPrompt } from "./llm";
import { fetchKnowledgeContext, fetchStyleExamples } from "./knowledge";
import {
  buildNudgeUserPrompt,
  buildSetterSystemPrompt,
  buildSetterUserPrompt,
} from "./prompt";
import type { DraftReply, SetterPromptContext } from "./types";

/**
 * Tolerant JSON extraction: slice from the first "{" to the last "}"
 * so chatty providers still parse. Every default fails safe toward
 * human review.
 */
export function extractDraftReply(raw: string): DraftReply {
  const text = raw.trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  const candidate = start >= 0 && end > start ? text.slice(start, end + 1) : text;

  let parsed: Partial<DraftReply> & { should_send?: boolean; needs_review?: boolean };
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return {
      reply: "",
      confidence: 0,
      shouldSend: false,
      needsReview: true,
      reasons: ["model output was not valid JSON"],
    };
  }

  const confidence = Number(parsed.confidence ?? 0);
  return {
    reply: String(parsed.reply ?? "").trim(),
    confidence: Number.isFinite(confidence) ? confidence : 0,
    shouldSend: Boolean(parsed.should_send ?? parsed.shouldSend),
    needsReview: Boolean(parsed.needs_review ?? parsed.needsReview ?? true),
    reasons: Array.isArray(parsed.reasons)
      ? parsed.reasons.map((value) => String(value))
      : [],
  };
}

export interface GenerateDraftParams {
  incomingText: string;
  participantUsername?: string | null;
  history: SetterPromptContext["history"];
  humanStyleAnchor: string[];
  config: {
    persona?: string | null;
    goal?: string | null;
    bookingLink?: string | null;
    language?: string | null;
    knowledgeEnabled: boolean;
    styleExamplesEnabled: boolean;
    minConfidence: number;
  };
}

/**
 * Retrieval query built from the thread's recent turns, not just the
 * newest message: "wie viel kostet das?" alone retrieves nothing, but
 * with the last few messages it lands on the right offer facts.
 */
function buildKnowledgeQuery(
  history: SetterPromptContext["history"],
  incomingText: string | null,
  participantUsername?: string | null
): string {
  const recentTurns = history
    .slice(-6)
    .map((message) => message.text.replace(/\s+/g, " ").slice(0, 160));
  return [participantUsername, ...recentTurns, incomingText]
    .filter(Boolean)
    .join("\n")
    .slice(0, 1500);
}

export async function generateSetterDraft(
  params: GenerateDraftParams
): Promise<DraftReply> {
  const knowledgeQuery = buildKnowledgeQuery(
    params.history,
    params.incomingText,
    params.participantUsername
  );

  const [knowledgeContext, styleExamples] = await Promise.all([
    params.config.knowledgeEnabled
      ? fetchKnowledgeContext(knowledgeQuery).catch(() => "")
      : Promise.resolve(""),
    params.config.styleExamplesEnabled
      ? fetchStyleExamples(params.incomingText).catch(() => "")
      : Promise.resolve(""),
  ]);

  const context: SetterPromptContext = {
    incomingText: params.incomingText,
    participantUsername: params.participantUsername,
    history: params.history,
    humanStyleAnchor: params.humanStyleAnchor,
    knowledgeContext,
    styleExamples,
    persona: params.config.persona,
    goal: params.config.goal,
    bookingLink: params.config.bookingLink,
    language: params.config.language,
    minConfidence: params.config.minConfidence,
  };

  const system = buildSetterSystemPrompt(params.config);
  const userPrompt = buildSetterUserPrompt(context);
  const raw = await completeSetterPrompt(system, userPrompt);
  return extractDraftReply(raw);
}

/**
 * Draft a quiet-prospect nudge. Same persona, goal, and output contract
 * as a normal reply; the "incoming message" is replaced by the situation.
 */
export async function generateWindowNudge(params: {
  participantUsername?: string | null;
  history: SetterPromptContext["history"];
  humanStyleAnchor: string[];
  quietHours: number;
  config: GenerateDraftParams["config"];
}): Promise<DraftReply> {
  const knowledgeContext = params.config.knowledgeEnabled
    ? await fetchKnowledgeContext(
        buildKnowledgeQuery(params.history, null, params.participantUsername)
      ).catch(() => "")
    : "";

  const context: Omit<SetterPromptContext, "incomingText"> = {
    participantUsername: params.participantUsername,
    history: params.history,
    humanStyleAnchor: params.humanStyleAnchor,
    knowledgeContext,
    styleExamples: "",
    persona: params.config.persona,
    goal: params.config.goal,
    bookingLink: params.config.bookingLink,
    language: params.config.language,
    minConfidence: params.config.minConfidence,
  };

  const system = buildSetterSystemPrompt(params.config);
  const userPrompt = buildNudgeUserPrompt(context, params.quietHours);
  const raw = await completeSetterPrompt(system, userPrompt);
  return extractDraftReply(raw);
}
