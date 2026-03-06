-- AlterTable
ALTER TABLE "Tender" ADD COLUMN     "amount" DOUBLE PRECISION,
ADD COLUMN     "currency" TEXT,
ADD COLUMN     "title" TEXT;

-- CreateTable
CREATE TABLE "Contract" (
    "id" TEXT NOT NULL,
    "contractID" TEXT,
    "amount" DOUBLE PRECISION,
    "currency" TEXT,
    "valueAddedTaxIncluded" BOOLEAN,
    "amountNet" DOUBLE PRECISION,
    "tenderId" TEXT NOT NULL,
    "dateCreated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Contract_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "Contract" ADD CONSTRAINT "Contract_tenderId_fkey" FOREIGN KEY ("tenderId") REFERENCES "Tender"("id") ON DELETE CASCADE ON UPDATE CASCADE;
