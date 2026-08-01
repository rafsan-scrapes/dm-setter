import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { getWorkspaceInstagramAccount } from "@/lib/instagram-accounts";
import { prisma } from "@/lib/db/client";

const patchSchema = z.object({
  instagramAccountId: z.string().optional().nullable(),
  participantId: z.string().min(1),
  aiEnabled: z.boolean().optional(),
  /**
   * Per-thread mode: OFF, DRAFT, or AUTO. null resets the thread to the
   * account's default. Omitted leaves the current value alone.
   */
  modeOverride: z.enum(["OFF", "DRAFT", "AUTO"]).nullable().optional(),
});

// Per-thread AI state for the inbox: mode, toggle, and any held draft
// waiting for review, keyed by the participant's IGSID.
export async function GET(request: NextRequest) {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const account = await getWorkspaceInstagramAccount(
    workspaceId,
    request.nextUrl.searchParams.get("instagramAccountId")
  );
  if (!account) {
    return NextResponse.json(
      { success: false, error: "Instagram account not connected." },
      { status: 400 }
    );
  }

  const conversations = await prisma.dmConversation.findMany({
    where: { instagramAccountId: account.id },
    select: {
      participantId: true,
      participantUsername: true,
      aiEnabled: true,
      modeOverride: true,
      humanTakeoverAt: true,
      lastInboundAt: true,
      aiReplies: {
        where: { status: "HELD" },
        orderBy: { createdAt: "desc" },
        take: 1,
        select: {
          id: true,
          draftText: true,
          confidence: true,
          reasons: true,
          createdAt: true,
        },
      },
    },
  });

  return NextResponse.json({
    success: true,
    data: {
      conversations: conversations.map((conversation) => ({
        participantId: conversation.participantId,
        participantUsername: conversation.participantUsername,
        aiEnabled: conversation.aiEnabled,
        modeOverride: conversation.modeOverride,
        humanTakeoverAt: conversation.humanTakeoverAt,
        lastInboundAt: conversation.lastInboundAt,
        heldDraft: conversation.aiReplies[0] ?? null,
      })),
    },
  });
}

// Update a thread's AI state. Setting a mode (or re-enabling) clears a
// human takeover pause so the setter resumes immediately.
export async function PATCH(request: NextRequest) {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  let parsed: z.infer<typeof patchSchema>;
  try {
    parsed = patchSchema.parse(await request.json());
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid request body" },
      { status: 400 }
    );
  }

  const account = await getWorkspaceInstagramAccount(
    workspaceId,
    parsed.instagramAccountId ?? null
  );
  if (!account) {
    return NextResponse.json(
      { success: false, error: "Instagram account not connected." },
      { status: 400 }
    );
  }

  const resumesAi =
    parsed.aiEnabled === true ||
    parsed.modeOverride === "DRAFT" ||
    parsed.modeOverride === "AUTO";

  const changes = {
    ...(parsed.aiEnabled !== undefined ? { aiEnabled: parsed.aiEnabled } : {}),
    ...(parsed.modeOverride !== undefined
      ? { modeOverride: parsed.modeOverride }
      : {}),
    ...(resumesAi ? { humanTakeoverAt: null } : {}),
  };

  const conversation = await prisma.dmConversation.upsert({
    where: {
      instagramAccountId_participantId: {
        instagramAccountId: account.id,
        participantId: parsed.participantId,
      },
    },
    create: {
      instagramAccountId: account.id,
      participantId: parsed.participantId,
      aiEnabled: parsed.aiEnabled ?? true,
      modeOverride: parsed.modeOverride ?? null,
    },
    update: changes,
  });

  return NextResponse.json({ success: true, data: { conversation } });
}
