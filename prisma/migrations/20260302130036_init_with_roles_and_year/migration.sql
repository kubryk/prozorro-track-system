/*
  Warnings:

  - A unique constraint covering the columns `[tenderId,edrpou,role]` on the table `Participant` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `role` to the `Participant` table without a default value. This is not possible if the table is not empty.
  - Added the required column `year` to the `Tender` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "ParticipantRole" AS ENUM ('CUSTOMER', 'SUPPLIER');

-- DropIndex
DROP INDEX "Participant_tenderId_edrpou_key";

-- AlterTable
ALTER TABLE "Participant" ADD COLUMN     "role" "ParticipantRole" NOT NULL;

-- AlterTable
ALTER TABLE "Tender" ADD COLUMN     "year" INTEGER NOT NULL;

-- CreateIndex
CREATE INDEX "Participant_edrpou_idx" ON "Participant"("edrpou");

-- CreateIndex
CREATE INDEX "Participant_role_idx" ON "Participant"("role");

-- CreateIndex
CREATE UNIQUE INDEX "Participant_tenderId_edrpou_role_key" ON "Participant"("tenderId", "edrpou", "role");
