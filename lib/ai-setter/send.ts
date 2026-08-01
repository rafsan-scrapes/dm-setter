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
import { getDMQueue, WINDOW_NUDGE_JOB_NAME } from "@/lib/queue/client";
import type { AiSetterConfig, DmConversation } from "@/app/generated/prisma/client";

const WINDOW_MS = 24 * 60 * 60 * 1000;
/** Keep a margin so a nudge never races the window's actual close. */
const WINDOW_CLOSE_MARGIN_MS = 30 * 60 * 1000;

/**
 * After any outbound setter send, arm the quiet-prospect check for this
 * 24h window. The job id is anchored to lastInboundAt, so one window can
 * only ever produce one nudge, no matter how many sends happen inside it.
 */
async function scheduleWindowNudge(
  conversation: DmConversation,
  config: AiSetterConfig | null
): Promise<void> {
  if (!config?.windowNudgeEnabled) return;
  if ((conversation.modeOverride ?? config.mode) === "OFF") return;
  if (!conversation.lastInboundAt) return;

  const anchor = conversation.lastInboundAt.getTime();
  const fireAt = anchor + config.windowNudgeHours * 60 * 60 * 1000;
  const delay = fireAt - Date.now();
  if (delay <= 0) return;
  if (fireAt > anchor + WINDOW_MS - WINDOW_CLOSE_MARGIN_MS) return;

  await getDMQueue()
    .add(
      WINDOW_NUDGE_JOB_NAME,
      { conversationId: conversation.id, windowAnchorTs: anchor },
      { delay, jobId: `nudge_${conversation.id}_${anchor}` }
    )
    .catch(() => {});
}

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
          aiSetterConfig: true,
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
    const isNudge = replyLog.inboundMid.startsWith("nudge:");
    await prisma.dmConversation.update({
      where: { id: replyLog.conversationId },
      data: {
        lastOutboundAt: sentAt,
        ...(isNudge ? { lastNudgeAt: sentAt } : {}),
      },
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
    if (!isNudge) {
      await scheduleWindowNudge(
        replyLog.conversation,
        replyLog.instagramAccount.aiSetterConfig
      );
    }
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
