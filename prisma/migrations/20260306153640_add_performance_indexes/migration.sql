-- CreateIndex
CREATE INDEX "Contract_contractID_idx" ON "Contract"("contractID");

-- CreateIndex
CREATE INDEX "Contract_tenderId_idx" ON "Contract"("tenderId");

-- CreateIndex
CREATE INDEX "Contract_status_idx" ON "Contract"("status");

-- CreateIndex
CREATE INDEX "Contract_dateModified_idx" ON "Contract"("dateModified");

-- CreateIndex
CREATE INDEX "Tender_tenderID_idx" ON "Tender"("tenderID");

-- CreateIndex
CREATE INDEX "Tender_year_idx" ON "Tender"("year");

-- CreateIndex
CREATE INDEX "Tender_status_idx" ON "Tender"("status");

-- CreateIndex
CREATE INDEX "Tender_dateModified_idx" ON "Tender"("dateModified");

-- CreateIndex
CREATE INDEX "Tender_syncStatus_idx" ON "Tender"("syncStatus");
