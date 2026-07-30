-- CreateEnum
CREATE TYPE "AiSetterMode" AS ENUM ('OFF', 'DRAFT', 'AUTO');

-- CreateEnum
CREATE TYPE "DmMessageDirection" AS ENUM ('IN', 'OUT');

-- CreateEnum
CREATE TYPE "DmMessageSource" AS ENUM ('PARTICIPANT', 'HUMAN', 'AI', 'CAMPAIGN');

-- CreateEnum
CREATE TYPE "AiReplyStatus" AS ENUM ('PENDING', 'SENT', 'HELD', 'SKIPPED', 'FAILED', 'DISMISSED');

-- CreateTable
CREATE TABLE "AiSetterConfig" (
    "id" TEXT NOT NULL,
    "instagramAccountId" TEXT NOT NULL,
    "mode" "AiSetterMode" NOT NULL DEFAULT 'OFF',
    "persona" TEXT,
    "goal" TEXT,
    "bookingLink" TEXT,
    "language" TEXT,
    "knowledgeEnabled" BOOLEAN NOT NULL DEFAULT true,
    "styleExamplesEnabled" BOOLEAN NOT NULL DEFAULT true,
    "minConfidence" DOUBLE PRECISION NOT NULL DEFAULT 0.78,
    "replyDelaySeconds" INTEGER NOT NULL DEFAULT 10,
    "pauseOnHumanReply" BOOLEAN NOT NULL DEFAULT true,
    "blockedUserIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiSetterConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DmConversation" (
    "id" TEXT NOT NULL,
    "instagramAccountId" TEXT NOT NULL,
    "participantId" TEXT NOT NULL,
    "participantUsername" TEXT,
    "aiEnabled" BOOLEAN NOT NULL DEFAULT true,
    "humanTakeoverAt" TIMESTAMP(3),
    "lastInboundAt" TIMESTAMP(3),
    "lastOutboundAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DmConversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DmMessage" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "mid" TEXT NOT NULL,
    "direction" "DmMessageDirection" NOT NULL,
    "source" "DmMessageSource" NOT NULL DEFAULT 'PARTICIPANT',
    "text" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DmMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiReplyLog" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "instagramAccountId" TEXT NOT NULL,
    "inboundMid" TEXT NOT NULL,
    "inboundText" TEXT NOT NULL,
    "draftText" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "shouldSend" BOOLEAN NOT NULL,
    "needsReview" BOOLEAN NOT NULL,
    "reasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "AiReplyStatus" NOT NULL DEFAULT 'PENDING',
    "sentMid" TEXT,
    "sentAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiReplyLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AiSetterConfig_instagramAccountId_key" ON "AiSetterConfig"("instagramAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "DmConversation_instagramAccountId_participantId_key" ON "DmConversation"("instagramAccountId", "participantId");

-- CreateIndex
CREATE INDEX "DmConversation_instagramAccountId_lastInboundAt_idx" ON "DmConversation"("instagramAccountId", "lastInboundAt");

-- CreateIndex
CREATE UNIQUE INDEX "DmMessage_mid_key" ON "DmMessage"("mid");

-- CreateIndex
CREATE INDEX "DmMessage_conversationId_sentAt_idx" ON "DmMessage"("conversationId", "sentAt");

-- CreateIndex
CREATE UNIQUE INDEX "AiReplyLog_inboundMid_key" ON "AiReplyLog"("inboundMid");

-- CreateIndex
CREATE INDEX "AiReplyLog_instagramAccountId_createdAt_idx" ON "AiReplyLog"("instagramAccountId", "createdAt");

-- CreateIndex
CREATE INDEX "AiReplyLog_status_idx" ON "AiReplyLog"("status");

-- AddForeignKey
ALTER TABLE "AiSetterConfig" ADD CONSTRAINT "AiSetterConfig_instagramAccountId_fkey" FOREIGN KEY ("instagramAccountId") REFERENCES "InstagramAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DmConversation" ADD CONSTRAINT "DmConversation_instagramAccountId_fkey" FOREIGN KEY ("instagramAccountId") REFERENCES "InstagramAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DmMessage" ADD CONSTRAINT "DmMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "DmConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiReplyLog" ADD CONSTRAINT "AiReplyLog_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "DmConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiReplyLog" ADD CONSTRAINT "AiReplyLog_instagramAccountId_fkey" FOREIGN KEY ("instagramAccountId") REFERENCES "InstagramAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
