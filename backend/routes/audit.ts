import { createHash } from 'crypto';
import { Router } from 'express';
import { FieldValue } from 'firebase-admin/firestore';
import { calculateInvoiceTotals, roundKz } from '../../src/core/billingEngine.ts';
import { JAIMONA_COMPANY_ID, type CartDraftItem, type TaxRate } from '../../src/core/types.ts';
import { getFirebaseAdminContext } from '../firebaseAdmin.ts';
import { requireFirebaseAuth, type AuthenticatedRequest } from '../middleware/requireFirebaseAuth.ts';
import { verifyCompanyMembershipServer } from '../middleware/requirePlatformAdmin.ts';

export const auditRouter = Router();

interface AuditInvoicePayload {
  id: string;
  companyId?: string;
  number: string;
  docType: 'FR' | 'FP';
  issuedAtIso: string;
  cashier: string;
  operator: string;
  paymentMethod: 'Dinheiro' | 'Multicaixa' | 'Transferência';
  customerId: string;
  customerName: string;
  customerNif: string;
  customerLocality: string;
  amountReceived: number;
  notes?: string;
  clientGrandTotal?: number;
  lines: Array<{
    productId: string;
    code: string;
    description: string;
    unit: string;
    qty: number;
    unitPrice: number;
    discountPct?: number;
    ivaRate: number;
  }>;
}

auditRouter.post('/invoices', requireFirebaseAuth, async (req: AuthenticatedRequest, res) => {
  const user = req.firebaseUser!;
  const body = req.body as Partial<AuditInvoicePayload>;

  if (!body || !body.id || !body.number || !Array.isArray(body.lines) || body.lines.length === 0) {
    res.status(400).json({
      ok: false,
      error: 'Payload de fatura inválido: id, número e linhas de artigos são obrigatórios.',
    });
    return;
  }

  const safeCompanyId = String(body.companyId || JAIMONA_COMPANY_ID)
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 128);

  // Normaliza e valida cada linha segundo o regime de IVA angolano (14% ou Isento 0%)
  const draftItems: CartDraftItem[] = [];
  for (const rawLine of body.lines) {
    const ivaRate: TaxRate = Number(rawLine.ivaRate) === 14 ? 14 : 0;
    const qty = Number(rawLine.qty);
    const unitPrice = Number(rawLine.unitPrice);

    if (!Number.isFinite(qty) || qty <= 0 || !Number.isFinite(unitPrice) || unitPrice < 0) {
      res.status(400).json({
        ok: false,
        error: `Linha inválida no artigo "${rawLine.description || rawLine.code}".`,
      });
      return;
    }

    draftItems.push({
      productId: String(rawLine.productId || rawLine.code || 'item').slice(0, 64),
      code: String(rawLine.code || '00000').slice(0, 32),
      description: String(rawLine.description || 'Artigo').slice(0, 160),
      unit: String(rawLine.unit || 'un').slice(0, 16),
      qty,
      unitPrice,
      discountPct: Math.min(100, Math.max(0, Number(rawLine.discountPct) || 0)),
      ivaRate,
    });
  }

  // Recalcula de forma determinística no servidor os valores de IVA 14%, Isenção 0%, Mercadorias e Total
  const serverCalc = calculateInvoiceTotals(draftItems);
  const amountReceived = Math.max(
    serverCalc.grandTotal,
    roundKz(Number(body.amountReceived) || serverCalc.grandTotal)
  );
  const changeAmount = Math.max(0, roundKz(amountReceived - serverCalc.grandTotal));

  const clientTotalDelta =
    typeof body.clientGrandTotal === 'number'
      ? Math.abs(roundKz(body.clientGrandTotal - serverCalc.grandTotal))
      : 0;

  if (clientTotalDelta > 0.05) {
    res.status(422).json({
      ok: false,
      error: `Divergência fiscal detetada entre total cliente (${body.clientGrandTotal}) e cálculo servidor (${serverCalc.grandTotal}).`,
      serverTotals: serverCalc,
    });
    return;
  }

  // Gera assinatura SHA-256 de integridade documental vinculada à empresa
  const canonicalDigest = [
    safeCompanyId,
    user.uid,
    body.number,
    body.issuedAtIso || '',
    serverCalc.merchandiseTotal.toFixed(2),
    serverCalc.taxBase14.toFixed(2),
    serverCalc.taxAmount14.toFixed(2),
    serverCalc.taxBase0.toFixed(2),
    serverCalc.grandTotal.toFixed(2),
  ].join('|');

  const auditHash = createHash('sha256').update(canonicalDigest).digest('hex');

  const ctx = getFirebaseAdminContext();
  let persistedInFirestore = false;

  if (ctx.db && ctx.hasExplicitCredentials) {
    try {
      const membership = await verifyCompanyMembershipServer(ctx.db, safeCompanyId, user);
      if (!membership) {
        res.status(403).json({
          ok: false,
          error: 'Sem permissão operacional para emitir documentos nesta empresa.',
        });
        return;
      }

      if (membership.companyStatus === 'suspended') {
        res.status(403).json({
          ok: false,
          error: 'Esta empresa encontra-se suspensa e não pode emitir novas faturas.',
        });
        return;
      }

      const safeInvoiceId = String(body.id).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128);
      const batch = ctx.db.batch();

      const invoicePayloadBase = {
        id: safeInvoiceId,
        number: String(body.number).slice(0, 40),
        docType: body.docType === 'FP' ? 'FP' : 'FR',
        issuedAtIso: String(body.issuedAtIso || new Date().toISOString()).slice(0, 40),
        cashier: String(body.cashier || '01').slice(0, 16),
        operator: String(body.operator || '001').slice(0, 32),
        paymentMethod:
          body.paymentMethod === 'Multicaixa' || body.paymentMethod === 'Transferência'
            ? body.paymentMethod
            : 'Dinheiro',
        customerId: String(body.customerId || 'cust_direct')
          .replace(/[^a-zA-Z0-9_-]/g, '_')
          .slice(0, 128),
        customerName: String(body.customerName || 'Cliente de Venda Directa').slice(0, 160),
        customerNif: String(body.customerNif || 'Consumidor Final').slice(0, 32),
        customerLocality: String(body.customerLocality || 'Angola').slice(0, 160),
        merchandiseTotal: serverCalc.merchandiseTotal,
        discountTotal: serverCalc.discountTotal,
        taxBase14: serverCalc.taxBase14,
        taxAmount14: serverCalc.taxAmount14,
        taxBase0: serverCalc.taxBase0,
        taxAmount0: 0,
        taxTotal: serverCalc.taxTotal,
        grandTotal: serverCalc.grandTotal,
        amountInWords: serverCalc.amountInWords.slice(0, 300),
        amountReceived,
        changeAmount,
        notes: String(body.notes || '').slice(0, 300),
        itemCount: serverCalc.lines.length,
        status: 'issued',
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      };

      if (membership.existsInCloud) {
        const companyOwnerUid = String(membership.companyData?.ownerUid || user.uid);
        const compInvRef = ctx.db
          .collection('companies')
          .doc(safeCompanyId)
          .collection('invoices')
          .doc(safeInvoiceId);
        const compAuditRef = ctx.db
          .collection('companies')
          .doc(safeCompanyId)
          .collection('audit_logs')
          .doc(safeInvoiceId);

        batch.set(
          compInvRef,
          {
            ...invoicePayloadBase,
            companyId: safeCompanyId,
            companyOwnerUid,
            emittedByUid: user.uid,
          },
          { merge: true }
        );

        for (const line of serverCalc.lines) {
          const safeItemId = line.id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128);
          batch.set(compInvRef.collection('items').doc(safeItemId), {
            id: safeItemId,
            invoiceId: safeInvoiceId,
            companyId: safeCompanyId,
            companyOwnerUid,
            code: line.code,
            description: line.description,
            unit: line.unit,
            qty: line.qty,
            unitPrice: line.unitPrice,
            discountPct: line.discountPct,
            ivaRate: line.ivaRate,
            lineGross: line.lineGross,
            lineNet: line.lineNet,
            lineBase: line.lineBase,
            lineTax: line.lineTax,
            lineTotal: line.lineTotal,
            createdAt: FieldValue.serverTimestamp(),
          });
        }

        batch.set(compAuditRef, {
          invoiceId: safeInvoiceId,
          companyId: safeCompanyId,
          invoiceNumber: String(body.number).slice(0, 40),
          actorUid: user.uid,
          actorEmail: user.email || '',
          actorRole: membership.role,
          grandTotal: serverCalc.grandTotal,
          taxBase14: serverCalc.taxBase14,
          taxAmount14: serverCalc.taxAmount14,
          taxBase0: serverCalc.taxBase0,
          auditHash,
          verifiedAt: FieldValue.serverTimestamp(),
        });
      }

      // Mantém continuidade na coleção clássica para a empresa inicial JAIMONA
      if (safeCompanyId === JAIMONA_COMPANY_ID) {
        const invRef = ctx.db
          .collection('users')
          .doc(user.uid)
          .collection('invoices')
          .doc(safeInvoiceId);
        const auditRef = ctx.db
          .collection('users')
          .doc(user.uid)
          .collection('audit_logs')
          .doc(safeInvoiceId);

        batch.set(invRef, { ...invoicePayloadBase, ownerId: user.uid }, { merge: true });

        for (const line of serverCalc.lines) {
          const safeItemId = line.id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128);
          batch.set(invRef.collection('items').doc(safeItemId), {
            id: safeItemId,
            invoiceId: safeInvoiceId,
            ownerId: user.uid,
            code: line.code,
            description: line.description,
            unit: line.unit,
            qty: line.qty,
            unitPrice: line.unitPrice,
            discountPct: line.discountPct,
            ivaRate: line.ivaRate,
            lineGross: line.lineGross,
            lineNet: line.lineNet,
            lineBase: line.lineBase,
            lineTax: line.lineTax,
            lineTotal: line.lineTotal,
            createdAt: FieldValue.serverTimestamp(),
          });
        }

        batch.set(auditRef, {
          invoiceId: safeInvoiceId,
          invoiceNumber: String(body.number).slice(0, 40),
          ownerId: user.uid,
          ownerEmail: user.email || '',
          grandTotal: serverCalc.grandTotal,
          taxBase14: serverCalc.taxBase14,
          taxAmount14: serverCalc.taxAmount14,
          taxBase0: serverCalc.taxBase0,
          auditHash,
          verifiedAt: FieldValue.serverTimestamp(),
        });
      }

      await batch.commit();
      persistedInFirestore = true;
    } catch (err) {
      res.status(500).json({
        ok: false,
        error:
          err instanceof Error
            ? `Erro ao persistir auditoria no Firestore: ${err.message}`
            : 'Erro ao gravar auditoria no Firestore.',
      });
      return;
    }
  }

  res.status(200).json({
    ok: true,
    auditHash,
    persistedInFirestore,
    databaseId: ctx.databaseId,
    validatedTotals: {
      merchandiseTotal: serverCalc.merchandiseTotal,
      discountTotal: serverCalc.discountTotal,
      taxBase14: serverCalc.taxBase14,
      taxAmount14: serverCalc.taxAmount14,
      taxBase0: serverCalc.taxBase0,
      taxTotal: serverCalc.taxTotal,
      grandTotal: serverCalc.grandTotal,
      amountReceived,
      changeAmount,
      amountInWords: serverCalc.amountInWords,
    },
  });
});
