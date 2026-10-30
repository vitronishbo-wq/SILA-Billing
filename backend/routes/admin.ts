import { Router } from 'express';
import { FieldValue } from 'firebase-admin/firestore';
import {
  JAIMONA_COMPANY,
  JAIMONA_COMPANY_ID,
  JAIMONA_OWNER_EMAIL,
  normalizeCompanyNif,
  type CompanyOperationalStatus,
  type PlanTier,
} from '../../src/core/types.ts';
import { getFirebaseAdminContext } from '../firebaseAdmin.ts';
import { requireFirebaseAuth, type AuthenticatedRequest } from '../middleware/requireFirebaseAuth.ts';
import { requirePlatformAdmin } from '../middleware/requirePlatformAdmin.ts';

export const adminRouter = Router();

adminRouter.use(requireFirebaseAuth, requirePlatformAdmin);

const VALID_PLANS: PlanTier[] = ['FREE', 'ESSENCIAL', 'PROFISSIONAL', 'ENTERPRISE'];
const VALID_STATUSES: CompanyOperationalStatus[] = ['active', 'suspended', 'pending'];

function sanitizeId(raw: string): string {
  return String(raw || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128);
}

/**
 * GET /api/admin/overview
 * Lista todas as empresas registadas na plataforma SILA-Billing, planos preparados,
 * estados operacionais e últimos registos de auditoria administrativa.
 */
adminRouter.get('/overview', async (req: AuthenticatedRequest, res) => {
  const adminUser = req.firebaseUser!;
  const ctx = getFirebaseAdminContext();

  if (!ctx.db || !ctx.hasExplicitCredentials) {
    // Mesmo sem Service Account explícita em dev local, devolve resposta autorizada
    // permitindo ao Painel Master gerir e inspecionar empresas com segurança real.
    res.status(200).json({
      ok: true,
      adminEmail: adminUser.email || '',
      cloudPersisted: false,
      companies: [
        {
          id: JAIMONA_COMPANY_ID,
          shortName: JAIMONA_COMPANY.shortName,
          legalName: JAIMONA_COMPANY.legalName,
          nif: JAIMONA_COMPANY.nif,
          normalizedNif: normalizeCompanyNif(JAIMONA_COMPANY.nif),
          cityCountry: JAIMONA_COMPANY.cityCountry,
          ownerEmail: JAIMONA_OWNER_EMAIL,
          status: 'active',
          planTier: 'PROFISSIONAL',
          commercialActive: true,
          invoiceCount: 0,
          createdAtIso: '2026-01-01T08:00:00.000Z',
        },
      ],
      recentLogs: [],
    });
    return;
  }

  try {
    // Regista/atualiza documento do administrador global na coleção platform_admins
    await ctx.db
      .collection('platform_admins')
      .doc(adminUser.uid)
      .set(
        {
          uid: adminUser.uid,
          email: (adminUser.email || '').slice(0, 120),
          active: true,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

    const [companiesSnap, logsSnap] = await Promise.all([
      ctx.db.collection('companies').limit(200).get(),
      ctx.db.collection('platform_audit_logs').orderBy('createdAt', 'desc').limit(25).get().catch(() => null),
    ]);

    const companies = await Promise.all(
      companiesSnap.docs.map(async (docSnap) => {
        const d = docSnap.data();
        let invoiceCount = 0;
        try {
          const countSnap = await docSnap.ref.collection('invoices').count().get();
          invoiceCount = countSnap.data().count;
        } catch {
          // Fallback silencioso
        }

        const createdTs = d.createdAt?.toDate ? d.createdAt.toDate().toISOString() : '';

        return {
          id: docSnap.id,
          shortName: String(d.shortName || d.legalName || docSnap.id),
          legalName: String(d.legalName || d.shortName || docSnap.id),
          nif: String(d.nif || d.normalizedNif || ''),
          normalizedNif: String(d.normalizedNif || normalizeCompanyNif(String(d.nif || ''))),
          cityCountry: String(d.cityCountry || 'Angola'),
          ownerEmail:
            docSnap.id === JAIMONA_COMPANY_ID
              ? JAIMONA_OWNER_EMAIL
              : String(d.ownerEmail || d.email || ''),
          status: (VALID_STATUSES.includes(d.status) ? d.status : 'active') as CompanyOperationalStatus,
          planTier: (
            docSnap.id === JAIMONA_COMPANY_ID && (!d.planTier || d.planTier === 'FREE')
              ? 'PROFISSIONAL'
              : VALID_PLANS.includes(d.planTier)
                ? d.planTier
                : 'FREE'
          ) as PlanTier,
          commercialActive:
            docSnap.id === JAIMONA_COMPANY_ID
              ? true
              : Boolean(d.commercialActive ?? (d.planTier && d.planTier !== 'FREE')),
          invoiceCount,
          createdAtIso: createdTs || new Date().toISOString(),
        };
      })
    );

    if (!companies.some((c) => c.id === JAIMONA_COMPANY_ID)) {
      companies.push({
        id: JAIMONA_COMPANY_ID,
        shortName: JAIMONA_COMPANY.shortName,
        legalName: JAIMONA_COMPANY.legalName,
        nif: JAIMONA_COMPANY.nif,
        normalizedNif: normalizeCompanyNif(JAIMONA_COMPANY.nif),
        cityCountry: JAIMONA_COMPANY.cityCountry,
        ownerEmail: JAIMONA_OWNER_EMAIL,
        status: 'active',
        planTier: 'PROFISSIONAL',
        commercialActive: true,
        invoiceCount: 0,
        createdAtIso: '2026-01-01T08:00:00.000Z',
      });
    }

    const recentLogs = (logsSnap?.docs || []).map((l) => {
      const ld = l.data();
      return {
        id: l.id,
        action: String(ld.action || ''),
        companyId: String(ld.companyId || ''),
        companyName: String(ld.companyName || ''),
        adminEmail: String(ld.adminEmail || ''),
        details: String(ld.details || ''),
        createdAtIso: ld.createdAt?.toDate ? ld.createdAt.toDate().toISOString() : new Date().toISOString(),
      };
    });

    res.status(200).json({
      ok: true,
      adminEmail: adminUser.email || '',
      cloudPersisted: true,
      companies,
      recentLogs,
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : 'Erro ao consultar visão global de empresas.',
    });
  }
});

/**
 * PATCH /api/admin/companies/:companyId
 * Ativa/suspende empresa (sem apagar dados) ou atribui plano comercial preparado (inativo).
 */
adminRouter.patch('/companies/:companyId', async (req: AuthenticatedRequest, res) => {
  const adminUser = req.firebaseUser!;
  const ctx = getFirebaseAdminContext();
  const companyId = sanitizeId(req.params.companyId || '');

  if (!companyId) {
    res.status(400).json({ ok: false, error: 'Identificador da empresa inválido.' });
    return;
  }

  const body = req.body as {
    status?: CompanyOperationalStatus;
    planTier?: PlanTier;
    reason?: string;
  };

  const nextStatus = body?.status && VALID_STATUSES.includes(body.status) ? body.status : undefined;
  const nextPlan = body?.planTier && VALID_PLANS.includes(body.planTier) ? body.planTier : undefined;

  if (!nextStatus && !nextPlan) {
    res.status(400).json({
      ok: false,
      error: 'Informe um estado operacional (active/suspended) ou plano comercial válido.',
    });
    return;
  }

  if (!ctx.db || !ctx.hasExplicitCredentials) {
    res.status(200).json({
      ok: true,
      persistedInFirestore: false,
      companyId,
      status: nextStatus,
      planTier: nextPlan,
    });
    return;
  }

  try {
    const compRef = ctx.db.collection('companies').doc(companyId);
    const compSnap = await compRef.get();

    const updates: Record<string, unknown> = {
      updatedAt: FieldValue.serverTimestamp(),
    };
    if (nextStatus) updates.status = nextStatus;
    if (nextPlan) {
      updates.planTier = nextPlan;
      updates.commercialActive = nextPlan !== 'FREE';
    }

    if (compSnap.exists) {
      await compRef.update(updates);
    } else if (companyId === JAIMONA_COMPANY_ID) {
      const resolvedJaimonaPlan: PlanTier =
        nextPlan && nextPlan !== 'FREE' ? nextPlan : 'PROFISSIONAL';
      await compRef.set(
        {
          id: JAIMONA_COMPANY_ID,
          normalizedNif: normalizeCompanyNif(JAIMONA_COMPANY.nif),
          ownerUid: adminUser.uid,
          ownerEmail: JAIMONA_OWNER_EMAIL,
          legalName: JAIMONA_COMPANY.legalName,
          shortName: JAIMONA_COMPANY.shortName,
          nif: JAIMONA_COMPANY.nif,
          address: JAIMONA_COMPANY.address,
          cityCountry: JAIMONA_COMPANY.cityCountry,
          phone: JAIMONA_COMPANY.phone,
          email: JAIMONA_COMPANY.email,
          tagline: JAIMONA_COMPANY.tagline,
          status: nextStatus || 'active',
          planTier: resolvedJaimonaPlan,
          commercialActive: true,
          baseSequence: 15678,
          allowManagerCancel: false,
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }

    const companyName = String(
      compSnap.data()?.shortName ||
        (companyId === JAIMONA_COMPANY_ID ? JAIMONA_COMPANY.shortName : companyId)
    );

    await ctx.db.collection('platform_audit_logs').add({
      adminUid: adminUser.uid,
      adminEmail: (adminUser.email || '').slice(0, 120),
      companyId,
      companyName: companyName.slice(0, 80),
      action: nextStatus ? `COMPANY_STATUS_${nextStatus.toUpperCase()}` : `PLAN_SET_${nextPlan}`,
      details: String(
        body?.reason ||
          (nextStatus
            ? `Estado operacional alterado para ${nextStatus}`
            : `Plano comercial VITRONIS definido como ${nextPlan}`)
      ).slice(0, 240),
      createdAt: FieldValue.serverTimestamp(),
    });

    res.status(200).json({
      ok: true,
      persistedInFirestore: true,
      companyId,
      status: nextStatus,
      planTier: nextPlan,
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : 'Erro ao atualizar empresa no Painel Master.',
    });
  }
});

/**
 * POST /api/admin/support-access
 * Regista entrada auditada de suporte administrativo no contexto de uma empresa.
 */
adminRouter.post('/support-access', async (req: AuthenticatedRequest, res) => {
  const adminUser = req.firebaseUser!;
  const ctx = getFirebaseAdminContext();
  const body = req.body as { companyId?: string; companyName?: string };
  const rawCompanyId = String(body?.companyId || '').trim();
  if (!rawCompanyId) {
    res.status(400).json({ ok: false, error: 'Identificador da empresa (companyId) é obrigatório.' });
    return;
  }
  const companyId = sanitizeId(rawCompanyId);
  const companyName = String(body?.companyName || companyId).slice(0, 80);

  if (ctx.db && ctx.hasExplicitCredentials) {
    try {
      await ctx.db.collection('platform_audit_logs').add({
        adminUid: adminUser.uid,
        adminEmail: (adminUser.email || '').slice(0, 120),
        companyId,
        companyName,
        action: 'SUPPORT_CONTEXT_ENTER',
        details: `Acesso de suporte técnico à empresa ${companyName}`,
        createdAt: FieldValue.serverTimestamp(),
      });
    } catch {
      // Não bloqueia abertura local
    }
  }

  res.status(200).json({ ok: true, companyId });
});
