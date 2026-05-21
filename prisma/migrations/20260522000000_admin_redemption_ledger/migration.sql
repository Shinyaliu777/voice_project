-- Add admin/moderation + persistent bonus minute bucket to User.
ALTER TABLE "User"
  ADD COLUMN "bonusMinutes" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "isAdmin"      BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "isSuspended"  BOOLEAN NOT NULL DEFAULT false;

-- =========================================================
-- RedemptionCode: admin-issued "gift" codes that grant the
-- redeemer N minutes (lecsync's 兑换码).
-- =========================================================
CREATE TABLE "RedemptionCode" (
    "id"          TEXT      NOT NULL,
    "code"        TEXT      NOT NULL,
    "minutes"     INTEGER   NOT NULL,
    "maxUses"     INTEGER   NOT NULL DEFAULT 1,
    "usedCount"   INTEGER   NOT NULL DEFAULT 0,
    "expiresAt"   TIMESTAMP(3),
    "note"        TEXT,
    "isActive"    BOOLEAN   NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RedemptionCode_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RedemptionCode_code_key" ON "RedemptionCode"("code");
CREATE INDEX "RedemptionCode_createdById_idx" ON "RedemptionCode"("createdById");

ALTER TABLE "RedemptionCode"
  ADD CONSTRAINT "RedemptionCode_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- =========================================================
-- Redemption: one row per (user, code) successful redemption.
-- Prevents double-redeem and provides an audit trail.
-- =========================================================
CREATE TABLE "Redemption" (
    "id"             TEXT      NOT NULL,
    "codeId"         TEXT      NOT NULL,
    "userId"         TEXT      NOT NULL,
    "minutesGranted" INTEGER   NOT NULL,
    "redeemedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Redemption_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Redemption_codeId_userId_key" ON "Redemption"("codeId", "userId");
CREATE INDEX "Redemption_userId_idx" ON "Redemption"("userId");

ALTER TABLE "Redemption"
  ADD CONSTRAINT "Redemption_codeId_fkey"
    FOREIGN KEY ("codeId") REFERENCES "RedemptionCode"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Redemption"
  ADD CONSTRAINT "Redemption_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- =========================================================
-- MinuteTransaction: append-only ledger of bonusMinutes
-- changes (admin grants, redemptions, future stripe purchases).
-- Used by the user-side "查看历史交易流水记录" dialog.
-- =========================================================
CREATE TABLE "MinuteTransaction" (
    "id"           TEXT      NOT NULL,
    "userId"       TEXT      NOT NULL,
    "delta"        INTEGER   NOT NULL,
    "kind"         TEXT      NOT NULL,
    "description"  TEXT      NOT NULL,
    "metadata"     JSONB,
    "balanceAfter" INTEGER   NOT NULL,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MinuteTransaction_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "MinuteTransaction_userId_createdAt_idx"
  ON "MinuteTransaction"("userId", "createdAt" DESC);

ALTER TABLE "MinuteTransaction"
  ADD CONSTRAINT "MinuteTransaction_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
