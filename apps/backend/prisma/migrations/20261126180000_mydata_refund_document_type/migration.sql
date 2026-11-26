-- myDATA corrections are always new documents, never edits: a refund of a paid
-- sale becomes its own receipt (IsReturn/IsRefund), separate from the sale row.

CREATE TYPE "MyDataDocumentType" AS ENUM ('SALE', 'REFUND');

ALTER TABLE "MyDataReceipt"
  ADD COLUMN "documentType" "MyDataDocumentType" NOT NULL DEFAULT 'SALE';

-- Set on REFUND rows only: which refund caused this document. The unique index
-- is the idempotency guard, so a retried refund cannot fiscalise twice.
ALTER TABLE "MyDataReceipt" ADD COLUMN "refundId" TEXT;
CREATE UNIQUE INDEX "MyDataReceipt_refundId_key" ON "MyDataReceipt"("refundId");

-- Set on REFUND rows only: the sale receipt being reversed, used for
-- cbPreviousReceiptReference / ftReceiptCaseData.GR.PreviousReceiptReference.
ALTER TABLE "MyDataReceipt" ADD COLUMN "originalReceiptId" TEXT;
