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
 * fiskaltrust PosSystem API (v2) für Griechenland:
 *   POST /v2/pos        — Beleg signieren + an myDATA übermitteln
 *   GET  /v2/pos/{id}   — Status abfragen (async processing)
 *   POST /v2/pos/cancel — Beleg stornieren (CancelInvoice)
 *
 * CloudCashbox URL:
 *   Sandbox:     https://pos-api-sandbox.fiskaltrust.cloud
 *   Produktion:  https://pos-api.fiskaltrust.cloud
 *
 * Env-Konfiguration:
 *   MYDATA_ENABLED       — "true" aktiviert das Modul
 *   MYDATA_PROVIDER_URL  — CloudCashbox URL (sandbox oder produktion)
 *   MYDATA_API_KEY       — Provider API Key (aus kds-app-secret)
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
  ftQueueID: string;
  cbTerminalID: string;
  cbReceiptReference: string;
  cbReceiptMoment: string; // ISO 8601
  cbReceiptCase: bigint;
  cbReceiptAmounts?: FtAmount[];
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
  ftChargeLine: number;
  ftChargeText?: string;
  ftChargeAmount: number;
  ftChargeItemCase?: bigint; // carries VAT rate + service type
  ftChargeItemCaseData?: unknown;
}

interface FtPayItem {
  ftPayLine: number;
  ftPayText?: string;
  ftPayAmount: number;
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
  ftState: {
    ftState: string;
    ftStateTimestamp: string;
  };
}

interface FtSignature {
  ftSignatureType: number;
  ftSignature: string;      // Data — Base64, URL, or text depending on format
  ftSignatureCaption: string; // Human-readable caption
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
//   v=2 (version 2), t=0 (receipt), xcc=0001 (POS receipt)
const RECEIPT_CASE_POS_RECEIPT = COUNTRY_GR | 0x2000000000000001n;

// Payment transfer receipt (myDATA 8.4) — used for void/cancel referencing
const RECEIPT_CASE_VOID = COUNTRY_GR | 0x2000000000000002n;

// ftChargeItemCase: CCCC_vlll_gggg_NNSV
//   V (low nibble) = VAT rate, S = Service type
//   S=1 (delivery/goods), V=0
// Source: docs.fiskaltrust.cloud/.../ftchargeitemcase Table 1 (V) and Table 2 (S)
const CHARGE_ITEM_BASE = COUNTRY_GR | 0x2000000000000000n; // v=2, NN=00, S=1, V=0
const VAT_NORMAL        = 3n; // Normal VAT rate (24%)
const VAT_DISCOUNTED_1  = 1n; // Discounted-1 VAT rate (13%)
const VAT_DISCOUNTED_2  = 2n; // Discounted-2 VAT rate
const VAT_SUPER_REDUCED = 4n; // Super-reduced-1 VAT rate (6%)
const VAT_ZERO          = 7n; // Zero VAT rate (0%)
const VAT_NOT_TAXABLE   = 8n; // Not Taxable

// ftPayItemCase: CCCC_vlll_gggg_xxcc (same structure as receipt case)
const PAY_CASH = COUNTRY_GR | 0x2000000000000001n; // cash
const PAY_CARD = COUNTRY_GR | 0x2000000000000010n; // card / EFTPOS

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
    return url.replace(/\/$/, '');
  }

  private get apiKey(): string {
    return this.config.getOrThrow<string>('MYDATA_API_KEY');
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
      const res = await fetch(`${this.providerUrl}/health`, {
        method: 'GET',
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(5_000),
      });
      return res.status >= 200 && res.status < 300;
    } catch {
      // Fallback: GET auf die Basis-URL
      try {
        const res = await fetch(`${this.providerUrl}`, {
          method: 'GET',
          headers: this.authHeaders(),
          signal: AbortSignal.timeout(5_000),
        });
        return true;
      } catch {
        return false;
      }
    }
  }

  private authHeaders(): Record<string, string> {
    return {
      'Authorization': `Bearer ${this.apiKey}`,
      'X-FT-API-KEY': this.apiKey,
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
      const itemVatV = this.deriveVatV(Number(item.taxRateSnapshot));
      return {
        ftChargeLine: idx + 1,
        ftChargeText: item.nameSnapshot ?? `Item ${idx + 1}`,
        ftChargeAmount: Number(item.lineTotal),
        ftChargeItemCase: CHARGE_ITEM_BASE | itemVatV,
      };
    });

    // Pay Items aus Zahlungen — PaymentMethod is an uppercase enum (CASH, CARD, ...)
    const payItems: FtPayItem[] = order.payments.map((pay, idx) => ({
      ftPayLine: idx + 1,
      ftPayText: String(pay.method),
      ftPayAmount: Number(pay.amount),
      ftPayItemCase: pay.method === 'CASH' ? PAY_CASH : PAY_CARD,
    }));

    // Aggregate amounts by VAT category for the receipt-level summary
    const vatBuckets = new Map<bigint, number>();
    for (const ci of chargeItems) {
      const v = ci.ftChargeItemCase! & 0xfn;
      vatBuckets.set(v, (vatBuckets.get(v) ?? 0) + ci.ftChargeAmount);
    }
    const amounts: FtAmount[] = [...vatBuckets.entries()].map(([v, amt]) => ({
      ftAmount: amt,
      ftTaxCR: Number(v),
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
   * POST /v2/pos → gibt MARK, UID, QR-Code etc. zurück.
   */
  private async submitReceipt(receipt: {
    id: string;
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

    // Charge/pay items were stored with BigInt case values as strings.
    const chargeItems = JSON.parse(receipt.chargeItems).map((ci: any) => ({
      ...ci,
      ftChargeItemCase: ci.ftChargeItemCase ? BigInt(ci.ftChargeItemCase) : undefined,
    }));
    const payItems = JSON.parse(receipt.payItems).map((pi: any) => ({
      ...pi,
      ftPayItemCase: pi.ftPayItemCase ? BigInt(pi.ftPayItemCase) : undefined,
    }));

    const body: FtPosRequest = {
      ftCashBoxID: this.vatNumber,
      ftQueueID: this.vatNumber,
      cbTerminalID: 'orderrestro-backend',
      cbReceiptReference: receipt.orderNumber,
      // Reuse the original checkout moment so the Belegzeitstempel doesn't drift on retry.
      cbReceiptMoment: receipt.cbReceiptMoment.toISOString(),
      cbReceiptCase: receipt.receiptCase,
      cbReceiptAmounts: amounts,
      cbChargeItems: chargeItems,
      cbPayItems: payItems,
    };

    if (receipt.tableArea) {
      body.cbArea = receipt.tableArea.slice(0, 50);
    }

    // Serialize BigInt fields as strings for JSON transport.
    // The fiskaltrust API accepts numeric strings for Int64 fields.
    const jsonBody = JSON.stringify(body, (_k, v) =>
      typeof v === 'bigint' ? v.toString() : v,
    );

    const res = await fetch(`${this.providerUrl}/v2/pos`, {
      method: 'POST',
      headers: this.authHeaders(),
      body: jsonBody,
      signal: AbortSignal.timeout(API_TIMEOUT),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`CloudCashbox POST /v2/pos failed: ${res.status} ${res.statusText} — ${text.slice(0, 500)}`);
    }

    const data: FtPosResponse = await res.json();

    // Parse signature items.
    // ftSignatureType is Int64 (country-coded). JSON.parse may lose precision.
    // We match by SignatureCase (low 12 bits) first, then by caption as fallback.
    const sigs: FtSignature[] = data.ftSignatures ?? [];

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
      throw new Error(
        'CloudCashbox returned no MARK — myDATA submission may have failed. ' +
        `Signatures received: ${sigs.map(s => `${s.ftSignatureCaption}=${s.ftSignature.slice(0, 40)}`).join(', ')}`,
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
   * Verwendet POST /v2/pos/cancel mit der MARK des Originalbelegs.
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
      ftCashBoxID: this.vatNumber,
      ftQueueID: this.vatNumber,
      cbReceiptReference: `CANCEL-${original.orderNumber}`,
      cbReceiptMoment: new Date().toISOString(),
      cbReceiptCase: RECEIPT_CASE_VOID.toString(),
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

    const res = await fetch(`${this.providerUrl}/v2/pos/cancel`, {
      method: 'POST',
      headers: this.authHeaders(),
      body: JSON.stringify(cancelBody),
      signal: AbortSignal.timeout(API_TIMEOUT),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`CloudCashbox POST /v2/pos/cancel failed: ${res.status} ${res.statusText} — ${text.slice(0, 500)}`);
    }

    const data: FtPosResponse = await res.json();
    const sigs: FtSignature[] = data.ftSignatures ?? [];

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
   * Leitet den ftChargeItemCase-VAT-Nibble (V) aus dem Steuersatz ab.
   *
   * Griechische Mehrwertsteuersätze und ihre ftChargeItemCase V-Werte:
   *   24% → V=3 (Normal VAT rate)
   *   13% → V=1 (Discounted-1 VAT rate)
   *    6% → V=4 (Super-reduced-1 VAT rate)
   *    0% → V=7 (Zero VAT rate)
   *
   * Source: docs.fiskaltrust.cloud/.../ftchargeitemcase Table 1 (V - VAT)
   */
  private deriveVatV(taxRate: number | string | null): bigint {
    const rate = Number(taxRate ?? 0);
    if (rate >= 20) return VAT_NORMAL;        // 24%
    if (rate >= 10) return VAT_DISCOUNTED_1;  // 13%
    if (rate > 0) return VAT_SUPER_REDUCED;   // 6%
    return VAT_ZERO;                           // 0%
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
