-- AlterTable
ALTER TABLE "Contract" ADD COLUMN     "date" TIMESTAMP(3),
ADD COLUMN     "dateModified" TIMESTAMP(3),
ADD COLUMN     "dateSigned" TIMESTAMP(3),
ADD COLUMN     "status" TEXT,
ALTER COLUMN "dateCreated" DROP NOT NULL,
ALTER COLUMN "dateCreated" DROP DEFAULT;

-- AlterTable
ALTER TABLE "Participant" ADD COLUMN     "contractId" TEXT;

-- CreateIndex
CREATE INDEX "Participant_contractId_idx" ON "Participant"("contractId");

-- AddForeignKey
ALTER TABLE "Participant" ADD CONSTRAINT "Participant_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "Contract"("id") ON DELETE SET NULL ON UPDATE CASCADE;
