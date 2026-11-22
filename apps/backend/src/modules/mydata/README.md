# myDATA (AADE) Integration — OrderRestro Backend

NestJS-Modul für myDATA-konforme Belegübermittlung über die
fiskaltrust CloudCloudbox SaaS (Griechenland).

## Dateien

| Datei | Zweck |
|---|---|
| `mydata.module.ts` | NestJS-Modul — importiert HttpModule, ConfigModule, AuditModule |
| `mydata.service.ts` | Kern-Logik: myDATA-Übermittlung, CancelInvoice, Cron-Retry, Stats |
| `mydata.controller.ts` | REST-Endpoints: health, stats, cancel, receipt |
| `prisma-schema-fragment.prisma` | Prisma-Modell `MyDataReceipt` (muss ins schema.prisma eingefügt werden) |
| `escpos-receipt-patch.ts` | Patch-Anleitung: 5 Änderungen am bestehenden Code für Bon-Druck |

## Architektur

```
Checkout (orders.service.ts)
  │
  ├── Prisma $transaction
  │     ├── order.update (OPEN → PAID)
  │     ├── verifactu.recordPaidOrder(tx)     ← bestehend (Spanien)
  │     ├── fiskaltrust.recordPaidOrder(tx)   ← bestehend (Deutschland)
  │     └── mydata.recordPaidOrder(tx)        ← NEU (Griechenland)
  │           └── tx.myDataReceipt.create({ status: 'PENDING' })
  │
  ▼ (Transaction committed)
  │
  Cron alle 5 Minuten (mydata.sendPending)
  │   ├── MyDataReceipt.findMany({ status: 'PENDING' })
  │   ├── POST https://pos-api[-sandbox].fiskaltrust.cloud/v2/pos
  │   │     ├── ftCashBoxID, cbReceiptReference, cbChargeItems, cbPayItems
  │   │     └── → FtPosResponse (MARK, UID, QR-Code, AuthenticationCode)
  │   └── MyDataReceipt.update({ status: 'SUBMITTED', mark, uid, ... })
  │
  ▼
  Bon-Druck (escpos-receipt.ts)
  │   ├── order.mydata.qrCodeUrl → w.qr()           ← QR-Code auf Bon
  │   ├── order.mydata.mark                       ← MARK (AADE Registrierungsnummer)
  │   ├── order.mydata.uniqueDocumentIdentifier    ← Μοναδικός αριθμός παραστατικού
  │   ├── order.mydata.authenticationCode          ← Verifizierungs-Code
  │   ├── order.mydata.providerFooter              ← Provider-Footer (Route 1)
  │   └── order.mydata.sandbox → "TEST" Hinweis
  │
  ▼
  Stornierung (mydata.controller.ts → POST /v1/mydata/cancel)
      └── POST /v2/pos/cancel { invoiceMark } → CancelInvoice bei myDATA
```

## myDATA vs. fiskaltrust (DE) vs. verifactu (ES)

| Aspekt | Deutschland (fiskaltrust) | Spanien (verifactu) | Griechenland (myDATA) |
|---|---|---|---|
| Fiskalisierung | KassenSichV + TSE | VeriFactu / AEAT | myDATA / AADE |
| Signatur-Einheit | Lokale Middleware (BYODC) | AEAT REST API | CloudCloudbox SaaS |
| Hardware | TSE-Stick/Cloud | Keine | Keine |
| Übermittlung | Sync (lokales REST) | Async (AEAT) | Async (Cloud → AADE) |
| Rückgabe | Signatur + QR | QR-URL | MARK + UID + QR + AuthCode |
| Stornierung | DSFinV-K Export | CancelInvoice | CancelInvoice |
| DB-Tabelle | FtReceipt | (verifactu) | MyDataReceipt |
| Env-Variablen | FISKALTRUST_* | VERIFACTU_* | MYDATA_* |

## Integration in OrderRestro

### 1. Prisma-Schema erweitern

```bash
# Fragment ins schema.prisma kopieren (nach dem Order-Modell)
cat src/mydata/prisma-schema-fragment.prisma >> apps/backend/prisma/schema.prisma

# Migration erstellen
cd apps/backend
npx prisma migrate dev --name add_mydata_receipt
```

### 2. Modul registrieren

In `apps/backend/src/app.module.ts`:

```typescript
import { MyDataModule } from './modules/mydata/mydata.module';

@Module({
  imports: [
    // ... bestehende Module
    MyDataModule,
  ],
})
```

### 3. OrdersService erweitern

In `apps/backend/src/modules/orders/orders.service.ts`:

```typescript
// Constructor: MyDataService injizieren
private readonly mydata: MyDataService,

// In checkout(), nach fiskaltrust.recordPaidOrder(tx, orderId):
await this.mydata.recordPaidOrder(tx, orderId);
```

In `apps/backend/src/modules/orders/orders.module.ts`:

```typescript
imports: [MyDataModule, ...],
```

### 4. Bon-Druck erweitern

Siehe `escpos-receipt-patch.ts` — 5 Änderungen am bestehenden Code,
parallel zum verifactu/fiskaltrust-Muster.

### 5. Env-Variablen

In `03-backend.yml` oder `.env`:

```yaml
- name: MYDATA_ENABLED
  value: "true"
- name: MYDATA_PROVIDER_URL
  value: "https://pos-api-sandbox.fiskaltrust.cloud"  # Sandbox
  # value: "https://pos-api.fiskaltrust.cloud"        # Produktion
- name: MYDATA_API_KEY
  valueFrom:
    secretKeyRef:
      name: kds-app-secret
      key: MYDATA_API_KEY
- name: MYDATA_VAT_NUMBER
  value: "EL999999999"  # USt-IdNr des Restaurants
```

## REST-Endpoints

| Endpoint | Auth | Zweck |
|---|---|---|
| `GET /api/v1/mydata/health` | `settings.manage` | CloudCloudbox SaaS erreichbar? |
| `GET /api/v1/mydata/stats?branchId=` | `reports.access` | Übermittelte/ausstehende Belege |
| `POST /api/v1/mydata/cancel` | `settings.manage` | Beleg bei myDATA stornieren |
| `GET /api/v1/mydata/receipt/:orderId` | `reports.access` | Belegdaten für Bon-Druck |

## Signature Items auf dem Bon (Griechenland)

| Type (sss) | Caption | Was drucken? |
|---|---|---|
| 001 | [www.fiskaltrust.gr] | QR-Code (URL des digitalen Belegs) — **mandatory** |
| 011 | ProviderSignature | Provider-Footer (nur Route 1) — **mandatory wenn vorhanden** |
| 012 | Μοναδικός αριθμός παραστατικού | Unique Document Identifier — **mandatory** |
| 013 | invoiceUid | UID — **mandatory** |
| 014 | invoiceMark | MARK — **mandatory** |
| 015 | authenticationCode | Authentication Code — **mandatory** |
| 016 | Transmission Failure | "Απώλεια Διασύνδεσης" — **mandatory wenn vorhanden** |
| 018 | OrderReceiptSignature | Informationshinis (nur 8.6) — drucken |
| 010 | mydata-xml | Vollständiges XML — **nicht drucken** (nur Audit) |

## Was fehlt noch (nicht Teil dieses Moduls)

1. **fiskaltrust CloudCloudbox Account** — im fiskaltrust.Portal (Sandbox zuerst)
2. **Queue konfigurieren** — CashBox mit griechischer VAT-Nummer im Portal anlegen
3. **Echte Credentials** — `MYDATA_API_KEY` in `01-secret.yml` eintragen
4. **Code kompilieren** — das Modul in den OrderRestro-Backend-Sourcecode integrieren und bauen (`pnpm build`)
5. **Neues Image** — Backend-Image neu bauen mit dem mydata-Modul und auf GHCR pushen
6. **Deployment aktualisieren** — `03-backend.yml` mit neuem Image-Tag + Env-Variablen
7. **Test-Beleg** — Bestellung im POS → Checkout → Bon mit MARK + QR-Code prüfen
8. **Rechtliche Prüfung** — Steuerberater für Produktivbetrieb
9. **griechische Steuersätze konfigurieren** — 24% / 13% / 6% in OrderRestro eintragen
10. **Provider-Erklärung** — falls Route 1 (licensed provider): Restaurant muss Provider bei AADE innerhalb 10 Tage melden (Α.1112/2025, art. 6)
