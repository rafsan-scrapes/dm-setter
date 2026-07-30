import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import { sendAiReply } from "@/lib/ai-setter/send";

type RouteProps = { params: Promise<{ id: string }> };

const actionSchema = z.object({
  action: z.enum(["approve", "dismiss"]),
  /** Optional human edit applied before an approved send. */
  text: z.string().max(1000).optional(),
});

// Approve (send) or dismiss a held AI draft.
export async function POST(request: NextRequest, { params }: RouteProps) {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const { id } = await params;

  let parsed: z.infer<typeof actionSchema>;
  try {
    parsed = actionSchema.parse(await request.json());
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid request body" },
      { status: 400 }
    );
  }

  const replyLog = await prisma.aiReplyLog.findUnique({
    where: { id },
    include: {
      instagramAccount: { select: { workspaceId: true } },
    },
  });
  if (!replyLog || replyLog.instagramAccount.workspaceId !== workspaceId) {
    return NextResponse.json(
      { success: false, error: "Draft not found" },
      { status: 404 }
    );
  }

  if (parsed.action === "dismiss") {
    if (replyLog.status === "SENT") {
      return NextResponse.json(
        { success: false, error: "This reply was already sent." },
        { status: 409 }
      );
    }
    const updated = await prisma.aiReplyLog.update({
      where: { id },
      data: { status: "DISMISSED" },
    });
    return NextResponse.json({ success: true, data: { reply: updated } });
  }

  if (replyLog.status !== "HELD" && replyLog.status !== "FAILED") {
    return NextResponse.json(
      { success: false, error: "Only held or failed drafts can be approved." },
      { status: 409 }
    );
  }

  const result = await sendAiReply({
    replyLogId: id,
    textOverride: parsed.text,
  });
  if (!result.ok) {
    // Surface Meta's own error text; the usual case is the 24-hour
    // messaging window having closed since the draft was created.
    return NextResponse.json(
      { success: false, error: result.message ?? "Send failed" },
      { status: result.error === "not_found" ? 404 : 502 }
    );
  }

  const updated = await prisma.aiReplyLog.findUnique({ where: { id } });
  return NextResponse.json({ success: true, data: { reply: updated } });
}
