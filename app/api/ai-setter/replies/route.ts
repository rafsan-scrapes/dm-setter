import { NextRequest, NextResponse } from "next/server";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { getWorkspaceInstagramAccount } from "@/lib/instagram-accounts";
import { prisma } from "@/lib/db/client";
import type { AiReplyStatus } from "@/app/generated/prisma/client";

const STATUS_VALUES: AiReplyStatus[] = [
  "PENDING",
  "SENT",
  "HELD",
  "SKIPPED",
  "FAILED",
  "DISMISSED",
];

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// Activity feed: every draft the setter produced, newest first.
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

  const statusParam = request.nextUrl.searchParams.get("status");
  const status = STATUS_VALUES.find((value) => value === statusParam);
  const limitParam = Number(request.nextUrl.searchParams.get("limit"));
  const limit = Number.isFinite(limitParam)
    ? Math.min(Math.max(Math.trunc(limitParam), 1), MAX_LIMIT)
    : DEFAULT_LIMIT;

  const replies = await prisma.aiReplyLog.findMany({
    where: {
      instagramAccountId: account.id,
      ...(status ? { status } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: limit,
    include: {
      conversation: {
        select: {
          id: true,
          participantId: true,
          participantUsername: true,
          aiEnabled: true,
        },
      },
    },
  });

  return NextResponse.json({ success: true, data: { replies } });
}
