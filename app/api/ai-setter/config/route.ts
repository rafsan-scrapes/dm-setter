import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { getWorkspaceInstagramAccount } from "@/lib/instagram-accounts";
import { prisma } from "@/lib/db/client";
import { getKnowledgeBackend } from "@/lib/ai-setter/knowledge";

const configSchema = z.object({
  instagramAccountId: z.string().optional().nullable(),
  mode: z.enum(["OFF", "DRAFT", "AUTO"]),
  persona: z.string().max(4000).optional().nullable(),
  goal: z.string().max(2000).optional().nullable(),
  bookingLink: z.string().max(500).optional().nullable(),
  language: z.string().max(40).optional().nullable(),
  knowledgeEnabled: z.boolean(),
  styleExamplesEnabled: z.boolean(),
  minConfidence: z.number().min(0).max(1),
  replyDelaySeconds: z.number().int().min(0).max(600),
  pauseOnHumanReply: z.boolean(),
  windowNudgeEnabled: z.boolean(),
  windowNudgeHours: z.number().int().min(1).max(23),
  blockedUserIds: z.array(z.string().max(64)).max(500),
});

// Read the setter config for one connected account (defaults when unset).
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

  const config = await prisma.aiSetterConfig.findUnique({
    where: { instagramAccountId: account.id },
  });

  return NextResponse.json({
    success: true,
    data: {
      account: {
        id: account.id,
        username: account.username,
        instagramId: account.instagramId,
      },
      knowledgeConfigured: getKnowledgeBackend() !== null,
      knowledgeBackend: getKnowledgeBackend(),
      config: config ?? {
        mode: "OFF",
        persona: null,
        goal: null,
        bookingLink: null,
        language: null,
        knowledgeEnabled: true,
        styleExamplesEnabled: true,
        minConfidence: 0.78,
        replyDelaySeconds: 10,
        pauseOnHumanReply: true,
        windowNudgeEnabled: false,
        windowNudgeHours: 20,
        blockedUserIds: [],
      },
    },
  });
}

// Create or update the setter config for one connected account.
export async function PUT(request: NextRequest) {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  let parsed: z.infer<typeof configSchema>;
  try {
    parsed = configSchema.parse(await request.json());
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid config payload" },
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

  const values = {
    mode: parsed.mode,
    persona: parsed.persona?.trim() || null,
    goal: parsed.goal?.trim() || null,
    bookingLink: parsed.bookingLink?.trim() || null,
    language: parsed.language?.trim() || null,
    knowledgeEnabled: parsed.knowledgeEnabled,
    styleExamplesEnabled: parsed.styleExamplesEnabled,
    minConfidence: parsed.minConfidence,
    replyDelaySeconds: parsed.replyDelaySeconds,
    pauseOnHumanReply: parsed.pauseOnHumanReply,
    windowNudgeEnabled: parsed.windowNudgeEnabled,
    windowNudgeHours: parsed.windowNudgeHours,
    blockedUserIds: parsed.blockedUserIds,
  };

  const config = await prisma.aiSetterConfig.upsert({
    where: { instagramAccountId: account.id },
    create: { instagramAccountId: account.id, ...values },
    update: values,
  });

  return NextResponse.json({ success: true, data: { config } });
}
