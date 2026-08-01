/**
 * DM reconciliation sweep: the safety net for missed message webhooks.
 *
 * The comment side has had a polling reconciler from day one; this is
 * the same idea for DMs. Every sweep pulls each connected account's
 * recent conversations from Meta, backfills any message the local
 * mirror is missing (webhook outages, deploy gaps, Meta hiccups), and,
 * when the missed message is the thread's latest and still inside the
 * 24h reply window, enqueues it through the normal setter pipeline so
 * a prospect never sits unanswered because a webhook got lost.
 *
 * Mirror-only writes are idempotent (unique mid), and the setter job id
 * matches the webhook path's, so a race between sweep and webhook can
 * never double-process a message.
 */

import { prisma } from "@/lib/db/client";
import {
  getConversations,
  getConversationMessages,
  MetaApiError,
} from "@/lib/meta/client";
import { decryptToken } from "@/lib/meta/oauth";
import { getDMQueue, INBOUND_DM_JOB_NAME } from "@/lib/queue/client";
import { Prisma } from "@/app/generated/prisma/client";

const WINDOW_MS = 24 * 60 * 60 * 1000;
/** Newest threads first; a sweep never needs to touch cold history. */
const MAX_THREADS_PER_ACCOUNT = Number(
  process.env.DM_SWEEP_MAX_THREADS ?? 25
);

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}

interface SweepStats {
  accounts: number;
  backfilled: number;
  enqueued: number;
}

async function sweepAccount(account: {
  id: string;
  instagramId: string;
  accessToken: string;
}): Promise<{ backfilled: number; enqueued: number }> {
  const accessToken = decryptToken(account.accessToken);
  const threads = await getConversations(accessToken, account.instagramId);
  let backfilled = 0;
  let enqueued = 0;

  for (const thread of threads.slice(0, MAX_THREADS_PER_ACCOUNT)) {
    const participants = thread.participants?.data ?? [];
    const contact = participants.find((p) => p.id !== account.instagramId);
    if (!contact?.id) continue;

    const conversation = await prisma.dmConversation.upsert({
      where: {
        instagramAccountId_participantId: {
          instagramAccountId: account.id,
          participantId: contact.id,
        },
      },
      create: {
        instagramAccountId: account.id,
        participantId: contact.id,
        participantUsername: contact.username ?? null,
      },
      // The sweep is also where usernames get learned; webhooks never
      // carry them.
      update: contact.username
        ? { participantUsername: contact.username }
        : {},
    });

    const messages = await getConversationMessages(accessToken, thread.id);
    // Meta returns newest first; walk oldest first so timestamps land in
    // order and "newest missed inbound" is simply the last one we add.
    const ordered = [...(messages ?? [])].reverse();
    let newestMissedInbound: { mid: string; text: string; sentAt: Date } | null =
      null;

    for (const message of ordered) {
      const mid = message.id;
      const text = message.message?.trim();
      if (!mid || !text) continue;
      const isEcho = message.from?.id === account.instagramId;
      const sentAt = message.created_time
        ? new Date(message.created_time)
        : new Date();

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
        if (isUniqueViolation(error)) continue; // mirror already has it
        throw error;
      }

      backfilled += 1;
      if (!isEcho) {
        newestMissedInbound = { mid, text, sentAt };
      } else {
        newestMissedInbound = null;
      }

      // Keep the window anchors truthful for backfilled traffic.
      await prisma.dmConversation.update({
        where: { id: conversation.id },
        data: isEcho
          ? { lastOutboundAt: sentAt }
          : { lastInboundAt: sentAt },
      });
    }

    // A missed inbound that is still the last word in the thread means a
    // prospect is waiting. Hand it to the normal pipeline if the reply
    // window is still open. The deterministic job id makes this a no-op
    // when the webhook actually did arrive.
    if (
      newestMissedInbound &&
      Date.now() - newestMissedInbound.sentAt.getTime() < WINDOW_MS
    ) {
      await getDMQueue().add(
        INBOUND_DM_JOB_NAME,
        {
          instagramAccountId: account.instagramId,
          participantId: contact.id,
          mid: newestMissedInbound.mid,
          text: newestMissedInbound.text,
          isEcho: false,
          timestamp: newestMissedInbound.sentAt.getTime(),
        },
        {
          jobId: `dm_${newestMissedInbound.mid.replace(/[^a-zA-Z0-9_-]/g, "_")}`,
        }
      );
      enqueued += 1;
    }
  }

  return { backfilled, enqueued };
}

/** Sweep every connected account that has the AI setter configured. */
export async function reconcileDms(): Promise<SweepStats> {
  const accounts = await prisma.instagramAccount.findMany({
    where: { aiSetterConfig: { isNot: null } },
    select: { id: true, instagramId: true, accessToken: true },
  });

  const stats: SweepStats = { accounts: accounts.length, backfilled: 0, enqueued: 0 };

  for (const account of accounts) {
    try {
      const result = await sweepAccount(account);
      stats.backfilled += result.backfilled;
      stats.enqueued += result.enqueued;
    } catch (error: unknown) {
      const message =
        error instanceof MetaApiError
          ? `Meta API Error ${error.code}: ${error.message}`
          : error instanceof Error
            ? error.message
            : "Unknown error";
      console.error(
        `[DM Reconciler] Sweep failed for account ${account.instagramId}:`,
        message
      );
    }
  }

  if (stats.backfilled > 0) {
    console.log(
      `[DM Reconciler] Backfilled ${stats.backfilled} messages, enqueued ${stats.enqueued} for the setter`
    );
  }
  return stats;
}
