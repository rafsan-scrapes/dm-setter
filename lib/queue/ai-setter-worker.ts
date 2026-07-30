/**
 * AI setter processor for the DM worker.
 *
 * Every Instagram DM message event lands here: it is mirrored into the
 * local conversation store first (the setter's memory), then, for
 * inbound messages, run through the gate chain and, when allowed, the
 * draft-and-send pipeline ported from wa-bridge.
 */

import type { Job } from "bullmq";
import { prisma } from "@/lib/db/client";
import { Prisma } from "@/app/generated/prisma/client";
import type {
  AiReplyStatus,
  AiSetterConfig,
  DmConversation,
} from "@/app/generated/prisma/client";
import type { ProcessInboundDmJob } from "./client";
import { generateSetterDraft } from "@/lib/ai-setter/generate";
import { evaluateAutoSendSafety, isTrivialAcknowledgement } from "@/lib/ai-setter/safety";
import { sendAiReply } from "@/lib/ai-setter/send";
import type { DraftReply } from "@/lib/ai-setter/types";

const HISTORY_LIMIT = 50;
const STYLE_ANCHOR_LIMIT = 30;
/** After a human replies manually, the setter stays out this long. */
const HUMAN_TAKEOVER_PAUSE_MS = 6 * 60 * 60 * 1000;

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}

async function recordSkip(
  conversation: DmConversation,
  accountRecordId: string,
  mid: string,
  text: string,
  reasons: string[]
): Promise<void> {
  await prisma.aiReplyLog
    .create({
      data: {
        conversationId: conversation.id,
        instagramAccountId: accountRecordId,
        inboundMid: mid,
        inboundText: text,
        draftText: "",
        confidence: 0,
        shouldSend: false,
        needsReview: false,
        reasons,
        status: "SKIPPED",
      },
    })
    .catch((error: unknown) => {
      if (!isUniqueViolation(error)) throw error;
    });
}

async function loadPromptInputs(conversationId: string) {
  const [recent, humanMessages] = await Promise.all([
    prisma.dmMessage.findMany({
      where: { conversationId },
      orderBy: { sentAt: "desc" },
      take: HISTORY_LIMIT,
    }),
    prisma.dmMessage.findMany({
      where: { conversationId, direction: "OUT", source: "HUMAN" },
      orderBy: { sentAt: "desc" },
      take: STYLE_ANCHOR_LIMIT,
      select: { text: true },
    }),
  ]);

  return {
    history: recent.reverse().map((message) => ({
      direction: message.direction,
      source: message.source,
      text: message.text,
      sentAt: message.sentAt,
    })),
    humanStyleAnchor: humanMessages.reverse().map((message) => message.text),
  };
}

/**
 * The draft was produced (this run or a crashed earlier attempt); decide
 * whether to auto-send or hold, then act. Returns the final status.
 */
async function deliverDraft(params: {
  job: Job<ProcessInboundDmJob>;
  config: AiSetterConfig;
  replyLogId: string;
  incomingText: string;
  draft: DraftReply;
}): Promise<void> {
  const { job, config, replyLogId, incomingText, draft } = params;

  const safety = evaluateAutoSendSafety({
    incomingText,
    draft,
    minConfidence: config.minConfidence,
  });

  const shouldAutoSend = config.mode === "AUTO" && safety.allowed;
  if (!shouldAutoSend) {
    const reasons =
      config.mode === "AUTO"
        ? safety.reasons
        : ["draft mode: every reply is held for review"];
    await prisma.aiReplyLog.update({
      where: { id: replyLogId },
      data: { status: "HELD", reasons: [...draft.reasons, ...reasons] },
    });
    return;
  }

  const result = await sendAiReply({ replyLogId });
  if (result.ok) return;

  if (result.error === "quota" || result.error === "rate_limit") {
    // Not retryable within this job; hold so a human can send it later.
    await prisma.aiReplyLog.update({
      where: { id: replyLogId },
      data: {
        status: "HELD",
        reasons: [...draft.reasons, result.message ?? result.error],
      },
    });
    return;
  }

  // Transient send failure: let BullMQ retry; mark FAILED on the last try.
  const maxAttempts = job.opts.attempts ?? 3;
  const isFinalAttempt = job.attemptsMade + 1 >= maxAttempts;
  if (isFinalAttempt) {
    await prisma.aiReplyLog.update({
      where: { id: replyLogId },
      data: { status: "FAILED" },
    });
  }
  throw new Error(result.message ?? "AI reply send failed");
}

export async function processInboundDm(
  job: Job<ProcessInboundDmJob>
): Promise<void> {
  const { instagramAccountId, participantId, mid, text, isEcho, timestamp } =
    job.data;

  const account = await prisma.instagramAccount.findUnique({
    where: { instagramId: instagramAccountId },
    include: { aiSetterConfig: true },
  });
  if (!account) return;

  const sentAt = timestamp ? new Date(timestamp) : new Date();

  const conversation = await prisma.dmConversation.upsert({
    where: {
      instagramAccountId_participantId: {
        instagramAccountId: account.id,
        participantId,
      },
    },
    create: {
      instagramAccountId: account.id,
      participantId,
      ...(isEcho ? { lastOutboundAt: sentAt } : { lastInboundAt: sentAt }),
    },
    update: isEcho ? { lastOutboundAt: sentAt } : { lastInboundAt: sentAt },
  });

  // Mirror the message. The unique mid makes webhook redelivery and
  // echoes of our own API sends (already recorded at send time) no-ops.
  try {
    await prisma.dmMessage.create({
      data: {
        conversationId: conversation.id,
        mid,
        direction: isEcho ? "OUT" : "IN",
        source: isEcho ? "HUMAN" : "PARTICIPANT",
        text,
        sentAt,
      },
    });
  } catch (error: unknown) {
    if (isUniqueViolation(error)) return;
    throw error;
  }

  const config = account.aiSetterConfig;

  if (isEcho) {
    // A stored echo means the message was NOT one of our API sends: a
    // human replied from the IG app or dashboard.
    if (config?.pauseOnHumanReply) {
      await prisma.dmConversation.update({
        where: { id: conversation.id },
        data: { humanTakeoverAt: sentAt },
      });
    }
    return;
  }

  // ── Gate chain ──────────────────────────────────────────────────────────
  if (!config || config.mode === "OFF") return;
  if (!conversation.aiEnabled) return;
  if (config.blockedUserIds.includes(participantId)) return;

  if (
    config.pauseOnHumanReply &&
    conversation.humanTakeoverAt &&
    Date.now() - conversation.humanTakeoverAt.getTime() < HUMAN_TAKEOVER_PAUSE_MS
  ) {
    await recordSkip(conversation, account.id, mid, text, [
      "human recently replied in this thread",
    ]);
    return;
  }

  if (isTrivialAcknowledgement(text)) {
    await recordSkip(conversation, account.id, mid, text, [
      "trivial acknowledgement needs no reply",
    ]);
    return;
  }

  // Debounce: if the prospect sent something newer while this job waited,
  // skip; the newest message's job replies with full context.
  const newerInbound = await prisma.dmMessage.findFirst({
    where: {
      conversationId: conversation.id,
      direction: "IN",
      sentAt: { gt: sentAt },
    },
    select: { id: true },
  });
  if (newerInbound) {
    await recordSkip(conversation, account.id, mid, text, [
      "superseded by a newer message",
    ]);
    return;
  }

  // ── Draft ───────────────────────────────────────────────────────────────
  const existing = await prisma.aiReplyLog.findUnique({
    where: { inboundMid: mid },
  });
  if (existing) {
    // A previous attempt crashed after drafting; resume delivery only if
    // it never reached a terminal state.
    if (existing.status !== ("PENDING" satisfies AiReplyStatus)) return;
    await deliverDraft({
      job,
      config,
      replyLogId: existing.id,
      incomingText: text,
      draft: {
        reply: existing.draftText,
        confidence: existing.confidence,
        shouldSend: existing.shouldSend,
        needsReview: existing.needsReview,
        reasons: existing.reasons,
      },
    });
    return;
  }

  const inputs = await loadPromptInputs(conversation.id);
  const draft = await generateSetterDraft({
    incomingText: text,
    participantUsername: conversation.participantUsername,
    history: inputs.history,
    humanStyleAnchor: inputs.humanStyleAnchor,
    config: {
      persona: config.persona,
      goal: config.goal,
      bookingLink: config.bookingLink,
      language: config.language,
      knowledgeEnabled: config.knowledgeEnabled,
      styleExamplesEnabled: config.styleExamplesEnabled,
      minConfidence: config.minConfidence,
    },
  });

  let replyLogId: string;
  try {
    const created = await prisma.aiReplyLog.create({
      data: {
        conversationId: conversation.id,
        instagramAccountId: account.id,
        inboundMid: mid,
        inboundText: text,
        draftText: draft.reply,
        confidence: draft.confidence,
        shouldSend: draft.shouldSend,
        needsReview: draft.needsReview,
        reasons: draft.reasons,
        status: "PENDING",
      },
    });
    replyLogId = created.id;
  } catch (error: unknown) {
    if (isUniqueViolation(error)) return;
    throw error;
  }

  await deliverDraft({
    job,
    config,
    replyLogId,
    incomingText: text,
    draft,
  });
}
