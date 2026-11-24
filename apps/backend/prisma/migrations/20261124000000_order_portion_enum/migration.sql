-- order_items.portion was a free-text column while the API only ever accepts
-- HALF / FULL / CUSTOM. A typo, a bad import or a direct SQL write could
-- therefore put an unshowable portion on a paid (and in Greece, fiscalised)
-- bill, where it later breaks the receipt and the kitchen ticket.
--
-- Tightening it to an enum makes the database refuse such a value. This is
-- deliberately a hard failure, not a silent rewrite: if any existing row holds
-- something else, the ALTER aborts and the value must be looked at by hand
-- rather than guessed into HALF/FULL.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "order_items"
    WHERE "portion" IS NOT NULL
      AND "portion" NOT IN ('HALF', 'FULL', 'CUSTOM')
  ) THEN
    RAISE EXCEPTION
      'order_items.portion holds values outside HALF/FULL/CUSTOM; fix them before migrating';
  END IF;
END $$;

CREATE TYPE "OrderPortion" AS ENUM ('HALF', 'FULL', 'CUSTOM');

ALTER TABLE "order_items"
  ALTER COLUMN "portion" TYPE "OrderPortion"
  USING ("portion"::"OrderPortion");
