-- AlterTable
ALTER TABLE "User" ADD COLUMN     "maxConcurrentRecordings" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "RecordingSlot" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT,
    "status" TEXT NOT NULL,
    "queuePosition" INTEGER,
    "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "releasedAt" TIMESTAMP(3),

    CONSTRAINT "RecordingSlot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RecordingSlot_userId_status_idx" ON "RecordingSlot"("userId", "status");

-- AddForeignKey
ALTER TABLE "RecordingSlot" ADD CONSTRAINT "RecordingSlot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
