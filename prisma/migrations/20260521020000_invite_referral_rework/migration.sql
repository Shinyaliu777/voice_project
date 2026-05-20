-- DropForeignKey
ALTER TABLE "Invitation" DROP CONSTRAINT "Invitation_claimedByUserId_fkey";

-- DropIndex
DROP INDEX "Invitation_claimedByUserId_key";

-- DropIndex
DROP INDEX "Invitation_status_idx";

-- AlterTable
ALTER TABLE "Invitation" DROP COLUMN "claimedAt",
DROP COLUMN "claimedByUserId",
DROP COLUMN "status",
ADD COLUMN     "claimCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "User" DROP COLUMN "invitationsRemaining";

