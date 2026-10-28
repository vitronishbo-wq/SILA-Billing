import { Router } from 'express';
import { JAIMONA_COMPANY } from '../../src/core/types.ts';
import { getFirebaseAdminContext } from '../firebaseAdmin.ts';
import { requireFirebaseAuth, type AuthenticatedRequest } from '../middleware/requireFirebaseAuth.ts';

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

  try {
    const userRoot = ctx.db.collection('users').doc(user.uid);

    const [productsSnap, customersSnap, invoicesSnap, settingsDoc, auditSnap] =
      await Promise.all([
        userRoot.collection('products').get(),
        userRoot.collection('customers').get(),
        userRoot.collection('invoices').get(),
        userRoot.collection('settings').doc('general').get(),
        userRoot.collection('audit_logs').get(),
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

    const exportBundle = {
      schemaVersion: '1.0.0',
      exportedAtIso: new Date().toISOString(),
      projectId: ctx.projectId,
      firestoreDatabaseId: ctx.databaseId,
      company: JAIMONA_COMPANY,
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

    const filename = `sila-billing-backup-${new Date().toISOString().slice(0, 10)}.json`;
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
