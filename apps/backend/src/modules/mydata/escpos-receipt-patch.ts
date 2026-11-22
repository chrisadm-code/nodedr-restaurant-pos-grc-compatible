/**
 * escpos-receipt-patch.ts — Zeigt, was in escpos-receipt.ts geändert werden muss,
 * um die myDATA-Signatur auf den Bon zu drucken (Griechenland).
 *
 * Patch-Strategie: parallel zur bestehenden verifactu-Integration (Spanien)
 * und fiskaltrust-Integration (Deutschland).
 *
 * escpos-receipt.ts hat bereits `verifactu?` und `fiskaltrust?` Felder.
 * Wir fügen ein `mydata?: ReceiptMyData | null` Feld hinzu.
 *
 * --- ÄNDERUNG 1: Interface erweitern ---
 *
 * In der bestehenden `export interface EscposReceiptOrder`:
 *
 *   // Bestehend:
 *   verifactu?: ReceiptVerifactu | null;
 *   fiskaltrust?: ReceiptFiskaltrust | null;
 *
 *   // NEU hinzufügen:
 *   mydata?: ReceiptMyData | null;
 *
 * --- ÄNDERUNG 2: Import hinzufügen ---
 *
 * // Bestehend:
 * import type { ReceiptFiskaltrust } from '../fiskaltrust/fiskaltrust.service';
 *
 * // NEU:
 * import type { ReceiptMyData } from '../mydata/mydata.service';
 *
 * --- ÄNDERUNG 3: Bon-Druck (nach dem fiskaltrust-Block) ---
 *
 * NEU direkt nach dem fiskaltrust-Block einfügen:
 *
 *   // Greece myDATA: AADE registration on receipt
 *   if (order.mydata) {
 *     const md = order.mydata;
 *     w.feed();
 *     // Document type designation (Greek)
 *     w.text('Απόδειξη Λιανικής Πώλησης', { align: 'center', bold: true });
 *     // Unique document identifier
 *     if (md.uniqueDocumentIdentifier) {
 *       w.text(`Μοναδικός αριθμός: ${md.uniqueDocumentIdentifier}`, { align: 'center' });
 *     }
 *     // MARK — the AADE registration number (mandatory)
 *     w.text(`MARK: ${md.mark}`, { align: 'center', bold: true });
 *     // UID
 *     if (md.uid) {
 *       w.text(`UID: ${md.uid}`, { align: 'center' });
 *     }
 *     // Authentication code
 *     if (md.authenticationCode) {
 *       w.text(`Auth: ${md.authenticationCode}`, { align: 'center' });
 *     }
 *     // QR code — digital receipt URL (mandatory on printed document)
 *     if (md.qrCodeUrl) {
 *       w.qr(md.qrCodeUrl);
 *     }
 *     // Provider footer (Route 1 only — licensed provider)
 *     if (md.providerFooter) {
 *       w.text(md.providerFooter, { align: 'center' });
 *     }
 *     // Transmission failure notice (must be printed if present)
 *     if (md.transmissionFailure) {
 *       w.text('Απώλεια Διασύνδεσης Οντότητας - Παρόχου', { align: 'center', bold: true });
 *     }
 *     if (md.sandbox) {
 *       w.text('** TEST (Sandbox) **', { align: 'center', bold: true });
 *     }
 *     w.feed();
 *   }
 *
 * --- ÄNDERUNG 4: orders.service.ts — recordPaidOrder aufrufen ---
 *
 * In der checkout()-Methode, nach den bestehenden fiskaltrust/verifactu Aufrufen
 * (Zeile ~1858), NEU hinzufügen:
 *
 *   // Greece myDATA: fiskaler Record in derselben Transaktion
 *   await this.mydata.recordPaidOrder(tx, orderId);
 *
 * Und im constructor, providers hinzufügen:
 *   private readonly mydata: MyDataService,
 *
 * Und im orders.module.ts:
 *   imports: [MyDataModule, ...],
 *
 * --- ÄNDERUNG 5: receipt.html.ts (Browser-Print-Fallback) ---
 *
 * Parallel zum verifactu/fiskaltrust-Block in receipt.html.ts:
 *
 *   <% if (order.mydata) { %>
 *     <div class="mydata-signature">
 *       <p>Απόδειξη Λιανικής Πώλησης</p>
 *       <p>Μοναδικός αριθμός: <%= order.mydata.uniqueDocumentIdentifier %></p>
 *       <p><strong>MARK: <%= order.mydata.mark %></strong></p>
 *       <p>UID: <%= order.mydata.uid %></p>
 *       <p>Auth: <%= order.mydata.authenticationCode %></p>
 *       <img src="<%= qrCodeDataUrl(order.mydata.qrCodeUrl) %>" />
 *       <% if (order.mydata.providerFooter) { %>
 *         <p class="provider-footer"><%= order.mydata.providerFooter %></p>
 *       <% } %>
 *       <% if (order.mydata.transmissionFailure) { %>
 *         <p class="warning">Απώλεια Διασύνδεσης Οντότητας - Παρόχου</p>
 *       <% } %>
 *       <% if (order.mydata.sandbox) { %>
 *         <p class="warning">** TEST (Sandbox) **</p>
 *       <% } %>
 *     </div>
 *   <% } %>
 *
 * --- HINWEIS: PrismaService in Controller ---
 *
 * Der MyDataController benötigt PrismaService, um orderId → branchId
 * aufzulösen vor dem Branch-Access-Check. Falls PrismaModule bereits
 * global ist (Global-Decorator), braucht es kein explizites Import.
 * Falls nicht: PrismaModule zu imports in MyDataModule hinzufügen
 * (in mydata.module.ts bereits eingetragen).
 */

// Diese Datei ist eine Patch-Anleitung, nicht ausführbarer Code.
// Sie beschreibt die 5 Änderungen, die am OrderRestro-Backend vorgenommen
// werden müssen, um die myDATA-Signatur auf den Bon zu drucken.
//
// Die Änderungen sind minimal und parallel zur bestehenden verifactu-Integration
// (Spanien) und fiskaltrust-Integration (Deutschland). Das myDATA-Modul (Griechenland)
// folgt demselben Muster.
export {};
