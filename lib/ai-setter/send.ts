/**
 * Shared send path for AI setter replies, used by the worker (auto mode)
 * and the dashboard approval route (draft mode). Respects the same
 * workspace quota and per-account hourly rate limit as campaign DMs.
 */

import { prisma } from "@/lib/db/client";
import { sendDirectMessage } from "@/lib/meta/client";
import { decryptToken } from "@/lib/meta/oauth";
import { reserveDMSlot } from "@/lib/utils/rate-limiter";
import {
  releaseWorkspaceDMReservation,
  reserveWorkspaceDMSend,
} from "@/lib/billing/usage";

export interface SendAiReplyParams {
  replyLogId: string;
  /** Optional human-edited text; defaults to the stored draft. */
  textOverride?: string;
}

export interface SendAiReplyResult {
  ok: boolean;
  /** Machine-readable failure bucket for the caller to map to UX. */
  error?: "not_found" | "quota" | "rate_limit" | "send_failed";
  message?: string;
}

export async function sendAiReply(
  params: SendAiReplyParams
): Promise<SendAiReplyResult> {
  const replyLog = await prisma.aiReplyLog.findUnique({
    where: { id: params.replyLogId },
    include: {
      conversation: true,
      instagramAccount: {
        select: {
          id: true,
          instagramId: true,
          accessToken: true,
          workspaceId: true,
        },
      },
    },
  });
  if (!replyLog) return { ok: false, error: "not_found" };

  const text = (params.textOverride ?? replyLog.draftText).trim();
  if (!text) return { ok: false, error: "send_failed", message: "Empty reply" };

  const account = replyLog.instagramAccount;

  const usage = await reserveWorkspaceDMSend(account.workspaceId);
  if (!usage.allowed) {
    return {
      ok: false,
      error: "quota",
      message: `Monthly DM limit reached (${usage.limit})`,
    };
  }

  const rateLimit = await reserveDMSlot(account.instagramId).catch(() => null);
  if (!rateLimit || !rateLimit.allowed) {
    await releaseWorkspaceDMReservation(account.workspaceId, usage.periodStart);
    return {
      ok: false,
      error: "rate_limit",
      message: "Hourly Instagram DM rate limit reached",
    };
  }

  try {
    const accessToken = decryptToken(account.accessToken);
    const result = await sendDirectMessage(
      accessToken,
      account.instagramId,
      replyLog.conversation.participantId,
      text
    );

    const sentAt = new Date();
    await prisma.dmMessage
      .create({
        data: {
          conversationId: replyLog.conversationId,
          mid: result.message_id,
          direction: "OUT",
          source: "AI",
          text,
          sentAt,
        },
      })
      .catch(() => {});
    await prisma.dmConversation.update({
      where: { id: replyLog.conversationId },
      data: { lastOutboundAt: sentAt },
    });
    await prisma.aiReplyLog.update({
      where: { id: replyLog.id },
      data: {
        status: "SENT",
        draftText: text,
        sentMid: result.message_id,
        sentAt,
        errorMessage: null,
      },
    });
    return { ok: true };
  } catch (error: unknown) {
    await releaseWorkspaceDMReservation(account.workspaceId, usage.periodStart);
    const message = error instanceof Error ? error.message : "Unknown error";
    await prisma.aiReplyLog.update({
      where: { id: replyLog.id },
      data: { errorMessage: message },
    });
    return { ok: false, error: "send_failed", message };
  }
}
