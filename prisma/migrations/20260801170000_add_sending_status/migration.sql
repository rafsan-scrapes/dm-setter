-- AlterEnum
ALTER TYPE "AiReplyStatus" ADD VALUE 'SENDING';

-- AlterTable
ALTER TABLE "AiReplyLog" ADD COLUMN     "humanEdited" BOOLEAN NOT NULL DEFAULT false;
