import { Router } from 'express';
import { JAIMONA_COMPANY, JAIMONA_COMPANY_ID } from '../../src/core/types.ts';
import { getFirebaseAdminContext } from '../firebaseAdmin.ts';
import { requireFirebaseAuth, type AuthenticatedRequest } from '../middleware/requireFirebaseAuth.ts';
import { verifyCompanyMembershipServer } from '../middleware/requirePlatformAdmin.ts';

export const backupRouter = Router();

backupRouter.get('/', requireFirebaseAuth, async (req: AuthenticatedRequest, res) => {
  const user = req.firebaseUser!;
  const ctx = getFirebaseAdminContext();

  if (!ctx.db || !ctx.hasExplicitCredentials) {
    res.status(503).json({
      ok: false,
      error:
        'A exportação administrativa requer FIREBASE_SERVICE_ACCOUNT_JSON ou FIREBASE_CREDENTIALS_BASE64 configurada no servidor.',
    });
    return;
  }

  const rawCompanyId = String(req.query.companyId || JAIMONA_COMPANY_ID)
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 128);

  try {
    const membership = await verifyCompanyMembershipServer(ctx.db, rawCompanyId, user);
    if (!membership || membership.role !== 'owner') {
      res.status(403).json({
        ok: false,
        error: 'Apenas o proprietário da empresa pode exportar o backup administrativo da cloud.',
      });
      return;
    }

    const rootRef = membership.existsInCloud
      ? ctx.db.collection('companies').doc(rawCompanyId)
      : ctx.db.collection('users').doc(user.uid);

    const [productsSnap, customersSnap, invoicesSnap, settingsDoc, auditSnap] =
      await Promise.all([
        rootRef.collection('products').get(),
        rootRef.collection('customers').get(),
        rootRef.collection('invoices').get(),
        rootRef.collection('settings').doc('general').get(),
        rootRef.collection('audit_logs').get(),
      ]);

    const products = productsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

    const customers = await Promise.all(
      customersSnap.docs.map(async (d) => {
        const privDoc = await d.ref.collection('private').doc('contact').get();
        return {
          id: d.id,
          ...d.data(),
          privateContact: privDoc.exists ? privDoc.data() : null,
        };
      })
    );

    const invoices = await Promise.all(
      invoicesSnap.docs.map(async (d) => {
        const itemsSnap = await d.ref.collection('items').get();
        return {
          id: d.id,
          ...d.data(),
          items: itemsSnap.docs.map((item) => ({ id: item.id, ...item.data() })),
        };
      })
    );

    const auditLogs = auditSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

    const companySummary = membership.companyData
      ? {
          id: rawCompanyId,
          legalName: membership.companyData.legalName,
          shortName: membership.companyData.shortName,
          nif: membership.companyData.nif,
          address: membership.companyData.address,
          cityCountry: membership.companyData.cityCountry,
        }
      : { id: JAIMONA_COMPANY_ID, ...JAIMONA_COMPANY };

    const exportBundle = {
      schemaVersion: '2.0.0',
      exportedAtIso: new Date().toISOString(),
      projectId: ctx.projectId,
      firestoreDatabaseId: ctx.databaseId,
      companyId: rawCompanyId,
      company: companySummary,
      owner: {
        uid: user.uid,
        email: user.email || '',
      },
      counts: {
        products: products.length,
        customers: customers.length,
        invoices: invoices.length,
        auditLogs: auditLogs.length,
      },
      data: {
        settings: settingsDoc.exists ? settingsDoc.data() : null,
        products,
        customers,
        invoices,
        auditLogs,
      },
    };

    const filename = `sila-billing-backup-${rawCompanyId}-${new Date().toISOString().slice(0, 10)}.json`;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.status(200).send(JSON.stringify(exportBundle, null, 2));
  } catch (err) {
    res.status(500).json({
      ok: false,
      error:
        err instanceof Error
          ? `Falha ao gerar backup JSON: ${err.message}`
          : 'Erro interno ao exportar backup.',
    });
  }
});
