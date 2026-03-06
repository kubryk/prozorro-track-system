/*
  Warnings:

  - You are about to drop the `Participant` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "Participant" DROP CONSTRAINT "Participant_contractId_fkey";

-- DropForeignKey
ALTER TABLE "Participant" DROP CONSTRAINT "Participant_tenderId_fkey";

-- AlterTable
ALTER TABLE "Contract" ADD COLUMN     "supplierEdrpou" TEXT,
ADD COLUMN     "supplierName" TEXT;

-- AlterTable
ALTER TABLE "Tender" ADD COLUMN     "customerEdrpou" TEXT,
ADD COLUMN     "customerName" TEXT;

-- DropTable
DROP TABLE "Participant";

-- DropEnum
DROP TYPE "ParticipantRole";

-- CreateIndex
CREATE INDEX "Contract_supplierEdrpou_idx" ON "Contract"("supplierEdrpou");

-- CreateIndex
CREATE INDEX "Tender_customerEdrpou_idx" ON "Tender"("customerEdrpou");
