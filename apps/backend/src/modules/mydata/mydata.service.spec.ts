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
const CHARGE_ITEM_BASE = COUNTRY_GR | 0x2000000000000000n;
const RECEIPT_CASE_POS_RECEIPT = COUNTRY_GR | 0x2000000000000001n;

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

  it('derives the VAT nibble per line from each item tax snapshot', async () => {
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
    const nibbles = chargeItems.map((ci: { ftChargeItemCase: string }) =>
      BigInt(ci.ftChargeItemCase) & 0xfn,
    );
    expect(nibbles).toEqual([
      VAT_NORMAL,
      VAT_DISCOUNTED_1,
      VAT_SUPER_REDUCED,
      VAT_ZERO,
    ]);
    // each line keeps its fiskal base case
    for (const ci of chargeItems) {
      expect(BigInt(ci.ftChargeItemCase) & CHARGE_ITEM_BASE).toBe(
        CHARGE_ITEM_BASE,
      );
    }
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
      },
    ]),
    payItems: JSON.stringify([
      {
        ftPayLine: 1,
        ftPayText: 'CASH',
        ftPayAmount: 100,
        ftPayItemCase: (COUNTRY_GR | 0x2000000000000001n).toString(),
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
    const expectedCase = (CHARGE_ITEM_BASE | VAT_NORMAL).toString();
    const expectedReceiptCase = RECEIPT_CASE_POS_RECEIPT.toString();
    expect(rawBody).toContain(`"ftChargeItemCase":${expectedCase}`);
    expect(rawBody).toContain(`"cbReceiptCase":${expectedReceiptCase}`);
    expect(rawBody).toContain(`"ftPayItemCase":${(COUNTRY_GR | 0x2000000000000001n).toString()}`);
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
