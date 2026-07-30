/**
 * Safety gates for the AI setter, ported from wa-bridge's autoreply
 * sidecar and adapted for a sales-setter context: scheduling and price
 * talk are the setter's job, so unlike the WhatsApp original they do not
 * trip the sensitive filter. Credentials, legal, medical and payment
 * details still do.
 */

import type { DraftReply } from "./types";

/** Instagram rejects DM text above 1000 chars; stay under with margin. */
const MAX_DRAFT_LENGTH = 900;
/** Very long inbound messages deserve a human read before any auto-send. */
const MAX_INCOMING_LENGTH_FOR_AUTO = 600;

const TRIVIAL_ACKNOWLEDGEMENT_PATTERNS: RegExp[] = [
  /^(?:yeah|yep|yup|yes|ok(?:ay)?|alright|sure|got it|makes sense|perfect|great|cool|nice|thanks|thank you|thx)[.!\s\u{1F44D}\u{2705}\u{1F44C}\u{1F642}\u{2764}\u{FE0F}\u{1F525}\u{1F64F}]*$/iu,
  /^(?:ja|jep|jo|okay|ok|alles klar|verstanden|passt|perfekt|mega|top|danke|dankeschön|dankesehr)[.!\s\u{1F44D}\u{2705}\u{1F44C}\u{1F642}\u{2764}\u{FE0F}\u{1F525}\u{1F64F}]*$/iu,
  /^[\s\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2764}]+$/u,
];

const SENSITIVE_PATTERNS: RegExp[] = [
  /\b(iban|wire transfer|bank transfer|refund|chargeback|invoice|überweisung|rückerstattung|rechnung|kündigung)\b/i,
  /\b(legal|lawyer|lawsuit|court|anwalt|klage|gericht|abmahnung|tax|steuer|finanzamt)\b/i,
  /\b(doctor|hospital|emergency|suicide|accident|police|arzt|krankenhaus|notfall|selbstmord|unfall|polizei)\b/i,
  /\b(otp|password|passwort|verification code|sicherheitscode|passport|reisepass|ausweis)\b/i,
];

/**
 * True when the inbound message is a bare acknowledgement that needs no
 * reply. Answering every "ok" makes the setter feel like a bot.
 */
export function isTrivialAcknowledgement(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  return TRIVIAL_ACKNOWLEDGEMENT_PATTERNS.some((pattern) =>
    pattern.test(trimmed)
  );
}

export function matchesSensitiveTopic(text: string): boolean {
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(text));
}

export interface AutoSendCheck {
  allowed: boolean;
  reasons: string[];
}

/**
 * Final gate before an automatic send. Every reason is recorded on the
 * reply log so a held draft explains itself in the dashboard.
 */
export function evaluateAutoSendSafety(params: {
  incomingText: string;
  draft: DraftReply;
  minConfidence: number;
}): AutoSendCheck {
  const reasons: string[] = [];
  const incoming = params.incomingText.trim();
  const draftText = params.draft.reply.trim();

  if (!incoming) reasons.push("incoming text empty");
  if (incoming.length > MAX_INCOMING_LENGTH_FOR_AUTO) {
    reasons.push("incoming message too long for safe auto-send");
  }
  if (!draftText) reasons.push("draft reply empty");
  if (draftText.length > MAX_DRAFT_LENGTH) reasons.push("draft reply too long");
  if (params.draft.confidence < params.minConfidence) {
    reasons.push("confidence below minimum threshold");
  }
  if (!params.draft.shouldSend) {
    reasons.push("model marked reply as should_send=false");
  }
  if (params.draft.needsReview) {
    reasons.push("model marked reply as needs_review=true");
  }
  if (matchesSensitiveTopic(incoming)) {
    reasons.push("incoming message matches a sensitive-topic pattern");
  }
  if (matchesSensitiveTopic(draftText)) {
    reasons.push("draft reply matches a sensitive-topic pattern");
  }

  return { allowed: reasons.length === 0, reasons };
}
