// myDATA (AADE, Greece) — fiscal record creation and submission.
//
// These tests cover the parts that must never regress, because a mistake here
// is a tax-compliance defect, not a UI bug:
//   - the fiscal record is written as PENDING inside the checkout transaction,
//     with per-line VAT derived from each item's tax snapshot;
//   - sandbox receipts are never mixed into a production submission run;
//   - a failing submission increments retryCount and only moves to FAILED at
//     MAX_RETRIES, so a provider outage does not silently drop a receipt;
//   - nothing is submitted at all while the integration is disabled.
//
// Network is stubbed via global.fetch. No real CloudCashbox call is made.

import { BadRequestException } from '@nestjs/common';
import { MyDataService } from './mydata.service';

const SANDBOX_URL = 'https://pos-api-sandbox.fiskaltrust.cloud';
const PROD_URL = 'https://pos-api.fiskaltrust.cloud';

const COUNTRY_GR = 0x4752000000000000n;
// Version nibble sits in bits 61-64 (0x0000_2000_0000_0000). The older
// 0x2000_0000_0000_0000 mask set bit 62 and corrupted the country code to
// 0x6752, which fiskaltrust rejects as an invalid case value.
const CHARGE_ITEM_BASE = COUNTRY_GR | 0x0000200000000010n;
const RECEIPT_CASE_POS_RECEIPT = COUNTRY_GR | 0x0000200000000001n;
const PAY_CASH = COUNTRY_GR | 0x0000200000000001n;

/** VAT nibble derived by the service for a Greek tax rate. */
const VAT_NORMAL = 3n; // 24%
const VAT_DISCOUNTED_1 = 1n; // 13%
const VAT_SUPER_REDUCED = 4n; // 6%
const VAT_ZERO = 7n; // 0%

function config(over: Record<string, string | undefined> = {}) {
  const values: Record<string, string | undefined> = {
    MYDATA_ENABLED: 'true',
    MYDATA_PROVIDER_URL: SANDBOX_URL,
    MYDATA_API_KEY: 'test-api-key',
    MYDATA_VAT_NUMBER: 'EL123456789',
    ...over,
  };
  return {
    get: (k: string) => values[k],
    getOrThrow: (k: string) => {
      const v = values[k];
      if (v === undefined) throw new Error(`missing ${k}`);
      return v;
    },
  };
}

function build(over: Record<string, string | undefined> = {}) {
  const prisma = {
    myDataReceipt: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({}),
      count: jest.fn().mockResolvedValue(0),
    },
    // submitReceipt reads the real tax rates from the order when a queued
    // receipt carries no VATRate (see the VATRate resolution comment there).
    orderItem: {
      findMany: jest.fn().mockResolvedValue([]),
    },
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const svc = new MyDataService(
    prisma as never,
    config(over) as never,
    audit as never,
  );
  return { svc, prisma, audit };
}

const order = {
  id: 'o1',
  orderNumber: 'ORD-1001',
  branchId: 'b1',
  totalAmount: 124,
  updatedAt: new Date('2026-11-24T10:00:00Z'),
  table: { number: 'T4' },
  items: [
    { nameSnapshot: 'Souvlaki', lineTotal: 100, taxRateSnapshot: 24 },
    { nameSnapshot: 'Water', lineTotal: 24, taxRateSnapshot: 0 },
  ],
  payments: [{ method: 'CASH', amount: 124 }],
};

function txWith(value: unknown = order) {
  const create = jest.fn().mockResolvedValue({});
  const findFirst = jest.fn().mockResolvedValue(null);
  return {
    tx: {
      order: { findUniqueOrThrow: jest.fn().mockResolvedValue(value) },
      myDataReceipt: { create, findFirst },
    } as never,
    create,
    findFirst,
  };
}

describe('MyDataService — config gates', () => {
  it('is enabled only when the flag is true and a key is present', () => {
    expect(build().svc.isEnabled).toBe(true);
    expect(build({ MYDATA_ENABLED: 'false' }).svc.isEnabled).toBe(false);
    expect(build({ MYDATA_API_KEY: undefined }).svc.isEnabled).toBe(false);
  });

  it('detects sandbox by provider URL', () => {
    expect(build().svc.isSandbox).toBe(true);
    expect(build({ MYDATA_PROVIDER_URL: PROD_URL }).svc.isSandbox).toBe(false);
  });
});

describe('MyDataService.recordPaidOrder', () => {
  it('writes a PENDING fiscal record inside the transaction', async () => {
    const { svc } = build();
    const { tx, create } = txWith();
    await svc.recordPaidOrder(tx, 'o1');

    expect(create).toHaveBeenCalledTimes(1);
    const data = create.mock.calls[0][0].data;
    expect(data.orderId).toBe('o1');
    expect(data.status).toBe('PENDING');
    expect(data.receiptCase).toBe(RECEIPT_CASE_POS_RECEIPT);
    expect(data.totalAmount).toBe(124);
    expect(data.tableArea).toBe('T4');
  });

  it('stamps the sandbox flag from the provider URL, so prod never picks it up', async () => {
    const sandboxCreate = txWith();
    await build().svc.recordPaidOrder(sandboxCreate.tx, 'o1');
    expect(sandboxCreate.create.mock.calls[0][0].data.sandbox).toBe(true);

    const prodCreate = txWith();
    await build({ MYDATA_PROVIDER_URL: PROD_URL }).svc.recordPaidOrder(
      prodCreate.tx,
      'o1',
    );
    expect(prodCreate.create.mock.calls[0][0].data.sandbox).toBe(false);
  });

  it('maps each Greek VAT rate to its rate code and transmits the real rate', async () => {
    const { svc } = build();
    const { tx, create } = txWith({
      ...order,
      items: [
        { nameSnapshot: 'A', lineTotal: 10, taxRateSnapshot: 24 },
        { nameSnapshot: 'B', lineTotal: 10, taxRateSnapshot: 13 },
        { nameSnapshot: 'C', lineTotal: 10, taxRateSnapshot: 6 },
        { nameSnapshot: 'D', lineTotal: 10, taxRateSnapshot: 0 },
      ],
      payments: [{ method: 'CASH', amount: 40 }],
    });
    await svc.recordPaidOrder(tx, 'o1');

    const data = create.mock.calls[0][0].data;
    const chargeItems = JSON.parse(data.chargeItems);

    // The V nibble must carry a real rate code. An explicit 0 ("Unknown") is
    // rejected by the middleware with "The VAT Rate ... with VAT type
    // 0x0000-Unknown ... is not supported", so the code is derived from the
    // percentage: 24 -> Normal(3), 13 -> Discounted-1(1), 6 -> Discounted-2(2),
    // 0 -> Zero(7).
    expect(
      chargeItems.map((ci: { ftChargeItemCase: string }) =>
        (BigInt(ci.ftChargeItemCase) & 0xfn).toString(),
      ),
    ).toEqual(['3', '1', '2', '7']);

    for (const ci of chargeItems) {
      expect(BigInt(ci.ftChargeItemCase) & CHARGE_ITEM_BASE).toBe(
        CHARGE_ITEM_BASE,
      );
    }

    // The percentage itself must survive untouched — the middleware validates
    // it against its own rate table.
    expect(chargeItems.map((ci: { VATRate: number }) => ci.VATRate)).toEqual([
      24, 13, 6, 0,
    ]);
  });

  it('records cash and card payments as distinct pay item cases', async () => {
    const { svc } = build();
    const { tx, create } = txWith({
      ...order,
      payments: [
        { method: 'CASH', amount: 100 },
        { method: 'CARD', amount: 24 },
      ],
    });
    await svc.recordPaidOrder(tx, 'o1');

    const payItems = JSON.parse(create.mock.calls[0][0].data.payItems);
    expect(payItems).toHaveLength(2);
    expect(payItems[0].ftPayItemCase).not.toBe(payItems[1].ftPayItemCase);
  });

  it('does nothing when the integration is disabled', async () => {
    const { svc } = build({ MYDATA_ENABLED: 'false' });
    const { tx, create } = txWith();
    await svc.recordPaidOrder(tx, 'o1');
    expect(create).not.toHaveBeenCalled();
  });

  it('does not write a second record for an order that already has one', async () => {
    const { svc } = build();
    const { tx, create, findFirst } = txWith();
    findFirst.mockResolvedValue({ id: 'existing' });

    await svc.recordPaidOrder(tx, 'o1');

    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { orderId: 'o1', status: { not: 'CANCELLED' } },
      }),
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('excludes cancelled records from the duplicate check', async () => {
    // A cancel legitimately adds a second row, so a CANCELLED original must not
    // block re-recording - but a live PENDING/SUBMITTED one must.
    const { svc } = build();
    const { tx, findFirst } = txWith();
    await svc.recordPaidOrder(tx, 'o1');
    const where = findFirst.mock.calls[0][0].where;
    expect(where.status).toEqual({ not: 'CANCELLED' });
  });
});

describe('MyDataService.sendPending', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('never sends when disabled', async () => {
    const { svc, prisma } = build({ MYDATA_ENABLED: 'false' });
    global.fetch = jest.fn();
    await svc.sendPending();
    expect(prisma.myDataReceipt.findMany).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('filters the batch by the sandbox flag', async () => {
    const { svc, prisma } = build();
    global.fetch = jest.fn();
    await svc.sendPending();
    expect(prisma.myDataReceipt.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: 'PENDING', sandbox: true },
      }),
    );
  });

  it('marks a submitted receipt SUBMITTED and stores MARK', async () => {
    const { svc, prisma } = build();
    prisma.myDataReceipt.findMany.mockResolvedValue([
      {
        id: 'r1',
        orderNumber: 'ORD-1001',
        receiptCase: RECEIPT_CASE_POS_RECEIPT,
        amounts: '[]',
        chargeItems: '[]',
        payItems: '[]',
        tableArea: 'T4',
        totalAmount: 124,
        cbReceiptMoment: new Date(),
        retryCount: 0,
      },
    ]);
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ftSignatures: [
          { ftSignatureType: 0x14, ftSignature: 'MARK123', ftSignatureCaption: 'invoiceMark', ftSignatureFormat: 2 },
        ],
        ftReceiptJournal: {
          ftReceiptNumber: 7,
          ftReceiptMoment: '2026-11-24T10:01:00Z',
          ftReceiptHash: 'hash',
        },
      }),
    });

    await svc.sendPending();

    expect(prisma.myDataReceipt.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'r1' },
        data: expect.objectContaining({ status: 'SUBMITTED', mark: 'MARK123' }),
      }),
    );
  });

  it('increments retryCount but keeps PENDING below MAX_RETRIES', async () => {
    const { svc, prisma } = build();
    prisma.myDataReceipt.findMany.mockResolvedValue([
      {
        id: 'r1',
        orderNumber: 'ORD-1',
        receiptCase: RECEIPT_CASE_POS_RECEIPT,
        amounts: '[]',
        chargeItems: '[]',
        payItems: '[]',
        tableArea: null,
        totalAmount: 10,
        cbReceiptMoment: new Date(),
        retryCount: 3,
      },
    ]);
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
      statusText: 'Unavailable',
      text: async () => 'down',
    });

    await svc.sendPending();

    const data = prisma.myDataReceipt.update.mock.calls[0][0].data;
    expect(data.retryCount).toBe(4);
    expect(data.status).toBeUndefined(); // stays PENDING
    expect(data.lastError).toContain('503');
  });

  it('moves the receipt to FAILED at MAX_RETRIES', async () => {
    const { svc, prisma } = build();
    prisma.myDataReceipt.findMany.mockResolvedValue([
      {
        id: 'r1',
        orderNumber: 'ORD-1',
        receiptCase: RECEIPT_CASE_POS_RECEIPT,
        amounts: '[]',
        chargeItems: '[]',
        payItems: '[]',
        tableArea: null,
        totalAmount: 10,
        cbReceiptMoment: new Date(),
        retryCount: 9, // one more failure reaches 10
      },
    ]);
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Server Error',
      text: async () => 'boom',
    });

    await svc.sendPending();

    const data = prisma.myDataReceipt.update.mock.calls[0][0].data;
    expect(data.retryCount).toBe(10);
    expect(data.status).toBe('FAILED');
  });

  it('treats a response without MARK as a failure, not a success', async () => {
    const { svc, prisma } = build();
    prisma.myDataReceipt.findMany.mockResolvedValue([
      {
        id: 'r1',
        orderNumber: 'ORD-1',
        receiptCase: RECEIPT_CASE_POS_RECEIPT,
        amounts: '[]',
        chargeItems: '[]',
        payItems: '[]',
        tableArea: null,
        totalAmount: 10,
        cbReceiptMoment: new Date(),
        retryCount: 0,
      },
    ]);
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ftSignatures: [], ftReceiptJournal: {} }),
    });

    await svc.sendPending();

    const data = prisma.myDataReceipt.update.mock.calls[0][0].data;
    expect(data.status).toBeUndefined();
    expect(data.lastError).toContain('no MARK');
  });

  it('does not start a second run while one is in flight', async () => {
    const { svc, prisma } = build();
    let release!: () => void;
    prisma.myDataReceipt.findMany.mockImplementation(
      () => new Promise((r) => { release = () => r([]); }),
    );
    global.fetch = jest.fn();

    const first = svc.sendPending();
    await svc.sendPending(); // second call returns immediately
    expect(prisma.myDataReceipt.findMany).toHaveBeenCalledTimes(1);

    release();
    await first;
  });
});

describe('MyDataService.getReceiptData', () => {
  it('returns null when the integration is disabled', async () => {
    const { svc, prisma } = build({ MYDATA_ENABLED: 'false' });
    await expect(svc.getReceiptData('o1')).resolves.toBeNull();
    expect(prisma.myDataReceipt.findFirst).not.toHaveBeenCalled();
  });

  it('returns null when no submitted receipt exists', async () => {
    const { svc } = build();
    await expect(svc.getReceiptData('o1')).resolves.toBeNull();
  });

  it('maps a stored submitted receipt to print data', async () => {
    const { svc, prisma } = build();
    prisma.myDataReceipt.findFirst.mockResolvedValue({
      qrCodeUrl: 'https://qr',
      mark: 'MARK123',
      uid: 'UID',
      authenticationCode: 'AUTH',
      uniqueDocumentIdentifier: 'UDI',
      ftReceiptNumber: 7,
      ftTimestamp: new Date('2026-11-24T10:00:00Z'),
      ftHash: 'hash',
      transmissionFailure: false,
      providerFooter: null,
      sandbox: true,
    });
    const data = await svc.getReceiptData('o1');
    expect(data).toMatchObject({
      mark: 'MARK123',
      uid: 'UID',
      receiptNumber: 7,
      sandbox: true,
    });
    // only a SUBMITTED row is printable
    expect(prisma.myDataReceipt.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { orderId: 'o1', status: 'SUBMITTED' } }),
    );
  });
});

describe('MyDataService.cancelReceipt', () => {
  it('refuses to cancel when there is no submitted receipt', async () => {
    const { svc } = build();
    await expect(svc.cancelReceipt('o1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('is a no-op when disabled', async () => {
    const { svc, prisma } = build({ MYDATA_ENABLED: 'false' });
    await expect(svc.cancelReceipt('o1')).resolves.toBeUndefined();
    expect(prisma.myDataReceipt.findFirst).not.toHaveBeenCalled();
  });

  it('sends the original MARK as a string, never as a number', async () => {
    const { svc, prisma } = build();
    prisma.myDataReceipt.findFirst.mockResolvedValue({
      id: 'r1',
      orderNumber: 'ORD-1',
      mark: '400001234567890', // 15-digit AADE number: exceeds Number's safe range
    });
    const originalFetch = global.fetch;
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ftSignatures: [
          { ftSignatureType: 0x14, ftSignature: 'CANCEL-MARK', ftSignatureCaption: 'invoiceMark', ftSignatureFormat: 2 },
        ],
      }),
    });
    global.fetch = fetchMock;
    try {
      await svc.cancelReceipt('o1', 'Kunde hat storniert');
      const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
      // A Number would round 400001234567890 to ...890000000 and cancel the
      // wrong receipt, so the value has to survive as an exact string.
      expect(sent.ftReceiptCaseData.GR.PreviousReceiptReference.invoiceMark).toBe(
        '400001234567890',
      );
      expect(sent.cbNote).toBe('Kunde hat storniert');
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('marks the receipt CANCELLED with the cancel MARK and audits it', async () => {
    const { svc, prisma, audit } = build();
    prisma.myDataReceipt.findFirst.mockResolvedValue({
      id: 'r1',
      orderNumber: 'ORD-1',
      mark: '400001234567890',
    });
    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ftSignatures: [
          { ftSignatureType: 0x14, ftSignature: 'CANCEL-MARK', ftSignatureCaption: 'invoiceMark', ftSignatureFormat: 2 },
        ],
      }),
    });
    try {
      await svc.cancelReceipt('o1');
    } finally {
      global.fetch = originalFetch;
    }

    expect(prisma.myDataReceipt.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'r1' },
        data: expect.objectContaining({
          status: 'CANCELLED',
          cancelMark: 'CANCEL-MARK',
        }),
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'mydata.cancel_receipt', entityId: 'r1' }),
    );
  });

  it('leaves the receipt untouched when the provider rejects the cancel', async () => {
    const { svc, prisma } = build();
    prisma.myDataReceipt.findFirst.mockResolvedValue({
      id: 'r1',
      orderNumber: 'ORD-1',
      mark: '400001234567890',
    });
    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      text: async () => 'nope',
    });
    try {
      await expect(svc.cancelReceipt('o1')).rejects.toThrow('400');
    } finally {
      global.fetch = originalFetch;
    }
    // A failed cancel must not look cancelled in the database.
    expect(prisma.myDataReceipt.update).not.toHaveBeenCalled();
  });
});

describe('MyDataService — BigInt transport', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  const pending = {
    id: 'r1',
    orderNumber: 'ORD-1',
    receiptCase: RECEIPT_CASE_POS_RECEIPT,
    amounts: '[]',
    chargeItems: JSON.stringify([
      {
        ftChargeLine: 1,
        ftChargeText: 'Souvlaki',
        ftChargeAmount: 100,
        // stored as a decimal string, as recordPaidOrder writes it
        ftChargeItemCase: (CHARGE_ITEM_BASE | VAT_NORMAL).toString(),
        // The submit path rebuilds the case from the real rate, so the fixture
        // has to carry it; without VATRate the rate would be read from the
        // order (mocked as empty) and the line would fall to the zero code.
        VATRate: 24,
      },
    ]),
    payItems: JSON.stringify([
      {
        ftPayLine: 1,
        ftPayText: 'CASH',
        ftPayAmount: 100,
        ftPayItemCase: PAY_CASH.toString(),
      },
    ]),
    tableArea: null,
    totalAmount: 100,
    cbReceiptMoment: new Date('2026-11-24T10:00:00Z'),
    retryCount: 0,
  };

  it('sends Int64 case values as exact decimal strings, not lossy numbers', async () => {
    const { svc, prisma } = build();
    prisma.myDataReceipt.findMany.mockResolvedValue([pending]);
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ftSignatures: [
          { ftSignatureType: 0x14, ftSignature: 'MARK123', ftSignatureCaption: 'invoiceMark', ftSignatureFormat: 2 },
        ],
        ftReceiptJournal: { ftReceiptNumber: 1, ftReceiptMoment: '2026-11-24T10:00:01Z', ftReceiptHash: 'h' },
      }),
    });
    global.fetch = fetchMock;

    await svc.sendPending();

    // Int64 case values must travel as unquoted JSON numbers with all digits
    // intact — fiskaltrust v2 deserializes them as System.Int64 and rejects
    // quoted strings. Check the raw body text, because JSON.parse itself
    // would already collapse precision beyond 2^53.
    const rawBody: string = fetchMock.mock.calls[0][1].body;
    // The submit path rebuilds the charge case from the stored VATRate (24%),
    // so the line goes out as the Normal rate code while keeping every digit of
    // the Int64 intact.
    const expectedCase = (CHARGE_ITEM_BASE | VAT_NORMAL).toString();
    const expectedReceiptCase = RECEIPT_CASE_POS_RECEIPT.toString();
    expect(rawBody).toContain(`"ftChargeItemCase":${expectedCase}`);
    expect(rawBody).toContain(`"ftReceiptCase":${expectedReceiptCase}`);
    expect(rawBody).toContain(`"ftPayItemCase":${PAY_CASH.toString()}`);
    // No quoted occurrences of the case values anywhere in the body.
    expect(rawBody).not.toContain(`"ftChargeItemCase":"${expectedCase}"`);
    // ...and provably NOT what a Number would have produced. These Int64 values
    // exceed 2^53, so Number() silently changes the last digits and the
    // provider would receive a different tax/service case than intended.
    expect(Number(expectedCase).toString()).not.toBe(expectedCase);
  });

  it('reuses the stored checkout moment so the timestamp does not drift on retry', async () => {
    const { svc, prisma } = build();
    prisma.myDataReceipt.findMany.mockResolvedValue([pending]);
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ftSignatures: [
          { ftSignatureType: 0x14, ftSignature: 'M', ftSignatureCaption: 'invoiceMark', ftSignatureFormat: 2 },
        ],
        ftReceiptJournal: { ftReceiptNumber: 1, ftReceiptMoment: 'x', ftReceiptHash: 'h' },
      }),
    });
    global.fetch = fetchMock;

    await svc.sendPending();

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.cbReceiptMoment).toBe('2026-11-24T10:00:00.000Z');
    expect(body.cbReceiptReference).toBe('ORD-1');
    expect(body.ftCashBoxID).toBe('EL123456789');
  });
});

describe('MyDataService.stats', () => {
  it('counts each status within the branch', async () => {
    const { svc, prisma } = build();
    prisma.myDataReceipt.count
      .mockResolvedValueOnce(10) // total
      .mockResolvedValueOnce(6) // submitted
      .mockResolvedValueOnce(2) // pending
      .mockResolvedValueOnce(1) // failed
      .mockResolvedValueOnce(1); // cancelled

    await expect(svc.stats('b1')).resolves.toEqual({
      total: 10,
      submitted: 6,
      pending: 2,
      failed: 1,
      cancelled: 1,
    });
    // every count is scoped to the branch, not the whole server
    for (const call of prisma.myDataReceipt.count.mock.calls) {
      expect(call[0].where.branchId).toBe('b1');
    }
  });

  it('counts across all branches when no branch is given', async () => {
    const { svc, prisma } = build();
    prisma.myDataReceipt.count.mockResolvedValue(0);
    await svc.stats();
    expect(prisma.myDataReceipt.count.mock.calls[0][0].where).toEqual({});
  });
});

describe('MyDataService.recordRefund', () => {
  // IsReturn/IsRefund at receipt level sits at gggg 0x0100 (bits 16-19).
  const RECEIPT_CASE_REFUND =
    COUNTRY_GR | 0x0000200000000000n | (0x0100n << 16n) | 0x0001n;
  // Item-level IsReturn/IsRefund: gggg 0x0002.
  const ITEM_RETURN_FLAG = 0x0000000000020000n;

  const refundOrder = {
    id: 'o1',
    orderNumber: 'ORD-1001',
    branchId: 'b1',
    totalAmount: 124,
    items: [
      { id: 'i1', nameSnapshot: 'Souvlaki', lineTotal: 100, quantity: 1, taxRateSnapshot: 24 },
      { id: 'i2', nameSnapshot: 'Water', lineTotal: 24, quantity: 1, taxRateSnapshot: 0 },
    ],
  };

  const saleReceipt = {
    id: 'sale-1',
    orderNumber: 'ORD-1001',
    mark: '400001234567890',
  };

  function refundTx(sale: unknown = saleReceipt) {
    const create = jest.fn().mockResolvedValue({});
    const findFirst = jest
      .fn()
      // first call: has this refund already been fiscalised?
      .mockResolvedValueOnce(null)
      // second call: the sale receipt being reversed
      .mockResolvedValueOnce(sale);
    return {
      tx: {
        order: { findUniqueOrThrow: jest.fn().mockResolvedValue(refundOrder) },
        myDataReceipt: { create, findFirst },
      } as never,
      create,
      findFirst,
    };
  }

  it('writes a REFUND document with IsReturn/IsRefund and inverted lines', async () => {
    const { svc } = build();
    const { tx, create } = refundTx();
    await svc.recordRefund(tx, 'o1', 'r1', 124, 'CASH');

    expect(create).toHaveBeenCalledTimes(1);
    const data = create.mock.calls[0][0].data;

    expect(data.documentType).toBe('REFUND');
    expect(data.refundId).toBe('r1');
    expect(data.originalReceiptId).toBe('sale-1');
    expect(data.status).toBe('PENDING');
    // Full refund carries the receipt-level flag.
    expect(data.receiptCase).toBe(RECEIPT_CASE_REFUND);

    const items = JSON.parse(data.chargeItems);
    expect(items.map((ci: { Amount: number }) => ci.Amount)).toEqual([-100, -24]);
    // Every returned line carries the item flag; that is what makes it a return.
    for (const ci of items) {
      expect(BigInt(ci.ftChargeItemCase) & ITEM_RETURN_FLAG).toBe(ITEM_RETURN_FLAG);
    }

    // money out is a pay item, also flagged as a return (it was collected once)
    const pays = JSON.parse(data.payItems);
    expect(pays).toHaveLength(1);
    expect(pays[0].Amount).toBe(-124);
    expect(BigInt(pays[0].ftPayItemCase) & ITEM_RETURN_FLAG).toBe(ITEM_RETURN_FLAG);
  });

  it('keeps the sale receipt type and only returns the units handed back', async () => {
    const { svc } = build();
    const { tx, create } = refundTx();
    await svc.recordRefund(tx, 'o1', 'r2', 100, 'CASH', [
      { orderItemId: 'i1', quantity: 1 },
    ]);

    const data = create.mock.calls[0][0].data;
    // A partial refund leaves the receipt-level flag off and relies on the
    // item flags (GR docs, Table 3).
    expect(data.receiptCase).toBe(RECEIPT_CASE_POS_RECEIPT);

    const items = JSON.parse(data.chargeItems);
    expect(items).toHaveLength(1);
    expect(items[0].Description).toBe('Souvlaki');
    expect(items[0].Amount).toBe(-100);
  });

  it('writes nothing when the sale was never fiscalised', async () => {
    const { svc } = build();
    const { tx, create } = refundTx(null);
    await svc.recordRefund(tx, 'o1', 'r3', 124, 'CASH');

    // A refund referencing a document the authority never saw is worse than
    // no document at all.
    expect(create).not.toHaveBeenCalled();
  });

  it('is idempotent: a replayed refund writes no second document', async () => {
    const { svc } = build();
    const create = jest.fn().mockResolvedValue({});
    const findFirst = jest.fn().mockResolvedValueOnce({ id: 'already' });
    const tx = {
      order: { findUniqueOrThrow: jest.fn() },
      myDataReceipt: { create, findFirst },
    } as never;

    await svc.recordRefund(tx, 'o1', 'r1', 124, 'CASH');
    expect(create).not.toHaveBeenCalled();
  });
});
