/**
 * mydata.service.ts — myDATA Belegsignierung via fiskaltrust CloudCashbox (Greece)
 *
 * Ruft die fiskaltrust CloudCashbox SaaS REST-API auf, um jeden Kassenbeleg
 * an AADE myDATA zu übermitteln (gesetzlich vorgeschriebene Echtzeit-Übermittlung).
 * Die API gibt MARK, UID, Authentication Code und QR-Code-URL zurück.
 *
 * Architektur (parallel zu verifactu.service.ts ES):
 *   - recordPaidOrder(): wird in derselben Prisma-Transaktion wie der Checkout
 *     aufgerufen (atomic — eine nicht signierte bezahlte Bestellung gibt es nicht)
 *   - Der fiskale Record wird in der DB gespeichert (MyDataReceipt Tabelle)
 *   - Die Übermittlung erfolgt asynchron nach Commit (wie AEAT)
 *   - Bei Ausfall der CloudCashbox: Retry-Cron alle 5 Minuten
 *
 * HTTP: native fetch (Node 18+, built-in). Kein @nestjs/axios — verifactu
 * nutzt ebenfalls native node:https, das Projekt hat keine axios-Dependency.
 *
 * fiskaltrust PosSystem API v2 für Griechenland:
 *   POST /v2/sign       — Beleg signieren + an myDATA übermitteln
 *                         (auch Storno: Void-Receipt-Case via /v2/sign)
 *   POST /v2/echo       — Connectivity-Check
 *
 * Auth (PosSystem API v2-Modell): Header x-cashbox-id, x-cashbox-accesstoken,
 * x-operation-id (Idempotency-Key, pro Beleg/Operation frisch).
 *
 * CloudCashbox URL:
 *   Sandbox:     https://pos-api-sandbox.fiskaltrust.cloud
 *   Produktion:  https://pos-api.fiskaltrust.cloud
 *
 * Env-Konfiguration:
 *   MYDATA_ENABLED       — "true" aktiviert das Modul
 *   MYDATA_PROVIDER_URL  — CloudCashbox Basis-URL (sandbox oder produktion);
 *                          eine /v2/<cashboxId>-Komponente im Pfad wird ignoriert
 *   MYDATA_CASHBOX_ID   — (optional) explizite CashBox-ID; sonst wird die GUID
 *                          aus MYDATA_PROVIDER_URL oder der VAT-Wert genutzt
 *   MYDATA_API_KEY       — CashBox Access Token (aus kds-app-secret)
 *   MYDATA_VAT_NUMBER    — USt-IdNr des Restaurants (ELXXXXXXXXX)
 *
 * Signature Items (ftSignatures in der Response):
 *   001 PosReceipt              — QR-Code URL (digital receipt)
 *   012 UniqueDocumentIdentifier — Μοναδικός αριθμός παραστατικού
 *   013 Uid                     — invoiceUid (myDATA hash)
 *   014 Mark                    — invoiceMark (AADE Registrierungsnummer)
 *   015 AuthenticationCode      — Verifizierungs-Code
 *   011 ProviderSignature       — Provider-Footer (nur Route 1: licensed provider)
 *   016 TransmissionFailure     — Verbindungsverlust-Hinweis (drucken!)
 *
 * License: AGPL-3.0-only (same as OrderRestro)
 */

import {
  BadRequestException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { AuditService } from '../../audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';

type Tx = Prisma.TransactionClient;

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * fiskaltrust PosSystem API v2 — Request body for POST /v2/pos
 *
 * Greek receipt cases use ftReceiptCase with country code GR (0x4752).
 * The base cases for retail receipts:
 *   0x4752_2000_0000_0001 — POS receipt (retail sales, 11.1)
 *   0x4752_2000_0000_0002 — Payment transfer receipt (8.4)
 *
 * Charge item cases (ftChargeItemCase) carry the Greek VAT rate in the
 * low nibble (V): 3 = Normal (24%), 1 = Discounted-1, 2 = Discounted-2,
 * 4 = Super-reduced-1, 5 = Super-reduced-2, 7 = Zero, 8 = Not taxable.
 * The Service (S) nibble: 1 = Delivery (goods), 2 = Service, 3 = Tip.
 *
 * Pay item cases (ftPayItemCase) carry the country code and payment method.
 *
 * Source: https://docs.fiskaltrust.cloud/docs/poscreators/middleware-doc/greece/reference-tables/ftchargeitemcase
 */
interface FtPosRequest {
  ftCashBoxID: string;
  ftQueueID?: string; // optional routing instruction (null in v2 when unset)
  ftPosSystemId?: string; // identifies the POS software — checked by Portal basic receipt validation
  cbTerminalID: string;
  cbReceiptReference: string;
  cbReceiptMoment: string; // ISO 8601
  // PosSystem API v2 names this field ftReceiptCase (uint64). The v0 name
  // cbReceiptCase is not part of the v2 model: sending it leaves ftReceiptCase
  // at its default 0, which the Portal validation reports as "ReceiptCase
  // invalid" for every receipt.
  ftReceiptCase: bigint;
  // v0's cbReceiptAmounts[] array does not exist in v2 — the request carries
  // one optional gross total instead.
  cbReceiptAmount?: number;
  cbChargeItems?: FtChargeItem[];
  cbPayItems?: FtPayItem[];
  cbArea?: string; // table number for restaurant orders (8.6)
  cbCustomer?: FtCustomer;
}

interface FtAmount {
  ftAmount: number;
  ftTaxCR?: number; // VAT category code (myDATA VAT category)
}

interface FtChargeItem {
  // v2 ChargeItem requires Quantity, Description, Amount and VATRate.
  // Amount defaults to 0 when omitted — that is why v0-style ftChargeAmount
  // payloads showed 0 EUR for every receipt in the ReceiptJournal.
  Quantity: number;
  Description: string;
  Amount: number;
  VATRate: number;
  Position?: number;
  ftChargeItemCase?: bigint; // carries VAT rate + service type
  ftChargeItemCaseData?: unknown;
}

interface FtPayItem {
  Description: string;
  Amount: number;
  Position?: number;
  ftPayItemCase?: bigint;
}

interface FtCustomer {
  CustomerCountry?: string; // GR, EL, EU, or ISO code
  CustomerName?: string;
  CustomerZip?: string;
  CustomerCity?: string;
}

/**
 * fiskaltrust PosSystem API v2 — Response
 *
 * NOTE: ftReceiptCase and ftSignatureType are Int64 in the fiskaltrust API.
 * JSON.parse may lose precision on these fields. We handle that by
 * matching signatures also by caption (human-readable text) as fallback.
 */
interface FtPosResponse {
  ftCashBoxID: string;
  ftQueueID: string;
  ftQueueItemID: number;
  ftQueueRow: number;
  ftReceiptJournal: {
    ftReceiptNumber: number;
    ftReceiptMoment: string;
    ftReceiptCase: number;
    ftReceiptIdentification: string;
    ftReceiptHash: string;
  };
  ftSignatures: FtSignature[];
  // v2 returns the state as a uint64. Declared as a string here because the
  // digits must not pass through a JS number: 0x4752200000000000 (READY) is
  // logged as …246000 instead of …246080, which makes a healthy queue look like
  // it carries an error flag.
  ftState?: string;
  ftStateData?: string;
  // The middleware echoes the processed line items. They carry the amounts it
  // actually booked, which is our only server-side proof of what the
  // ReceiptJournal displays.
  ftChargeItems?: Array<{ description?: string; amount?: number; vatRate?: number }>;
  ftPayItems?: Array<{ description?: string; amount?: number }>;
}

interface FtSignature {
  ftSignatureType: number;
  // v2 spells these lower-case; older payloads use the C# property names.
  ftSignature?: string;
  data?: string;
  ftSignatureCaption?: string;
  caption?: string;
  ftSignatureFormat: number;  // 1 = QR, 2 = Text, 3 = Base64
}

/** Parsed signature items for receipt printing */
export interface ReceiptMyData {
  qrCodeUrl: string;        // PosReceipt (001) — digital receipt URL → QR on bon
  mark: string;             // invoiceMark (014) — AADE registration number
  uid: string;              // invoiceUid (013) — myDATA hash
  authenticationCode: string; // (015) — verification code
  uniqueDocumentIdentifier: string; // (012) — Μοναδικός αριθμός παραστατικού
  receiptNumber: number;    // ftReceiptNumber
  timestamp: string;        // ftReceiptMoment
  hash: string;             // ftReceiptHash
  transmissionFailure: boolean; // (016) — connection loss flag
  providerFooter: string | null; // (011) — provider legal name (Route 1 only)
  sandbox: boolean;
}

// ─── Greek-specific constants (BigInt — Int64, not safe in Number) ────────────

// Country code GR in hex (ASCII 'G'=0x47, 'R'=0x52) → bytes 8-7 of ftReceiptCase
const COUNTRY_GR = 0x4752000000000000n;

// Receipt cases — version 2, POS receipt (retail sale, myDATA 11.1)
// Format: CCCC_vlll_gggg_txcc
//   CCCC = country (0x4752 = "GR"), v = 2, then llll/gggg flags, txcc = type+case
// The version nibble sits in bits 61-64 (0x0000_2000_0000_0000). A mask of
// 0x2000_0000_0000_0000 instead sets bit 62 and corrupts the country code
// (0x4752 | 0x2000 becomes 0x6752), which fiskaltrust rejects as an invalid
// ReceiptCase.
const RECEIPT_CASE_POS_RECEIPT = COUNTRY_GR | 0x0000200000000001n;

// Payment transfer receipt (myDATA 8.4) — used for void/cancel referencing
const RECEIPT_CASE_VOID = COUNTRY_GR | 0x0000200000000002n;

// ftChargeItemCase: CCCC_vlll_gggg_NNSV
//   V (lowest nibble) = VAT rate code, S (second nibble) = type of service,
//   NN (bits 8-15) = nature of VAT (00 = usual VAT applies)
//   S=1 (delivery/supply of goods) therefore sets 0x10.
//
// V is deliberately left at 0 ("Unknown VAT rate"): the documentation states
// that the rate is then resolved from the saved VAT-rates table using the
// VATRate field, and that omitting the case entirely falls back to the VATRate
// at the point of sale. Guessing the code-percentage mapping produced
// "VATRate '6' is invalid for the given Type of VAT '0000000000000004'",
// because V=4 is not the 6% rate.
// Source: docs.fiskaltrust.cloud/.../greece/reference-tables/ftchargeitemcase
const CHARGE_ITEM_BASE = COUNTRY_GR | 0x0000200000000010n; // v=2, NN=00, S=1, V=0 (resolved from VATRate)
const VAT_NORMAL        = 3n; // Normal VAT rate (24%)
const VAT_DISCOUNTED_1  = 1n; // Discounted-1 VAT rate (13%)
const VAT_DISCOUNTED_2  = 2n; // Discounted-2 VAT rate
const VAT_SUPER_REDUCED = 4n; // Super-reduced-1 VAT rate
const VAT_ZERO          = 7n; // Zero VAT rate (0%)
const VAT_NOT_TAXABLE   = 8n; // Not Taxable
// NOTE: these are rate *codes*, not percentages. The percentage a code stands
// for is defined by the fiscal VAT-rates table and must not be inferred here.

/**
 * VAT rates in force in Greece.
 *
 * Source: European Commission, "VAT rates applied in EU member countries" —
 * Greece (EL): standard 24%, reduced 6 / 13 / 17%, super-reduced 4%.
 * aade.gr/en/.../basic-vat-rates refuses automated requests (403 via Akamai),
 * so the Commission table is used; it is the reference fiskaltrust links to
 * from its own GST/VAT documentation.
 *
 * Also covered: 9% (island rates, reduced by 30% from 2024/2026) and 0%.
 *
 * This set is a local guard only. A rate outside it can never be fiscalised in
 * Greece, and fiskaltrust only reports that after a full submit round-trip —
 * which burns retries and hides the real cause, namely wrong article data.
 */
const GREEK_VAT_RATES = new Set([0, 4, 6, 9, 13, 17, 24]);

// ftPayItemCase: CCCC_vlll_gggg_xxPP — PP is the payment type byte
//   01 = cash, 04 = POS/e-POS (card terminal)
// Source: docs.fiskaltrust.cloud/.../greece/reference-tables/ftpayitemcase
const PAY_CASH = COUNTRY_GR | 0x0000200000000001n; // PP=01 cash
const PAY_CARD = COUNTRY_GR | 0x0000200000000004n; // PP=04 POS/e-POS

// Global flag (gggg) marking a charge item as a discount line (= 0x0004 at
// hex positions 9-12, i.e. bits 16-19). A discount is a negative amount on the
// same VAT rate as the discounted lines.
// Source: docs.fiskaltrust.cloud/.../greece/reference-tables/ftchargeitemcase Table 4
const DISCOUNT_FLAG = 0x0000000000040000n;

const BATCH = 100;
const API_TIMEOUT = 15_000; // CloudCashbox may take time for myDATA round-trip
const MAX_RETRIES = 10;     // before a PENDING receipt moves to FAILED

// ─── Signature matching helpers ──────────────────────────────────────────────

/**
 * Match a signature by its SignatureCase (low 12 bits of ftSignatureType).
 *
 * fiskaltrust returns ftSignatureType as a country-coded Int64
 * (e.g. 0x4752000000000014 for invoiceMark). The low 12 bits (sss)
 * identify the signature kind. We use bitwise on the number — if
 * precision was lost in JSON.parse, we fall back to caption matching.
 *
 * Source: docs.fiskaltrust.cloud/.../ftsignaturetype Table 3
 */
function matchSigByCase(sigs: FtSignature[], sss: number): FtSignature | undefined {
  return sigs.find(s => (s.ftSignatureType & 0xfff) === sss);
}

function matchSigByCaption(sigs: FtSignature[], captionIncludes: string): FtSignature | undefined {
  return sigs.find(s =>
    s.ftSignatureCaption?.toLowerCase().includes(captionIncludes.toLowerCase()),
  );
}

// ─── Service ──────────────────────────────────────────────────────────────────

@Injectable()
export class MyDataService {
  private readonly logger = new Logger(MyDataService.name);
  private sending = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
  ) {}

  // ─── Config ────────────────────────────────────────────────────────────────

  private get providerUrl(): string {
    const url = this.config.get<string>('MYDATA_PROVIDER_URL')
      ?? 'https://pos-api-sandbox.fiskaltrust.cloud';
    // PosSystem API v2 is addressed by base host + x-cashbox-id header.
    // Older installer configs embedded the cashbox ID in the path
    // (/v2/<cashboxId>) — strip it so endpoints resolve to /v2/sign etc.
    return url
      .replace(/\/(?=\/|$)/, '')
      .replace(/\/v2\/[0-9a-fA-F-]{32,36}$/, '');
  }

  /**
   * CashBox identifier for the x-cashbox-id header. Preferred source: explicit
   * MYDATA_CASHBOX_ID; fallback: the GUID embedded in MYDATA_PROVIDER_URL;
   * last resort: the configured VAT number (legacy installer behavior).
   */
  private get cashboxId(): string {
    const explicit = this.config.get<string>('MYDATA_CASHBOX_ID');
    if (explicit) return explicit.trim();
    const fromUrl = this.config
      .get<string>('MYDATA_PROVIDER_URL')
      ?.match(/\/v2\/([0-9a-fA-F-]{32,36})\/?$/)?.[1];
    return fromUrl ?? this.vatNumber;
  }

  private get apiKey(): string {
    return this.config.getOrThrow<string>('MYDATA_API_KEY');
  }

  /**
   * Queue identifier for ftQueueID. ftQueueID is a routing instruction, not the
   * cash box identity: sending the cashbox GUID makes the field semantically
   * wrong and hides the real queue. Prefer an explicit MYDATA_QUEUE_ID; the
   * field stays optional in v2, so an unset value is omitted rather than faked.
   */
  private get queueId(): string | undefined {
    const explicit = this.config.get<string>('MYDATA_QUEUE_ID');
    return explicit ? explicit.trim() : undefined;
  }

  private get vatNumber(): string {
    return this.config.getOrThrow<string>('MYDATA_VAT_NUMBER');
  }

  get isSandbox(): boolean {
    return this.providerUrl.includes('sandbox');
  }

  get isEnabled(): boolean {
    return this.config.get<string>('MYDATA_ENABLED') === 'true'
      && !!this.config.get<string>('MYDATA_API_KEY');
  }

  // ─── Health Check ──────────────────────────────────────────────────────────

  /**
   * Prüft, ob die CloudCashbox SaaS erreichbar ist.
   */
  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${this.providerUrl}/v2/echo`, {
        method: 'POST',
        headers: this.authHeaders(randomUUID()),
        body: '{}',
        signal: AbortSignal.timeout(5_000),
      });
      // 401/404-style responses still prove the endpoint is live; only
      // transport errors below mean unreachable.
      return res.status !== 0 && res.status < 500;
    } catch {
      // Fallback: GET auf die Basis-URL
      try {
        const res = await fetch(`${this.providerUrl}`, {
          method: 'GET',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(5_000),
        });
        return true;
      } catch {
        return false;
      }
    }
  }

  /**
   * Reads the response body as text, with a fallback to json() when the
   * runtime stub only implements that (jest mocks). Full-text reading is
   * required for precision-safe uint64 handling.
   */
  private async readRawBody(res: Response): Promise<string> {
    if (typeof res.text === 'function') return res.text();
    return JSON.stringify(await res.json());
  }

  private authHeaders(operationId: string): Record<string, string> {
    // PosSystem API v2 authentication (docs.fiskaltrust.cloud → POS System API
    // → Authentication): every request carries cashbox id + access token plus
    // a per-operation idempotency key. No Bearer Authorization header.
    return {
      'x-cashbox-id': this.cashboxId,
      'x-cashbox-accesstoken': this.apiKey,
      'x-operation-id': operationId,
      'Content-Type': 'application/json',
    };
  }

  // ─── Checkout Integration ───────────────────────────────────────────────────

  /**
   * Wird in derselben Prisma-Transaktion wie der Checkout aufgerufen
   * (orders.service.ts, parallel zu verifactu.recordPaidOrder).
   *
   * Atomic guarantee: eine bezahlte Bestellung ohne fiskalen Record darf es nicht geben.
   */
  async recordPaidOrder(tx: Tx, orderId: string): Promise<void> {
    if (!this.isEnabled) return;

    // Idempotent: the same order must not get a second fiscal record. A retried
    // checkout or a replayed request can reach here again; a cancel is the only
    // thing that legitimately adds a second row (status CANCELLED), so those are
    // excluded from the duplicate check rather than skipping the whole order.
    const existing = await tx.myDataReceipt.findFirst({
      where: { orderId, status: { not: 'CANCELLED' } },
      select: { id: true },
    });
    if (existing) return;

    const order = await tx.order.findUniqueOrThrow({
      where: { id: orderId },
      include: {
        items: { include: { menuItem: true } },
        payments: true,
        table: true,
      },
    });

    // Charge Items aus Bestellpositionen — each item carries its own
    // taxRateSnapshot (Decimal), so VAT is derived per-line, not per-order.
    // This matches how verifactu.service.ts handles it (Number(i.taxRateSnapshot)).
    const chargeItems: FtChargeItem[] = order.items.map((item, idx) => {
      const vatRate = Number(item.taxRateSnapshot);
      const desc = (item.nameSnapshot ?? `Item ${idx + 1}`).slice(0, 200);
      if (!GREEK_VAT_RATES.has(vatRate)) {
        // Wrong article master data cannot be fiscalised: fiskaltrust rejects
        // the receipt with "VATRate ... is invalid for the given Type of VAT"
        // only after a full round-trip, which hides the real cause behind
        // retries. Name the article and the valid rates right here.
        this.logger.error(
          `Order ${order.orderNumber}: article "${desc}" carries VAT rate ${vatRate}%, ` +
            `which does not exist in Greece (valid: ${[...GREEK_VAT_RATES].sort((a, b) => a - b).join(', ')}%). ` +
            'Fix the article master data — myDATA will reject this receipt.',
        );
      }
      return {
        Quantity: Number(item.quantity ?? 1),
        Description: desc,
        Amount: Number(item.lineTotal),
        VATRate: vatRate,
        Position: idx + 1,
        // V stays 0 (unknown) so the middleware resolves the rate code from its
        // own VAT-rates table using VATRate. Encoding the code ourselves put a
        // 7% line on V=4 and the middleware rejected it as an invalid rate.
        ftChargeItemCase: CHARGE_ITEM_BASE,
      };
    });

    // Pay Items aus Zahlungen — PaymentMethod is an uppercase enum (CASH, CARD, ...)
    const payItems: FtPayItem[] = order.payments.map((pay, idx) => ({
      Description: String(pay.method),
      Amount: Number(pay.amount),
      Position: idx + 1,
      ftPayItemCase: pay.method === 'CASH' ? PAY_CASH : PAY_CARD,
    }));

    // Per-VAT-rate totals, kept for local reporting. v2 requests carry a single
    // gross cbReceiptAmount instead of this v0-style array.
    const vatBuckets = new Map<number, number>();
    for (const ci of chargeItems) {
      vatBuckets.set(ci.VATRate, (vatBuckets.get(ci.VATRate) ?? 0) + ci.Amount);
    }

    // Discounts. The order total is already net of discountAmount and
    // loyaltyDiscountAmount, so without an explicit discount line the charge
    // items would sum to more than the payment (20.00 goods vs 18.00 paid) and
    // fiskaltrust's "sum of charge items == sum of pay items" check fails.
    // A discount is a negative charge item on the same VAT rate.
    // Source: docs.fiskaltrust.cloud/.../greece/reference-tables/ftchargeitemcase Table 4
    const discountTotal =
      Number(order.discountAmount ?? 0) + Number(order.loyaltyDiscountAmount ?? 0);
    const chargeSum = chargeItems.reduce((sum, ci) => sum + ci.Amount, 0);
    if (discountTotal > 0 && chargeSum > 0) {
      let position = chargeItems.length;
      for (const [vatRate, bucketAmount] of vatBuckets.entries()) {
        // Split the discount across VAT rates in proportion to each bucket, so
        // every bucket keeps the tax it actually carries.
        const share = Math.round((discountTotal * bucketAmount / chargeSum) * 100) / 100;
        if (share <= 0) continue;
        position += 1;
        chargeItems.push({
          Quantity: 1,
          Description: 'Discount',
          Amount: -share,
          VATRate: vatRate,
          Position: position,
          ftChargeItemCase: CHARGE_ITEM_BASE | DISCOUNT_FLAG,
        });
      }
    }
    const amounts: FtAmount[] = [...vatBuckets.entries()].map(([rate, amt]) => ({
      ftAmount: amt,
      ftTaxCR: rate,
    }));

    await tx.myDataReceipt.create({
      data: {
        orderId,
        orderNumber: order.orderNumber,
        branchId: order.branchId,
        receiptCase: RECEIPT_CASE_POS_RECEIPT,
        amounts: JSON.stringify(amounts),
        chargeItems: JSON.stringify(chargeItems.map(ci => ({
          ...ci,
          ftChargeItemCase: ci.ftChargeItemCase?.toString(),
        }))),
        payItems: JSON.stringify(payItems.map(pi => ({
          ...pi,
          ftPayItemCase: pi.ftPayItemCase?.toString(),
        }))),
        tableArea: order.table?.number ?? null,
        totalAmount: Number(order.totalAmount),
        cbReceiptMoment: order.updatedAt ?? new Date(),
        status: 'PENDING',
        sandbox: this.isSandbox,
      },
    });

    this.logger.debug(
      `MyDataReceipt created for order ${order.orderNumber} (pending submission)`,
    );
  }

  // ─── Asynchrone Übermittlung (nach Transaction-Commit) ─────────────────────

  /**
   * Cron-Job: alle 5 Minuten werden pending MyDataReceipts an die
   * CloudCashbox SaaS geschickt.
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async sendPending(): Promise<void> {
    if (!this.isEnabled || this.sending) return;
    this.sending = true;
    try {
      const pending = await this.prisma.myDataReceipt.findMany({
        // CRITICAL: filter by sandbox flag. If the provider URL is switched
        // from sandbox to production, old sandbox PENDING receipts must NOT
        // be submitted to the live myDATA system (real AADE, irrevocable).
        where: { status: 'PENDING', sandbox: this.isSandbox },
        take: BATCH,
        orderBy: { createdAt: 'asc' },
      });

      if (pending.length === 0) return;
      this.logger.log(`Sending ${pending.length} pending receipts to CloudCashbox/myDATA...`);

      for (const receipt of pending) {
        try {
          const result = await this.submitReceipt(receipt);
          await this.prisma.myDataReceipt.update({
            where: { id: receipt.id },
            data: {
              status: 'SUBMITTED',
              mark: result.mark,
              uid: result.uid,
              authenticationCode: result.authenticationCode,
              uniqueDocumentIdentifier: result.uniqueDocumentIdentifier,
              qrCodeUrl: result.qrCodeUrl,
              ftReceiptNumber: result.receiptNumber,
              ftTimestamp: new Date(result.timestamp),
              ftHash: result.hash,
              transmissionFailure: result.transmissionFailure,
              providerFooter: result.providerFooter,
              submittedAt: new Date(),
              lastError: null,
            },
          });
          this.logger.debug(
            `Receipt ${receipt.orderNumber} submitted: MARK=${result.mark}`,
          );
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          const newRetryCount = (receipt.retryCount ?? 0) + 1;

          if (newRetryCount >= MAX_RETRIES) {
            await this.prisma.myDataReceipt.update({
              where: { id: receipt.id },
              data: {
                status: 'FAILED',
                retryCount: newRetryCount,
                lastError: errMsg.slice(0, 1000),
              },
            });
            this.logger.error(
              `Receipt ${receipt.orderNumber} permanently FAILED after ${newRetryCount} retries: ${errMsg}`,
            );
          } else {
            await this.prisma.myDataReceipt.update({
              where: { id: receipt.id },
              data: {
                retryCount: newRetryCount,
                lastError: errMsg.slice(0, 1000),
              },
            });
            this.logger.warn(
              `Failed to submit receipt ${receipt.orderNumber} (retry ${newRetryCount}/${MAX_RETRIES}): ${errMsg}`,
            );
          }
        }
      }
    } finally {
      this.sending = false;
    }
  }

  // ─── Core: REST-Aufruf an die CloudCashbox SaaS ─────────────────────────────

  /**
   * Übermittelt einen Beleg über die fiskaltrust PosSystem API v2.
   * POST /v2/sign → gibt MARK, UID, QR-Code etc. zurück.
   * Idempotency: x-operation-id per attempt; body is deterministic per receipt
   * (cbReceiptMoment pinned), so retrying with the same operation id is safe
   * when needed.
   */
  private async submitReceipt(receipt: {
    id: string;
    orderId: string;
    orderNumber: string;
    receiptCase: bigint;
    amounts: string;
    chargeItems: string;
    payItems: string;
    tableArea: string | null;
    totalAmount: Prisma.Decimal;
    cbReceiptMoment: Date;
  }): Promise<ReceiptMyData> {
    const amounts: FtAmount[] = JSON.parse(receipt.amounts);

    // Stored line items may be in either shape: rows written before the v2
    // field fix carry ftChargeLine/ftChargeText/ftChargeAmount, newer rows
    // carry Quantity/Amount/VATRate. Normalize to the v2 model here so
    // already-queued receipts submit with real amounts instead of Amount=0.
    //
    // Rows queued before VATRate was transmitted carry no rate at all. The rate
    // codes in ftChargeItemCase are not percentages, so deriving the percentage
    // from them is guesswork — instead read the real rates from the order.
    const storedItems: any[] = JSON.parse(receipt.chargeItems);
    const missingRate = storedItems.some(ci => ci.VATRate == null);
    const orderRates: number[] = missingRate
      ? (
          await this.prisma.orderItem.findMany({
            where: { orderId: receipt.orderId },
            orderBy: { id: 'asc' },
            select: { taxRateSnapshot: true },
          })
        ).map(i => Number(i.taxRateSnapshot))
      : [];

    const chargeItems: FtChargeItem[] = storedItems.map(
      (ci: any, idx: number) => {
        const itemCase = this.repairItemCase(
          ci.ftChargeItemCase ? BigInt(ci.ftChargeItemCase) : undefined,
          'charge',
        );
        return {
          Quantity: Number(ci.Quantity ?? 1),
          Description: String(ci.Description ?? ci.ftChargeText ?? ''),
          Amount: Number(ci.Amount ?? ci.ftChargeAmount ?? 0),
          VATRate: Number(ci.VATRate ?? orderRates[idx] ?? 0),
          Position: Number(ci.Position ?? ci.ftChargeLine ?? idx + 1),
          ftChargeItemCase: itemCase,
        };
      },
    );
    const payItems: FtPayItem[] = JSON.parse(receipt.payItems).map(
      (pi: any, idx: number) => ({
        Description: String(pi.Description ?? pi.ftPayText ?? ''),
        Amount: Number(pi.Amount ?? pi.ftPayAmount ?? 0),
        Position: Number(pi.Position ?? pi.ftPayLine ?? idx + 1),
        ftPayItemCase: this.repairItemCase(
          pi.ftPayItemCase ? BigInt(pi.ftPayItemCase) : undefined,
          'pay',
        ),
      }),
    );

    // v2 requires sum(chargeItems) == sum(payItems); fiskaltrust's basic
    // receipt check reports a mismatch on the receipt. Receipts queued before
    // discounts were transmitted carry the gross item sum but the discounted
    // payment, so reconcile with an explicit negative discount line instead of
    // shipping a receipt that fails validation.
    const chargeSum = chargeItems.reduce((sum, ci) => sum + ci.Amount, 0);
    const paySum = payItems.reduce((sum, pi) => sum + pi.Amount, 0);
    const reconciliation = Math.round((paySum - chargeSum) * 100) / 100;
    if (reconciliation < 0) {
      const largest = chargeItems.reduce(
        (max, ci) => (ci.Amount > max.Amount ? ci : max),
        chargeItems[0],
      );
      chargeItems.push({
        Quantity: 1,
        Description: 'Discount',
        Amount: reconciliation,
        VATRate: largest.VATRate,
        Position: chargeItems.length + 1,
        ftChargeItemCase: CHARGE_ITEM_BASE | DISCOUNT_FLAG,
      });
    }

    const body: FtPosRequest = {
      // PosSystem API v2 validates ftCashBoxID/ftQueueID as GUIDs — header
      // auth already scopes the request, body must carry the cashbox GUID.
      ftCashBoxID: this.cashboxId,
      ftQueueID: this.queueId,
      // Stable software identity for the Portal's basic receipt validation
      // ("receipts should include the PosSystemId"). Overridable via env.
      ftPosSystemId:
        this.config.get<string>('MYDATA_POS_SYSTEM_ID') ??
        'df9dc44c-18ef-41c6-bf7e-c84ca65d0190',
      cbTerminalID: 'orderrestro-backend',
      cbReceiptReference: receipt.orderNumber,
      // Reuse the original checkout moment so the Belegzeitstempel doesn't drift on retry.
      cbReceiptMoment: receipt.cbReceiptMoment.toISOString(),
      ftReceiptCase: receipt.receiptCase,
      // v2 takes one gross total; the sum of the charge items is the fallback
      // when no explicit amount is available.
      cbReceiptAmount:
        Number(receipt.totalAmount) ||
        chargeItems.reduce((sum, ci) => sum + ci.Amount, 0),
      cbChargeItems: chargeItems,
      cbPayItems: payItems,
    };

    if (receipt.tableArea) {
      body.cbArea = receipt.tableArea.slice(0, 50);
    }

    // Serialize BigInt Int64 cases as raw JSON numbers.
    // fiskaltrust v2 deserializes ftChargeItemCase etc. as System.Int64 and
    // rejects quoted strings. A replacer returning a string would emit quotes,
    // so bigints are encoded as @n:<digits> placeholders and unquoted below.
    const jsonBody = JSON.stringify(body, (_k, v) =>
      typeof v === 'bigint' ? `@n:${v.toString()}` : v,
    ).replace(/"@n:(\d+)"/g, '$1');

    const res = await fetch(`${this.providerUrl}/v2/sign`, {
      method: 'POST',
      headers: this.authHeaders(randomUUID()),
      body: jsonBody,
      signal: AbortSignal.timeout(API_TIMEOUT),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`CloudCashbox POST /v2/sign failed: ${res.status} ${res.statusText} — ${text.slice(0, 500)}`);
    }

    // Read the body as text so uint64 fields can be read at full precision.
    // JSON.parse turns 0x4752200000000000 into a double and loses the last
    // digits, which is how a READY queue ends up looking like it has an error
    // flag set.
    const rawResponse = await this.readRawBody(res);
    const data: FtPosResponse = JSON.parse(rawResponse);
    const exactState = rawResponse.match(/"ftState"\s*:\s*"?(\d+)"?/)?.[1];

    // The payloads in the wild use three different spellings for the same two
    // fields: the v2 spec says data/caption, the C# model says
    // ftSignature/ftSignatureCaption, and the sandbox actually returns
    // Data/Caption. Accept all of them, otherwise a real MARK would be read as
    // an empty string and the receipt would look unsigned.
    const sigs: FtSignature[] = (data.ftSignatures ?? []).map((s: any) => ({
      ...s,
      ftSignature: s.ftSignature ?? s.data ?? s.Data ?? '',
      ftSignatureCaption: s.ftSignatureCaption ?? s.caption ?? s.Caption ?? '',
    }));

    // Parse signature items.
    // ftSignatureType is Int64 (country-coded). JSON.parse may lose precision.
    // We match by SignatureCase (low 12 bits) first, then by caption as fallback.

    const findSig = (sss: number, captionFallback: string): FtSignature | undefined =>
      matchSigByCase(sigs, sss) ?? matchSigByCaption(sigs, captionFallback);

    const qrSig = findSig(0x001, 'fiskaltrust.gr');
    const markSig = findSig(0x014, 'invoiceMark');
    const uidSig = findSig(0x013, 'invoiceUid');
    const authSig = findSig(0x015, 'authenticationCode');
    const udiSig = findSig(0x012, 'μοναδικός');
    const failureSig = findSig(0x016, 'Transmission Failure');
    const providerSig = findSig(0x011, 'ProviderSignature');

    const mark = markSig?.ftSignature ?? '';

    if (!mark) {
      // Dump what the middleware actually booked. The echo carries the amounts,
      // which is the only server-side proof of what the ReceiptJournal shows.
      throw new Error(
        'CloudCashbox returned no MARK — myDATA submission may have failed. ' +
        `Raw ftSignatures: ${sigs.map(s => JSON.stringify(s)).join(' | ') || '<none>'}. ` +
        `ftState: ${exactState ?? data.ftState ?? '<none>'}. ` +
        `Booked charge items: ${JSON.stringify(data.ftChargeItems ?? [])}. ` +
        `Booked pay items: ${JSON.stringify(data.ftPayItems ?? [])}.`,
      );
    }

    return {
      qrCodeUrl: qrSig?.ftSignature ?? '',
      mark,
      uid: uidSig?.ftSignature ?? '',
      authenticationCode: authSig?.ftSignature ?? '',
      uniqueDocumentIdentifier: udiSig?.ftSignature ?? '',
      receiptNumber: data.ftReceiptJournal?.ftReceiptNumber ?? 0,
      timestamp: data.ftReceiptJournal?.ftReceiptMoment ?? new Date().toISOString(),
      hash: data.ftReceiptJournal?.ftReceiptHash ?? '',
      transmissionFailure: !!failureSig,
      providerFooter: providerSig?.ftSignatureCaption ?? null,
      sandbox: this.isSandbox,
    };
  }

  // ─── Bon-Druck: QR-Code-Daten abrufen ──────────────────────────────────────

  /**
   * Wird von escpos-receipt.ts aufgerufen, um die myDATA-Daten
   * für den Bon zu holen.
   */
  async getReceiptData(orderId: string): Promise<ReceiptMyData | null> {
    if (!this.isEnabled) return null;

    const receipt = await this.prisma.myDataReceipt.findFirst({
      where: { orderId, status: 'SUBMITTED' },
      orderBy: { createdAt: 'desc' },
    });

    if (!receipt) return null;

    return {
      qrCodeUrl: receipt.qrCodeUrl ?? '',
      mark: receipt.mark ?? '',
      uid: receipt.uid ?? '',
      authenticationCode: receipt.authenticationCode ?? '',
      uniqueDocumentIdentifier: receipt.uniqueDocumentIdentifier ?? '',
      receiptNumber: receipt.ftReceiptNumber ?? 0,
      timestamp: receipt.ftTimestamp?.toISOString() ?? '',
      hash: receipt.ftHash ?? '',
      transmissionFailure: receipt.transmissionFailure,
      providerFooter: receipt.providerFooter,
      sandbox: receipt.sandbox,
    };
  }

  // ─── Stornierung (CancelInvoice) ───────────────────────────────────────────

  /**
   * Storniert einen bereits übermittelten Beleg bei myDATA.
   * PosSystem API v2 hat keinen separaten Cancel-Endpunkt — Storno ist ein
   * Beleg mit Void-Receipt-Case via POST /v2/sign.
   */
  async cancelReceipt(orderId: string, reason?: string): Promise<void> {
    if (!this.isEnabled) return;

    const original = await this.prisma.myDataReceipt.findFirst({
      where: { orderId, status: 'SUBMITTED' },
      orderBy: { createdAt: 'desc' },
    });

    if (!original || !original.mark) {
      throw new BadRequestException(
        `No submitted receipt found for order ${orderId} to cancel`,
      );
    }

    this.logger.log(`Cancelling receipt ${original.orderNumber} (MARK=${original.mark})...`);

    const cancelBody = {
      ftCashBoxID: this.cashboxId,
      ...(this.queueId ? { ftQueueID: this.queueId } : {}),
      cbReceiptReference: `CANCEL-${original.orderNumber}`,
      cbReceiptMoment: new Date().toISOString(),
      // v2 field name, and Int64 must travel unquoted (see submitReceipt).
      ftReceiptCase: `@n:${RECEIPT_CASE_VOID.toString()}`,
      ftReceiptCaseData: {
        GR: {
          PreviousReceiptReference: {
            // MARK stays a string — it is a 15-digit AADE number and converting
            // to Number risks precision loss (wrong receipt cancelled).
            invoiceMark: original.mark,
          },
        },
      },
      cbNote: reason ?? 'Storno',
    };

    const cancelRes = await fetch(`${this.providerUrl}/v2/sign`, {
      method: 'POST',
      headers: this.authHeaders(randomUUID()),
      // Same Int64 unquoting as submitReceipt: ftReceiptCase must arrive as a
      // raw JSON number, so the @n: placeholder is stripped of its quotes.
      body: JSON.stringify(cancelBody).replace(/"@n:(\d+)"/g, '$1'),
      signal: AbortSignal.timeout(API_TIMEOUT),
    });
    const res = cancelRes;

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`CloudCashbox POST /v2/sign (cancel) failed: ${res.status} ${res.statusText} — ${text.slice(0, 500)}`);
    }

    const data: FtPosResponse = await res.json();
    // Same field-name normalization as submitReceipt — the sandbox returns
    // Data/Caption, the v2 spec data/caption, the C# model ftSignature*.
    const sigs: FtSignature[] = (data.ftSignatures ?? []).map((s: any) => ({
      ...s,
      ftSignature: s.ftSignature ?? s.data ?? s.Data ?? '',
      ftSignatureCaption: s.ftSignatureCaption ?? s.caption ?? s.Caption ?? '',
    }));

    const cancelMarkSig = matchSigByCase(sigs, 0x014) ?? matchSigByCaption(sigs, 'invoiceMark');
    const cancelMark = cancelMarkSig?.ftSignature ?? null;

    await this.prisma.myDataReceipt.update({
      where: { id: original.id },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        cancelMark,
      },
    });

    await this.audit.record({
      userId: 'system',
      action: 'mydata.cancel_receipt',
      entity: 'MyDataReceipt',
      entityId: original.id,
      metadata: {
        orderNumber: original.orderNumber,
        originalMark: original.mark,
        cancelMark,
      },
    });

    this.logger.log(`Receipt ${original.orderNumber} cancelled (cancel MARK=${cancelMark})`);
  }

  // ─── Hilfsfunktionen ────────────────────────────────────────────────────────

  /**
   * Rebuilds a stored case value with the country code and version nibble
   * forced to their correct positions.
   *
   * Receipts queued before the constant fix carry 0x6752… instead of 0x4752…:
   * the old mask set bit 61 and ORed it into the country code, so fiskaltrust
   * rejects the value as an invalid case. Keep the semantic low bits (nature of
   * VAT, type of service, discount flags, payment type) and re-anchor them on
   * 0x4752 + version 2.
   *
   * The V nibble is dropped on purpose: older rows carry a code derived from a
   * wrong percentage mapping, and fiskaltrust resolves the rate from VATRate
   * when V is 0 ("unknown").
   */
  private repairItemCase(
    itemCase: bigint | undefined,
    kind: 'charge' | 'pay',
  ): bigint | undefined {
    if (!itemCase) return undefined;

    const version = COUNTRY_GR | 0x0000200000000000n;
    const flags = itemCase & 0xffff0000n; // gggg (discount, void, …)

    if (kind === 'charge') {
      // NNSV: keep nature-of-VAT (NN, bits 8-15), force S=1 (supply of goods)
      // like every newly written line, and drop V (bits 0-3).
      //
      // Old rows carry a V code produced by a wrong percentage mapping (a 7%
      // line was stored as V=4). Passing it on made fiskaltrust reject the
      // receipt with "VATRate ... is invalid for the given Type of VAT". With
      // V=0 (unknown) the middleware resolves the rate from VATRate instead.
      const nn = itemCase & 0x0000ff00n;
      return version | flags | nn | 0x10n;
    }

    // xxPP: the payment type byte. The pre-fix code encoded card as 0x10, which
    // is not a defined GR payment type — POS/e-POS is 04.
    let pp = Number(itemCase & 0xffn);
    if (pp === 0x10) pp = 0x04;
    return version | flags | BigInt(pp);
  }

  /**
   * Statistik für das Admin-Dashboard.
   */
  async stats(branchId?: string) {
    const where = branchId ? { branchId } : {};
    const [total, submitted, pending, failed, cancelled] = await Promise.all([
      this.prisma.myDataReceipt.count({ where }),
      this.prisma.myDataReceipt.count({ where: { ...where, status: 'SUBMITTED' } }),
      this.prisma.myDataReceipt.count({ where: { ...where, status: 'PENDING' } }),
      this.prisma.myDataReceipt.count({ where: { ...where, status: 'FAILED' } }),
      this.prisma.myDataReceipt.count({ where: { ...where, status: 'CANCELLED' } }),
    ]);

    return { total, submitted, pending, failed, cancelled };
  }
}
