-- AlterTable
ALTER TABLE "Automation" ADD COLUMN     "aiPersonalizeDm" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "AiSetterConfig" ADD COLUMN     "windowNudgeEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "windowNudgeHours" INTEGER NOT NULL DEFAULT 20;

-- AlterTable
ALTER TABLE "DmConversation" ADD COLUMN     "lastNudgeAt" TIMESTAMP(3),
ADD COLUMN     "modeOverride" "AiSetterMode";
