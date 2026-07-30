import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { getWorkspaceInstagramAccount } from "@/lib/instagram-accounts";
import { prisma } from "@/lib/db/client";

const toggleSchema = z.object({
  instagramAccountId: z.string().optional().nullable(),
  participantId: z.string().min(1),
  aiEnabled: z.boolean(),
});

// Read per-thread AI state for the inbox (keyed by participant IGSID).
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
      humanTakeoverAt: true,
      lastInboundAt: true,
    },
  });

  return NextResponse.json({ success: true, data: { conversations } });
}

// Toggle the AI setter for one thread. Re-enabling clears a human
// takeover pause so the setter resumes immediately.
export async function PATCH(request: NextRequest) {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  let parsed: z.infer<typeof toggleSchema>;
  try {
    parsed = toggleSchema.parse(await request.json());
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
      aiEnabled: parsed.aiEnabled,
    },
    update: {
      aiEnabled: parsed.aiEnabled,
      ...(parsed.aiEnabled ? { humanTakeoverAt: null } : {}),
    },
  });

  return NextResponse.json({ success: true, data: { conversation } });
}
