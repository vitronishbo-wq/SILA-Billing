import { Router } from 'express';
import { FieldValue } from 'firebase-admin/firestore';
import {
  JAIMONA_COMPANY_ID,
  normalizeCompanyNif,
  validateCompanyNif,
  type PlanTier,
} from '../../src/core/types.ts';
import { getFirebaseAdminContext } from '../firebaseAdmin.ts';
import { requireFirebaseAuth, type AuthenticatedRequest } from '../middleware/requireFirebaseAuth.ts';
import {
  checkIsPlatformAdmin,
  verifyCompanyMembershipServer,
} from '../middleware/requirePlatformAdmin.ts';

export const companiesRouter = Router();

const MAX_COMPANIES_PER_STANDARD_USER = 3;

function sanitizeId(raw: string): string {
  return String(raw || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128) || 'item_default';
}

/**
 * POST /api/companies/register
 * Regista atomicamente uma empresa no Cloud Firestore garantindo 1 NIF = 1 Empresa.
 */
companiesRouter.post('/register', requireFirebaseAuth, async (req: AuthenticatedRequest, res) => {
  const user = req.firebaseUser!;
  const ctx = getFirebaseAdminContext();

  const body = req.body as {
    id?: string;
    legalName?: string;
    shortName?: string;
    nif?: string;
    address?: string;
    cityCountry?: string;
    phone?: string;
    email?: string;
    tagline?: string;
    baseSequence?: number;
  };

  const legalName = String(body?.legalName || '').trim();
  const shortName = String(body?.shortName || legalName).trim();
  const rawNif = String(body?.nif || '').trim();

  if (!legalName || !shortName) {
    res.status(400).json({
      ok: false,
      error: 'A designação social e o nome curto da empresa são obrigatórios.',
    });
    return;
  }

  const nifValidation = validateCompanyNif(rawNif);
  if (!nifValidation.valid) {
    res.status(400).json({
      ok: false,
      error: nifValidation.error || 'NIF empresarial inválido.',
    });
    return;
  }

  if (!ctx.db || !ctx.hasExplicitCredentials) {
    res.status(503).json({
      ok: false,
      error: 'Serviço Firestore Admin indisponível para validação centralizada neste momento.',
    });
    return;
  }

  const db = ctx.db;
  const normalizedNif = nifValidation.normalized;
  const companyId = sanitizeId(body?.id || `comp_${Date.now()}`);
  const isGlobalAdmin = await checkIsPlatformAdmin(user, db);

  try {
    // Limita criação gratuita por utilizador comum para evitar abuso
    if (!isGlobalAdmin && companyId !== JAIMONA_COMPANY_ID) {
      const ownedSnap = await db
        .collection('companies')
        .where('ownerUid', '==', user.uid)
        .limit(MAX_COMPANIES_PER_STANDARD_USER + 1)
        .get();

      const alreadyOwnsTarget = ownedSnap.docs.some((d) => d.id === companyId);
      if (!alreadyOwnsTarget && ownedSnap.size >= MAX_COMPANIES_PER_STANDARD_USER) {
        res.status(429).json({
          ok: false,
          error: `Limite atingido: cada conta pode registar até ${MAX_COMPANIES_PER_STANDARD_USER} empresas nesta fase gratuita.`,
        });
        return;
      }
    }

    const cityCountry = String(body?.cityCountry || 'Angola').trim().slice(0, 80) || 'Angola';
    const address = String(body?.address || cityCountry).trim().slice(0, 160) || cityCountry;
    const phone = String(body?.phone || '').trim().slice(0, 40);
    const email = String(body?.email || user.email || '').trim().slice(0, 120);
    const tagline =
      String(body?.tagline || 'Obrigado pela preferência').trim().slice(0, 120) ||
      'Obrigado pela preferência';
    const baseSequence =
      companyId === JAIMONA_COMPANY_ID ? 15678 : Math.max(0, Number(body?.baseSequence) || 0);

    await db.runTransaction(async (tx) => {
      const nifRef = db.collection('company_nifs').doc(normalizedNif);
      const companyRef = db.collection('companies').doc(companyId);
      const memberRef = companyRef.collection('members').doc(user.uid);
      const userLinkRef = db
        .collection('users')
        .doc(user.uid)
        .collection('company_links')
        .doc(companyId);

      const [nifSnap, compSnap] = await Promise.all([tx.get(nifRef), tx.get(companyRef)]);

      if (nifSnap.exists) {
        const existingCompanyId = String(nifSnap.data()?.companyId || '');
        const existingShortName = String(nifSnap.data()?.shortName || 'outra empresa');
        if (existingCompanyId !== companyId) {
          throw new Error(
            `CONFLICT_NIF:O NIF ${rawNif} já se encontra registado na empresa "${existingShortName}". Cada NIF cria apenas uma única empresa no sistema.`
          );
        }
      }

      if (compSnap.exists && compSnap.data()?.ownerUid !== user.uid && !isGlobalAdmin) {
        throw new Error('FORBIDDEN_COMPANY:Esta empresa pertence a outro proprietário.');
      }

      const planTier: PlanTier = (compSnap.data()?.planTier as PlanTier) || 'FREE';

      tx.set(
        nifRef,
        {
          normalizedNif,
          companyId,
          ownerUid: compSnap.data()?.ownerUid || user.uid,
          shortName: shortName.slice(0, 64),
          createdAt: nifSnap.exists ? nifSnap.data()!.createdAt : FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      tx.set(
        companyRef,
        {
          id: companyId,
          normalizedNif,
          ownerUid: compSnap.data()?.ownerUid || user.uid,
          ownerEmail: (compSnap.data()?.ownerEmail || user.email || '').slice(0, 120),
          legalName: legalName.slice(0, 160),
          shortName: shortName.slice(0, 64),
          nif: rawNif.slice(0, 32),
          address,
          cityCountry,
          phone,
          email,
          tagline,
          status: compSnap.data()?.status || 'active',
          planTier,
          commercialActive: Boolean(compSnap.data()?.commercialActive ?? false),
          baseSequence,
          allowManagerCancel: Boolean(compSnap.data()?.allowManagerCancel ?? false),
          createdAt: compSnap.exists ? compSnap.data()!.createdAt : FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      tx.set(
        memberRef,
        {
          id: `${companyId}_${user.uid}`.slice(0, 128),
          companyId,
          companyOwnerUid: compSnap.data()?.ownerUid || user.uid,
          uid: user.uid,
          email: (user.email || '').slice(0, 120),
          emailLower: (user.email || '').trim().toLowerCase().slice(0, 120),
          displayName: (user.name || user.email || 'Proprietário').slice(0, 120),
          role: 'owner',
          allowInvoiceCancel: true,
          active: true,
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      tx.set(
        userLinkRef,
        {
          companyId,
          uid: user.uid,
          role: 'owner',
          shortName: shortName.slice(0, 64),
          nif: rawNif.slice(0, 32),
          normalizedNif,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    });

    res.status(200).json({
      ok: true,
      companyId,
      normalizedNif,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Erro ao registar empresa.';
    if (msg.startsWith('CONFLICT_NIF:')) {
      res.status(409).json({ ok: false, error: msg.slice('CONFLICT_NIF:'.length) });
      return;
    }
    if (msg.startsWith('FORBIDDEN_COMPANY:')) {
      res.status(403).json({ ok: false, error: msg.slice('FORBIDDEN_COMPANY:'.length) });
      return;
    }
    res.status(500).json({ ok: false, error: msg });
  }
});

/**
 * GET /api/companies/:companyId/workspace
 * Devolve os dados isolados da empresa para operadores autenticados (owner, manager, cashier).
 */
companiesRouter.get(
  '/:companyId/workspace',
  requireFirebaseAuth,
  async (req: AuthenticatedRequest, res) => {
    const user = req.firebaseUser!;
    const ctx = getFirebaseAdminContext();
    if (!ctx.db || !ctx.hasExplicitCredentials) {
      res.status(503).json({ ok: false, error: 'Firestore Admin indisponível.' });
      return;
    }

    const companyId = sanitizeId(req.params.companyId || JAIMONA_COMPANY_ID);
    const membership = await verifyCompanyMembershipServer(ctx.db, companyId, user);
    if (!membership || !membership.existsInCloud) {
      res.status(403).json({
        ok: false,
        error: 'Sem permissão para aceder aos dados desta empresa.',
      });
      return;
    }

    try {
      const compRef = ctx.db.collection('companies').doc(companyId);
      const [prodSnap, custSnap, invSnap, membersSnap, settingsDoc] = await Promise.all([
        compRef.collection('products').get(),
        compRef.collection('customers').get(),
        compRef.collection('invoices').get(),
        compRef.collection('members').get(),
        compRef.collection('settings').doc('general').get(),
      ]);

      const includePrivatePii = membership.role === 'owner' || membership.role === 'manager';

      const customers = await Promise.all(
        custSnap.docs.map(async (d) => {
          let phone = '';
          let address = '';
          if (includePrivatePii) {
            const priv = await d.ref.collection('private').doc('contact').get();
            if (priv.exists) {
              phone = String(priv.data()?.phone || '');
              address = String(priv.data()?.address || '');
            }
          }
          return {
            id: d.id,
            ...d.data(),
            phone,
            address,
          };
        })
      );

      const invoices = await Promise.all(
        invSnap.docs.map(async (d) => {
          const itemsSnap = await d.ref.collection('items').get();
          return {
            id: d.id,
            ...d.data(),
            lines: itemsSnap.docs.map((it) => ({ id: it.id, ...it.data() })),
          };
        })
      );

      res.status(200).json({
        ok: true,
        role: membership.role,
        allowCancel: membership.allowCancel,
        company: membership.companyData,
        members: membersSnap.docs.map((m) => ({ id: m.id, ...m.data() })),
        products: prodSnap.docs.map((p) => ({ id: p.id, ...p.data() })),
        customers,
        invoices,
        settings: settingsDoc.exists ? settingsDoc.data() : null,
      });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : 'Erro ao carregar dados da empresa.',
      });
    }
  }
);

/**
 * POST /api/companies/:companyId/cancel-invoice
 * Anulação auditada de fatura com justificação obrigatória e validação de papel (owner ou manager autorizado).
 */
companiesRouter.post(
  '/:companyId/cancel-invoice',
  requireFirebaseAuth,
  async (req: AuthenticatedRequest, res) => {
    const user = req.firebaseUser!;
    const ctx = getFirebaseAdminContext();
    const companyId = sanitizeId(req.params.companyId || JAIMONA_COMPANY_ID);
    const body = req.body as { invoiceId?: string; cancelReason?: string };

    const invoiceId = sanitizeId(body?.invoiceId || '');
    const cancelReason = String(body?.cancelReason || '').trim();

    if (!invoiceId || cancelReason.length < 4) {
      res.status(400).json({
        ok: false,
        error: 'É obrigatório indicar uma justificação válida (mínimo 4 caracteres) para anular uma fatura.',
      });
      return;
    }

    if (!ctx.db || !ctx.hasExplicitCredentials) {
      res.status(200).json({ ok: true, persistedInFirestore: false });
      return;
    }

    const membership = await verifyCompanyMembershipServer(ctx.db, companyId, user);
    if (!membership || !membership.allowCancel) {
      res.status(403).json({
        ok: false,
        error: 'O seu perfil operacional não possui autorização para anular faturas emitidas.',
      });
      return;
    }

    if (membership.companyStatus === 'suspended') {
      res.status(403).json({
        ok: false,
        error: 'Esta empresa encontra-se temporariamente suspensa.',
      });
      return;
    }

    try {
      const compRef = ctx.db.collection('companies').doc(companyId);
      const invRef = compRef.collection('invoices').doc(invoiceId);
      const invSnap = await invRef.get();

      const batch = ctx.db.batch();
      if (invSnap.exists && invSnap.data()?.status !== 'cancelled') {
        batch.update(invRef, {
          status: 'cancelled',
          cancelReason: cancelReason.slice(0, 240),
          cancelledBy: (user.email || user.uid).slice(0, 120),
          updatedAt: FieldValue.serverTimestamp(),
        });
      }

      if (companyId === JAIMONA_COMPANY_ID) {
        const legacyRef = ctx.db
          .collection('users')
          .doc(user.uid)
          .collection('invoices')
          .doc(invoiceId);
        const legSnap = await legacyRef.get();
        if (legSnap.exists && legSnap.data()?.status !== 'cancelled') {
          batch.update(legacyRef, {
            status: 'cancelled',
            updatedAt: FieldValue.serverTimestamp(),
          });
        }
      }

      const cancelLogRef = compRef.collection('audit_logs').doc(`cancel_${invoiceId}`);
      batch.set(cancelLogRef, {
        invoiceId,
        companyId,
        action: 'INVOICE_CANCELLED',
        cancelReason: cancelReason.slice(0, 240),
        actorUid: user.uid,
        actorEmail: (user.email || '').slice(0, 120),
        actorRole: membership.role,
        verifiedAt: FieldValue.serverTimestamp(),
      });

      await batch.commit();
      res.status(200).json({ ok: true, persistedInFirestore: true });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : 'Erro ao registar anulação no servidor.',
      });
    }
  }
);

/**
 * POST /api/companies/check-nif
 * Verifica disponibilidade global de NIF antes ou durante o registo.
 */
companiesRouter.post('/check-nif', requireFirebaseAuth, async (req: AuthenticatedRequest, res) => {
  const ctx = getFirebaseAdminContext();
  const rawNif = String((req.body as { nif?: string })?.nif || '');
  const excludeCompanyId = String((req.body as { excludeCompanyId?: string })?.excludeCompanyId || '');

  const check = validateCompanyNif(rawNif);
  if (!check.valid) {
    res.status(400).json({ ok: false, available: false, error: check.error });
    return;
  }

  if (!ctx.db || !ctx.hasExplicitCredentials) {
    res.status(200).json({ ok: true, available: true, normalizedNif: normalizeCompanyNif(rawNif) });
    return;
  }

  const snap = await ctx.db.collection('company_nifs').doc(check.normalized).get();
  if (!snap.exists || snap.data()?.companyId === excludeCompanyId) {
    res.status(200).json({ ok: true, available: true, normalizedNif: check.normalized });
    return;
  }

  res.status(200).json({
    ok: true,
    available: false,
    normalizedNif: check.normalized,
    existingShortName: String(snap.data()?.shortName || 'Empresa registada'),
  });
});
