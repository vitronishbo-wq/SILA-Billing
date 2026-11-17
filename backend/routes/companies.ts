import { Router } from 'express';
import { FieldValue } from 'firebase-admin/firestore';
import {
  buildDefaultCompanyRoles,
  canActorManageRoleDefinition,
  canActorManageTargetMember,
  resolveMemberBaseRole,
  resolveMemberPermissions,
  resolveMemberStatus,
} from '../../src/core/rbac.ts';
import {
  canCompanyInviteCloudMembers,
  isJaimonaOwnerEmail,
  JAIMONA_COMPANY_ID,
  JAIMONA_OWNER_EMAIL,
  normalizeCompanyNif,
  validateCompanyNif,
  VITRONIS_INSTITUTIONAL,
  type CompanyMember,
  type CompanyRole,
  type CompanyRoleDefinition,
  type MemberPermissionOverrides,
  type PermissionKey,
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
    termsAcceptedVersion?: string;
    termsAcceptedAtIso?: string;
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

  if (companyId === JAIMONA_COMPANY_ID && !isJaimonaOwnerEmail(user.email) && !isGlobalAdmin) {
    res.status(403).json({
      ok: false,
      error: 'Este identificador empresarial pertence exclusivamente ao titular registado da empresa JAIMONA.',
    });
    return;
  }

  try {
    // Regra igualitária para todas as empresas: limite de criação gratuita por conta comum
    if (!isGlobalAdmin) {
      const ownedSnap = await db
        .collection('companies')
        .where('ownerUid', '==', user.uid)
        .limit(MAX_COMPANIES_PER_STANDARD_USER + 1)
        .get();

      const alreadyOwnsTarget = ownedSnap.docs.some((d) => d.id === companyId);
      if (!alreadyOwnsTarget && ownedSnap.size >= MAX_COMPANIES_PER_STANDARD_USER) {
        res.status(429).json({
          ok: false,
          error: `Limite atingido: cada conta pode registar até ${MAX_COMPANIES_PER_STANDARD_USER} empresas autonomamente. Contacte o suporte VITRONIS para expansão corporativa.`,
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
    const baseSequence = Math.max(0, Number(body?.baseSequence) || 0);

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

      const defaultPlan: PlanTier =
        companyId === JAIMONA_COMPANY_ID ? 'PROFISSIONAL' : 'FREE';
      const existingPlan = compSnap.data()?.planTier as PlanTier | undefined;
      const planTier: PlanTier =
        companyId === JAIMONA_COMPANY_ID && (!existingPlan || existingPlan === 'FREE')
          ? 'PROFISSIONAL'
          : existingPlan || defaultPlan;
      const commercialActive =
        companyId === JAIMONA_COMPANY_ID
          ? true
          : Boolean(compSnap.data()?.commercialActive ?? planTier !== 'FREE');
      const resolvedOwnerEmail =
        companyId === JAIMONA_COMPANY_ID
          ? JAIMONA_OWNER_EMAIL
          : (compSnap.data()?.ownerEmail || user.email || '').slice(0, 120);
      const termsAcceptedVersion = String(
        compSnap.data()?.termsAcceptedVersion ||
          body?.termsAcceptedVersion ||
          VITRONIS_INSTITUTIONAL.termsVersion
      ).slice(0, 32);
      const termsAcceptedAtIso = String(
        compSnap.data()?.termsAcceptedAtIso ||
          body?.termsAcceptedAtIso ||
          new Date().toISOString()
      ).slice(0, 40);

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
          ownerEmail: resolvedOwnerEmail,
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
          commercialActive,
          baseSequence: Number(compSnap.data()?.baseSequence ?? baseSequence) || baseSequence,
          allowManagerCancel: Boolean(compSnap.data()?.allowManagerCancel ?? false),
          termsAcceptedVersion,
          termsAcceptedAtIso,
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

    const rawCompanyId = String(req.params.companyId || '').trim();
    if (!rawCompanyId) {
      res.status(400).json({ ok: false, error: 'Identificador da empresa (companyId) é obrigatório.' });
      return;
    }
    const companyId = sanitizeId(rawCompanyId);
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
      const canSeeCosting = Boolean(membership.permissions.cost_prices_view);
      const canSeePurchases = Boolean(
        membership.permissions.purchases_view || membership.permissions.suppliers_view
      );
      const canSeeAllCash = Boolean(membership.permissions.cash_all_shifts);
      const includePrivatePii = Boolean(
        membership.permissions.customers_manage ||
          membership.permissions.suppliers_manage ||
          membership.permissions.finance_view
      );

      const [
        prodSnap,
        custSnap,
        invSnap,
        membersSnap,
        rolesSnap,
        sessSnap,
        movSnap,
        stockMovSnap,
        supSnap,
        purSnap,
        settingsDoc,
      ] = await Promise.all([
        compRef.collection('products').get(),
        compRef.collection('customers').get(),
        compRef.collection('invoices').get(),
        compRef.collection('members').get(),
        compRef.collection('roles').get(),
        compRef.collection('cash_sessions').get(),
        compRef.collection('cash_movements').get(),
        compRef.collection('stock_movements').get(),
        canSeePurchases ? compRef.collection('suppliers').get() : Promise.resolve(null),
        canSeePurchases ? compRef.collection('purchases').get() : Promise.resolve(null),
        membership.permissions.master_view ||
        membership.permissions.settings_manage ||
        membership.permissions.pos_sell ||
        membership.permissions.a4_sell
          ? compRef.collection('settings').doc('general').get()
          : Promise.resolve(null),
      ]);

      const products = await Promise.all(
        prodSnap.docs.map(async (d) => {
          const pData = { ...d.data() } as Record<string, unknown>;
          if (!canSeeCosting) {
            delete pData.costPrice;
            if (Array.isArray(pData.priceHistory)) {
              pData.priceHistory = pData.priceHistory.map((h) => {
                if (!h || typeof h !== 'object') return h;
                const copy = { ...(h as Record<string, unknown>) };
                delete copy.previousCost;
                delete copy.newCost;
                return copy;
              });
            }
          } else {
            const costSnap = await d.ref
              .collection('private')
              .doc('costing')
              .get()
              .catch(() => null);
            if (costSnap && costSnap.exists && typeof costSnap.data()?.costPrice === 'number') {
              pData.costPrice = costSnap.data()!.costPrice;
            }
          }
          return { id: d.id, ...pData };
        })
      );

      const customers = await Promise.all(
        custSnap.docs.map(async (d) => {
          let phone = '';
          let email = '';
          let address = '';
          let bankName = '';
          let bankIban = '';
          let representativeName = '';
          let representativePhone = '';
          if (includePrivatePii) {
            const priv = await d.ref.collection('private').doc('contact').get();
            if (priv.exists) {
              const pData = priv.data();
              phone = String(pData?.phone || '');
              email = String(pData?.email || '');
              address = String(pData?.address || '');
              bankName = String(pData?.bankName || '');
              bankIban = String(pData?.bankIban || '');
              representativeName = String(pData?.representativeName || '');
              representativePhone = String(pData?.representativePhone || '');
            }
          }
          return {
            id: d.id,
            ...d.data(),
            phone,
            email,
            address,
            ...(bankName ? { bankName } : {}),
            ...(bankIban ? { bankIban } : {}),
            ...(representativeName ? { representativeName } : {}),
            ...(representativePhone ? { representativePhone } : {}),
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

      const suppliers = canSeePurchases && supSnap
        ? await Promise.all(
            supSnap.docs.map(async (d) => {
              let phone = '';
              let email = '';
              let address = '';
              if (includePrivatePii) {
                const priv = await d.ref.collection('private').doc('contact').get();
                if (priv.exists) {
                  phone = String(priv.data()?.phone || '');
                  email = String(priv.data()?.email || '');
                  address = String(priv.data()?.address || '');
                }
              }
              return {
                id: d.id,
                ...d.data(),
                phone,
                email,
                address,
              };
            })
          )
        : [];

      const purchases = canSeePurchases && purSnap
        ? await Promise.all(
            purSnap.docs.map(async (d) => {
              const itemsSnap = await d.ref.collection('items').get();
              return {
                id: d.id,
                ...d.data(),
                lines: itemsSnap.docs.map((it) => ({ id: it.id, ...it.data() })),
              };
            })
          )
        : [];

      const cashSessions = sessSnap.docs
        .map((s) => ({ id: s.id, ...s.data() }) as Record<string, unknown>)
        .filter((s) => canSeeAllCash || s.openedByUid === user.uid);

      const cashMovements = movSnap.docs
        .map((m) => ({ id: m.id, ...m.data() }) as Record<string, unknown>)
        .filter((m) => canSeeAllCash || m.createdByUid === user.uid);

      const members = membersSnap.docs
        .filter((m) => {
          if (membership.permissions.users_view || membership.role === 'owner') return true;
          return m.id === user.uid || m.data()?.uid === user.uid;
        })
        .map((m) => {
          const md = { ...m.data() } as Record<string, unknown>;
          if (m.id !== user.uid && md.uid !== user.uid) {
            delete md.pinHash;
          }
          return { id: m.id, ...md };
        });

      const systemRoles = buildDefaultCompanyRoles(companyId);
      const customRoles = rolesSnap.docs.map((r) => ({ id: r.id, ...r.data() }));
      const roles = [
        ...systemRoles.filter((sr) => !customRoles.some((cr) => cr.id === sr.id)),
        ...customRoles,
      ];

      res.status(200).json({
        ok: true,
        role: membership.role,
        roleId: membership.roleId,
        permissions: membership.permissions,
        establishmentIds: membership.establishmentIds,
        authorizedCashiers: membership.authorizedCashiers,
        allowCancel: membership.allowCancel,
        company: membership.companyData,
        members,
        roles,
        products,
        customers,
        invoices,
        cashSessions,
        cashMovements,
        stockMovements: stockMovSnap.docs.map((sm) => ({ id: sm.id, ...sm.data() })),
        suppliers,
        purchases,
        settings: settingsDoc && settingsDoc.exists ? settingsDoc.data() : null,
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
    const rawCompanyId = String(req.params.companyId || '').trim();
    if (!rawCompanyId) {
      res.status(400).json({ ok: false, error: 'Identificador da empresa (companyId) é obrigatório.' });
      return;
    }
    const companyId = sanitizeId(rawCompanyId);
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

    const cloudPlan = String(membership.companyData?.planTier || 'FREE');
    const canPersistCloud =
      companyId === JAIMONA_COMPANY_ID ||
      cloudPlan === 'PROFISSIONAL' ||
      cloudPlan === 'ENTERPRISE';

    if (!canPersistCloud) {
      res.status(200).json({ ok: true, persistedInFirestore: false });
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
          cancelledAtIso: new Date().toISOString().slice(0, 40),
          updatedAt: FieldValue.serverTimestamp(),
        });
      }

      if (companyId === JAIMONA_COMPANY_ID && isJaimonaOwnerEmail(user.email)) {
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

/**
 * POST /api/companies/invites/claim
 * Reivindica convites pendentes no login Google verificado do colaborador e cria company_links reais.
 */
companiesRouter.post(
  '/invites/claim',
  requireFirebaseAuth,
  async (req: AuthenticatedRequest, res) => {
    const user = req.firebaseUser!;
    const ctx = getFirebaseAdminContext();
    if (!user.email_verified || !user.email) {
      res.status(403).json({
        ok: false,
        error: 'É obrigatório ter um e-mail verificado na conta Google para reivindicar convites.',
      });
      return;
    }

    if (!ctx.db || !ctx.hasExplicitCredentials) {
      res.status(200).json({ ok: true, claimedCompanyIds: [] });
      return;
    }

    const emailLower = user.email.trim().toLowerCase();
    try {
      const pendingSnap = await ctx.db
        .collection('company_invites')
        .where('emailLower', '==', emailLower)
        .where('status', '==', 'pending')
        .get();

      if (pendingSnap.empty) {
        res.status(200).json({ ok: true, claimedCompanyIds: [] });
        return;
      }

      const claimedCompanyIds: string[] = [];
      const nowIso = new Date().toISOString();

      for (const invDoc of pendingSnap.docs) {
        const inv = invDoc.data();
        const companyId = sanitizeId(String(inv.companyId || ''));
        if (!companyId) continue;

        const compRef = ctx.db.collection('companies').doc(companyId);
        const compSnap = await compRef.get();
        if (!compSnap.exists) continue;
        const cData = compSnap.data() || {};
        const companyOwnerUid = String(cData.ownerUid || '');
        const legacyMemberId = sanitizeId(String(inv.memberId || ''));

        const batch = ctx.db.batch();
        const targetMemberRef = compRef.collection('members').doc(user.uid);
        const oldMemberSnap =
          legacyMemberId && legacyMemberId !== user.uid
            ? await compRef.collection('members').doc(legacyMemberId).get()
            : null;
        const baseMemberData = oldMemberSnap?.exists ? oldMemberSnap.data() || {} : {};

        const baseRole = resolveMemberBaseRole({
          role: (inv.role || baseMemberData.role || 'cashier') as CompanyRole,
        });

        batch.set(
          targetMemberRef,
          {
            ...baseMemberData,
            id: user.uid,
            companyId,
            companyOwnerUid,
            uid: user.uid,
            email: user.email.slice(0, 120),
            emailLower: emailLower.slice(0, 120),
            displayName: String(
              inv.displayName || baseMemberData.displayName || user.name || user.email
            ).slice(0, 120),
            role: baseRole,
            roleId: String(inv.roleId || baseMemberData.roleId || `role_${baseRole}`),
            establishmentIds: Array.isArray(inv.establishmentIds)
              ? inv.establishmentIds
              : Array.isArray(baseMemberData.establishmentIds)
                ? baseMemberData.establishmentIds
                : [],
            authorizedCashiers: Array.isArray(inv.authorizedCashiers)
              ? inv.authorizedCashiers
              : Array.isArray(baseMemberData.authorizedCashiers)
                ? baseMemberData.authorizedCashiers
                : [],
            status: 'active',
            active: true,
            allowInvoiceCancel: Boolean(baseMemberData.allowInvoiceCancel),
            claimedAtIso: nowIso,
            createdAt: baseMemberData.createdAt || FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true }
        );

        if (oldMemberSnap?.exists && legacyMemberId !== user.uid) {
          batch.delete(oldMemberSnap.ref);
        }

        const linkRef = ctx.db
          .collection('users')
          .doc(user.uid)
          .collection('company_links')
          .doc(companyId);
        batch.set(
          linkRef,
          {
            companyId,
            uid: user.uid,
            role: baseRole,
            shortName: String(cData.shortName || inv.companyShortName || 'Empresa').slice(0, 64),
            nif: String(cData.nif || '').slice(0, 32),
            normalizedNif: String(cData.normalizedNif || ''),
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true }
        );

        batch.update(invDoc.ref, {
          status: 'accepted',
          acceptedByUid: user.uid,
          updatedAtIso: nowIso,
          updatedAt: FieldValue.serverTimestamp(),
        });

        const auditRef = compRef.collection('audit_logs').doc(`claim_${invDoc.id}_${Date.now()}`);
        batch.set(auditRef, {
          id: auditRef.id,
          companyId,
          actorUid: user.uid,
          actorEmail: emailLower.slice(0, 120),
          actorName: String(inv.displayName || user.email).slice(0, 120),
          actorRole: baseRole,
          action: 'INVITE_CLAIM',
          targetType: 'member',
          targetId: user.uid,
          summary: `Convite aceite e conta associada para ${emailLower}`,
          outcome: 'allowed',
          createdAtIso: nowIso,
          createdAt: FieldValue.serverTimestamp(),
        });

        await batch.commit();
        claimedCompanyIds.push(companyId);
      }

      res.status(200).json({ ok: true, claimedCompanyIds });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : 'Erro ao reivindicar convite.',
      });
    }
  }
);

/**
 * POST /api/companies/:companyId/members
 * Cria ou actualiza um colaborador com validação anti-escalada e emissão de convite Cloud.
 */
companiesRouter.post(
  '/:companyId/members',
  requireFirebaseAuth,
  async (req: AuthenticatedRequest, res) => {
    const user = req.firebaseUser!;
    const ctx = getFirebaseAdminContext();
    const companyId = sanitizeId(String(req.params.companyId || '').trim());
    if (!companyId) {
      res.status(400).json({ ok: false, error: 'companyId obrigatório.' });
      return;
    }

    if (!ctx.db || !ctx.hasExplicitCredentials) {
      res.status(200).json({ ok: true, persistedInFirestore: false });
      return;
    }

    const membership = await verifyCompanyMembershipServer(ctx.db, companyId, user);
    if (!membership || !membership.existsInCloud || !membership.memberRecord) {
      res.status(403).json({ ok: false, error: 'Acesso negado à empresa.' });
      return;
    }

    const planTier = String(membership.companyData?.planTier || 'FREE') as PlanTier;
    const isCommercialCloud = canCompanyInviteCloudMembers({
      id: companyId,
      plan: {
        planTier,
        commercialActive: Boolean(membership.companyData?.commercialActive),
        maxUsers: null,
        maxInvoicesPerMonth: null,
        updatedAtIso: '',
      },
    });
    if (!isCommercialCloud) {
      res.status(200).json({ ok: true, persistedInFirestore: false, localOnlyPlan: true });
      return;
    }

    const body = req.body as Partial<CompanyMember> & {
      sendCloudInvite?: boolean;
      establishmentIds?: string[];
      authorizedCashiers?: string[];
      permissionOverrides?: MemberPermissionOverrides;
    };

    const email = String(body.email || '').trim().toLowerCase();
    const displayName = String(body.displayName || '').trim();
    if (!email || !email.includes('@') || !displayName) {
      res.status(400).json({ ok: false, error: 'Nome e e-mail válido do colaborador são obrigatórios.' });
      return;
    }

    const targetNewRole = resolveMemberBaseRole({ role: (body.role || 'cashier') as CompanyRole });
    const compRef = ctx.db.collection('companies').doc(companyId);
    const rolesSnap = await compRef.collection('roles').get().catch(() => null);
    const customRoles: CompanyRoleDefinition[] = (rolesSnap?.docs || []).map(
      (d) => ({ id: d.id, ...(d.data() as Omit<CompanyRoleDefinition, 'id'>) })
    );
    const allRoles = [...buildDefaultCompanyRoles(companyId), ...customRoles];

    const targetMemberId = sanitizeId(
      String(body.id || `mem_${email.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64)}`)
    );
    const existingMemberSnap = await compRef.collection('members').doc(targetMemberId).get();
    const existingRole = existingMemberSnap.exists
      ? resolveMemberBaseRole({ role: existingMemberSnap.data()?.role as CompanyRole })
      : undefined;

    const candidateTargetStub: CompanyMember = {
      id: targetMemberId,
      companyId,
      uid: String(body.uid || targetMemberId),
      email,
      displayName,
      role: targetNewRole,
      roleId: String(body.roleId || `role_${targetNewRole}`),
      permissionOverrides: body.permissionOverrides,
      status: 'active',
      allowInvoiceCancel: Boolean(body.allowInvoiceCancel),
      active: true,
      createdAtIso: new Date().toISOString(),
      updatedAtIso: new Date().toISOString(),
    };
    const targetPerms = resolveMemberPermissions(
      candidateTargetStub,
      allRoles,
      Boolean(membership.companyData?.allowManagerCancel)
    );

    const authz = canActorManageTargetMember({
      actor: membership.memberRecord,
      actorPermissions: membership.permissions,
      targetCurrentRole: existingRole,
      targetNewRole,
      targetPermissions: targetPerms,
      isSelfEdit:
        targetMemberId === user.uid ||
        email === (user.email || '').trim().toLowerCase(),
    });
    if (!authz.allowed) {
      res.status(403).json({ ok: false, error: authz.reason });
      return;
    }

    const nowIso = new Date().toISOString();
    const status =
      body.status === 'suspended'
        ? 'suspended'
        : body.status === 'active' && existingMemberSnap.exists && existingMemberSnap.data()?.claimedAtIso
          ? 'active'
          : body.status === 'active' && targetNewRole === 'owner'
            ? 'active'
            : existingMemberSnap.exists && existingMemberSnap.data()?.uid && !String(existingMemberSnap.data()?.uid).startsWith('mem_')
              ? body.status || 'active'
              : 'pending_invite';

    const companyOwnerUid = String(membership.companyData?.ownerUid || user.uid);
    const batch = ctx.db.batch();
    const memberRef = compRef.collection('members').doc(targetMemberId);

    const payload: Record<string, unknown> = {
      id: targetMemberId,
      companyId,
      companyOwnerUid,
      uid: sanitizeId(String(existingMemberSnap.data()?.uid || body.uid || targetMemberId)),
      email: email.slice(0, 120),
      emailLower: email.slice(0, 120),
      ...(body.phone ? { phone: String(body.phone).trim().slice(0, 32) } : {}),
      displayName: displayName.slice(0, 120),
      role: targetNewRole,
      roleId: String(body.roleId || `role_${targetNewRole}`).slice(0, 64),
      establishmentIds: Array.isArray(body.establishmentIds)
        ? body.establishmentIds.map((x) => sanitizeId(String(x))).slice(0, 20)
        : [],
      authorizedCashiers: Array.isArray(body.authorizedCashiers)
        ? body.authorizedCashiers.map((x) => String(x).trim().slice(0, 24)).slice(0, 20)
        : [],
      permissionOverrides: {
        grant: (body.permissionOverrides?.grant || []).slice(0, 40),
        revoke: (body.permissionOverrides?.revoke || []).slice(0, 40),
      },
      status,
      allowInvoiceCancel: Boolean(targetPerms.invoice_cancel),
      active: status === 'active',
      invitedByUid: existingMemberSnap.data()?.invitedByUid || user.uid,
      updatedAt: FieldValue.serverTimestamp(),
    };
    if (!existingMemberSnap.exists) {
      payload.createdAt = FieldValue.serverTimestamp();
    }
    if (body.pinHash) {
      payload.pinHash = String(body.pinHash).slice(0, 256);
    }

    batch.set(memberRef, payload, { merge: true });

    if (status === 'pending_invite') {
      const inviteId = sanitizeId(`inv_${companyId}_${email.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48)}`);
      batch.set(
        ctx.db.collection('company_invites').doc(inviteId),
        {
          id: inviteId,
          companyId,
          companyShortName: String(membership.companyData?.shortName || 'Empresa').slice(0, 64),
          memberId: targetMemberId,
          emailLower: email.slice(0, 120),
          displayName: displayName.slice(0, 120),
          role: targetNewRole,
          roleId: String(body.roleId || `role_${targetNewRole}`).slice(0, 64),
          establishmentIds: payload.establishmentIds,
          authorizedCashiers: payload.authorizedCashiers,
          status: 'pending',
          createdByUid: user.uid,
          createdAtIso: nowIso,
          updatedAtIso: nowIso,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }

    const auditRef = compRef.collection('audit_logs').doc(`mem_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
    batch.set(auditRef, {
      id: auditRef.id,
      companyId,
      actorUid: user.uid,
      actorEmail: (user.email || '').slice(0, 120),
      actorName: membership.memberRecord.displayName.slice(0, 120),
      actorRole: membership.role,
      action: existingMemberSnap.exists ? 'USER_UPDATE' : 'USER_CREATE',
      targetType: 'member',
      targetId: targetMemberId,
      summary: `${existingMemberSnap.exists ? 'Atualizado' : 'Adicionado'} colaborador ${displayName} (${email}) · Função: ${targetNewRole} · Estado: ${status}`,
      outcome: 'allowed',
      createdAtIso: nowIso,
      createdAt: FieldValue.serverTimestamp(),
    });

    await batch.commit();
    res.status(200).json({ ok: true, persistedInFirestore: true, memberId: targetMemberId, status });
  }
);

/**
 * DELETE /api/companies/:companyId/members/:memberId
 */
companiesRouter.delete(
  '/:companyId/members/:memberId',
  requireFirebaseAuth,
  async (req: AuthenticatedRequest, res) => {
    const user = req.firebaseUser!;
    const ctx = getFirebaseAdminContext();
    const companyId = sanitizeId(String(req.params.companyId || '').trim());
    const memberId = sanitizeId(String(req.params.memberId || '').trim());
    if (!ctx.db || !ctx.hasExplicitCredentials) {
      res.status(200).json({ ok: true, persistedInFirestore: false });
      return;
    }

    const membership = await verifyCompanyMembershipServer(ctx.db, companyId, user);
    if (!membership || !membership.existsInCloud || !membership.memberRecord) {
      res.status(403).json({ ok: false, error: 'Acesso negado.' });
      return;
    }

    const compRef = ctx.db.collection('companies').doc(companyId);
    const targetRef = compRef.collection('members').doc(memberId);
    const targetSnap = await targetRef.get();
    if (!targetSnap.exists) {
      res.status(200).json({ ok: true });
      return;
    }

    const targetRole = resolveMemberBaseRole({ role: targetSnap.data()?.role as CompanyRole });
    const authz = canActorManageTargetMember({
      actor: membership.memberRecord,
      actorPermissions: membership.permissions,
      targetCurrentRole: targetRole,
      targetNewRole: targetRole,
      isSelfEdit: memberId === user.uid,
    });
    if (!authz.allowed || targetRole === 'owner') {
      res.status(403).json({ ok: false, error: authz.reason || 'Não pode remover o Proprietário.' });
      return;
    }

    const batch = ctx.db.batch();
    batch.delete(targetRef);
    const targetUid = String(targetSnap.data()?.uid || '');
    if (targetUid && !targetUid.startsWith('mem_')) {
      batch.delete(ctx.db.collection('users').doc(targetUid).collection('company_links').doc(companyId));
    }
    const targetEmailLower = String(targetSnap.data()?.emailLower || '').trim().toLowerCase();
    if (targetEmailLower) {
      const invId = sanitizeId(`inv_${companyId}_${targetEmailLower.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48)}`);
      batch.set(
        ctx.db.collection('company_invites').doc(invId),
        { status: 'revoked', updatedAtIso: new Date().toISOString() },
        { merge: true }
      );
    }

    const auditRef = compRef.collection('audit_logs').doc(`delmem_${Date.now()}`);
    batch.set(auditRef, {
      id: auditRef.id,
      companyId,
      actorUid: user.uid,
      actorEmail: (user.email || '').slice(0, 120),
      actorName: membership.memberRecord.displayName.slice(0, 120),
      actorRole: membership.role,
      action: 'USER_SUSPEND',
      targetType: 'member',
      targetId: memberId,
      summary: `Removido colaborador ${targetSnap.data()?.displayName || targetEmailLower}`,
      outcome: 'allowed',
      createdAtIso: new Date().toISOString(),
      createdAt: FieldValue.serverTimestamp(),
    });
    await batch.commit();
    res.status(200).json({ ok: true, persistedInFirestore: true });
  }
);

/**
 * POST /api/companies/:companyId/roles
 * Cria ou edita função personalizada com bloqueio anti-escalada.
 */
companiesRouter.post(
  '/:companyId/roles',
  requireFirebaseAuth,
  async (req: AuthenticatedRequest, res) => {
    const user = req.firebaseUser!;
    const ctx = getFirebaseAdminContext();
    const companyId = sanitizeId(String(req.params.companyId || '').trim());
    if (!ctx.db || !ctx.hasExplicitCredentials) {
      res.status(200).json({ ok: true, persistedInFirestore: false });
      return;
    }

    const membership = await verifyCompanyMembershipServer(ctx.db, companyId, user);
    if (!membership || !membership.existsInCloud || !membership.memberRecord) {
      res.status(403).json({ ok: false, error: 'Acesso negado.' });
      return;
    }

    const body = req.body as Partial<CompanyRoleDefinition>;
    const roleId = sanitizeId(String(body.id || `role_custom_${Date.now()}`));
    const name = String(body.name || '').trim().slice(0, 64);
    const baseRole = resolveMemberBaseRole({ role: (body.baseRole || 'cashier') as CompanyRole });
    const permissions = (body.permissions || {}) as Partial<Record<PermissionKey, boolean>>;
    if (!name) {
      res.status(400).json({ ok: false, error: 'Nome da função obrigatório.' });
      return;
    }

    const authz = canActorManageRoleDefinition({
      actor: membership.memberRecord,
      actorPermissions: membership.permissions,
      roleBase: baseRole,
      requestedPermissions: permissions,
    });
    if (!authz.allowed) {
      res.status(403).json({ ok: false, error: authz.reason });
      return;
    }

    const nowIso = new Date().toISOString();
    const compRef = ctx.db.collection('companies').doc(companyId);
    const companyOwnerUid = String(membership.companyData?.ownerUid || user.uid);
    const batch = ctx.db.batch();
    batch.set(
      compRef.collection('roles').doc(roleId),
      {
        id: roleId,
        companyId,
        companyOwnerUid,
        name,
        description: String(body.description || '').slice(0, 200),
        baseRole,
        isSystem: Boolean(body.isSystem),
        permissions,
        updatedAtIso: nowIso,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    const auditRef = compRef.collection('audit_logs').doc(`role_${Date.now()}`);
    batch.set(auditRef, {
      id: auditRef.id,
      companyId,
      actorUid: user.uid,
      actorEmail: (user.email || '').slice(0, 120),
      actorName: membership.memberRecord.displayName.slice(0, 120),
      actorRole: membership.role,
      action: 'ROLE_UPDATE',
      targetType: 'role',
      targetId: roleId,
      summary: `Função "${name}" (${baseRole}) actualizada`,
      outcome: 'allowed',
      createdAtIso: nowIso,
      createdAt: FieldValue.serverTimestamp(),
    });
    await batch.commit();
    res.status(200).json({ ok: true, persistedInFirestore: true, roleId });
  }
);

/**
 * POST /api/companies/:companyId/audit-logs & GET /api/companies/:companyId/audit-logs
 */
companiesRouter.post(
  '/:companyId/audit-logs',
  requireFirebaseAuth,
  async (req: AuthenticatedRequest, res) => {
    const user = req.firebaseUser!;
    const ctx = getFirebaseAdminContext();
    const companyId = sanitizeId(String(req.params.companyId || '').trim());
    if (!ctx.db || !ctx.hasExplicitCredentials) {
      res.status(200).json({ ok: true, persistedInFirestore: false });
      return;
    }

    const membership = await verifyCompanyMembershipServer(ctx.db, companyId, user);
    if (!membership || !membership.existsInCloud) {
      res.status(403).json({ ok: false, error: 'Acesso negado.' });
      return;
    }

    const body = req.body as Record<string, unknown>;
    const logId = sanitizeId(String(body.id || `sec_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`));
    const nowIso = String(body.createdAtIso || new Date().toISOString()).slice(0, 40);
    await ctx.db
      .collection('companies')
      .doc(companyId)
      .collection('audit_logs')
      .doc(logId)
      .set({
        id: logId,
        companyId,
        ...(body.establishmentId ? { establishmentId: sanitizeId(String(body.establishmentId)) } : {}),
        actorUid: user.uid,
        actorEmail: (user.email || '').slice(0, 120),
        actorName: String(body.actorName || user.email || 'Operador').slice(0, 120),
        actorRole: String(body.actorRole || membership.role).slice(0, 64),
        action: String(body.action || 'ACCESS_DENIED').slice(0, 40),
        targetType: String(body.targetType || 'system').slice(0, 40),
        ...(body.targetId ? { targetId: String(body.targetId).slice(0, 128) } : {}),
        summary: String(body.summary || '').slice(0, 300),
        ...(body.beforeJson ? { beforeJson: String(body.beforeJson).slice(0, 1000) } : {}),
        ...(body.afterJson ? { afterJson: String(body.afterJson).slice(0, 1000) } : {}),
        outcome: body.outcome === 'denied' ? 'denied' : 'allowed',
        createdAtIso: nowIso,
        createdAt: FieldValue.serverTimestamp(),
      });

    res.status(200).json({ ok: true, persistedInFirestore: true, id: logId });
  }
);

companiesRouter.get(
  '/:companyId/audit-logs',
  requireFirebaseAuth,
  async (req: AuthenticatedRequest, res) => {
    const user = req.firebaseUser!;
    const ctx = getFirebaseAdminContext();
    const companyId = sanitizeId(String(req.params.companyId || '').trim());
    if (!ctx.db || !ctx.hasExplicitCredentials) {
      res.status(200).json({ ok: true, logs: [] });
      return;
    }

    const membership = await verifyCompanyMembershipServer(ctx.db, companyId, user);
    if (!membership || !membership.existsInCloud || !membership.permissions.audit_view) {
      res.status(403).json({ ok: false, error: 'Sem permissão para consultar auditoria.' });
      return;
    }

    const snap = await ctx.db
      .collection('companies')
      .doc(companyId)
      .collection('audit_logs')
      .orderBy('createdAtIso', 'desc')
      .limit(200)
      .get()
      .catch(() => null);

    res.status(200).json({
      ok: true,
      logs: (snap?.docs || []).map((d) => ({ id: d.id, ...d.data() })),
    });
  }
);
