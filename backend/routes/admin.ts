import { Router } from 'express';
import { FieldValue } from 'firebase-admin/firestore';
import {
  JAIMONA_COMPANY,
  JAIMONA_COMPANY_ID,
  JAIMONA_OWNER_EMAIL,
  normalizeCompanyNif,
  type CompanyOperationalStatus,
  type CompanyRole,
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
 * Lista todas as empresas registadas, métricas consolidadas, planos e auditoria.
 */
adminRouter.get('/overview', async (req: AuthenticatedRequest, res) => {
  const adminUser = req.firebaseUser!;
  const ctx = getFirebaseAdminContext();

  if (!ctx.db || !ctx.hasExplicitCredentials) {
    // Modo de fallback autorizado sem Service Account explícita em dev local
    const fallbackCompanies = [
      {
        id: JAIMONA_COMPANY_ID,
        shortName: JAIMONA_COMPANY.shortName,
        legalName: JAIMONA_COMPANY.legalName,
        nif: JAIMONA_COMPANY.nif,
        normalizedNif: normalizeCompanyNif(JAIMONA_COMPANY.nif),
        cityCountry: JAIMONA_COMPANY.cityCountry,
        ownerEmail: JAIMONA_OWNER_EMAIL,
        status: 'active' as CompanyOperationalStatus,
        planTier: 'PROFISSIONAL' as PlanTier,
        commercialActive: true,
        invoiceCount: 0,
        createdAtIso: '2026-01-01T08:00:00.000Z',
      },
    ];

    res.status(200).json({
      ok: true,
      adminEmail: adminUser.email || '',
      cloudPersisted: false,
      stats: {
        totalCompanies: 1,
        activeCompanies: 1,
        suspendedCompanies: 0,
        totalInvoicesCount: 0,
        totalUsersCount: 1,
        commercialActiveCount: 1,
        baseOrganicCount: 0,
        plansBreakdown: {
          FREE: 0,
          ESSENCIAL: 0,
          PROFISSIONAL: 1,
          ENTERPRISE: 0,
        },
      },
      companies: fallbackCompanies,
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
      ctx.db.collection('platform_audit_logs').orderBy('createdAt', 'desc').limit(50).get().catch(() => null),
    ]);

    let totalInvoices = 0;
    const userEmailsSet = new Set<string>();
    if (adminUser.email) userEmailsSet.add(adminUser.email.toLowerCase());

    const companies = await Promise.all(
      companiesSnap.docs.map(async (docSnap) => {
        const d = docSnap.data();
        let invoiceCount = 0;
        try {
          const countSnap = await docSnap.ref.collection('invoices').count().get();
          invoiceCount = countSnap.data().count;
          totalInvoices += invoiceCount;
        } catch {
          // Fallback silencioso
        }

        const ownerMail = String(
          docSnap.id === JAIMONA_COMPANY_ID
            ? JAIMONA_OWNER_EMAIL
            : d.ownerEmail || d.email || ''
        ).trim().toLowerCase();
        if (ownerMail) userEmailsSet.add(ownerMail);

        const createdTs = d.createdAt?.toDate ? d.createdAt.toDate().toISOString() : '';
        const rawPlan: PlanTier = (
          docSnap.id === JAIMONA_COMPANY_ID && (!d.planTier || d.planTier === 'FREE')
            ? 'PROFISSIONAL'
            : VALID_PLANS.includes(d.planTier)
              ? d.planTier
              : 'FREE'
        ) as PlanTier;

        const isCommercial =
          docSnap.id === JAIMONA_COMPANY_ID
            ? true
            : rawPlan !== 'FREE' && Boolean(d.commercialActive ?? true);

        return {
          id: docSnap.id,
          shortName: String(d.shortName || d.legalName || docSnap.id),
          legalName: String(d.legalName || d.shortName || docSnap.id),
          nif: String(d.nif || d.normalizedNif || ''),
          normalizedNif: String(d.normalizedNif || normalizeCompanyNif(String(d.nif || ''))),
          cityCountry: String(d.cityCountry || 'Angola'),
          ownerEmail: ownerMail || JAIMONA_OWNER_EMAIL,
          status: (VALID_STATUSES.includes(d.status) ? d.status : 'active') as CompanyOperationalStatus,
          planTier: rawPlan,
          commercialActive: isCommercial,
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

    const plansBreakdown = {
      FREE: 0,
      ESSENCIAL: 0,
      PROFISSIONAL: 0,
      ENTERPRISE: 0,
    };
    let activeCompanies = 0;
    let suspendedCompanies = 0;
    let commercialActiveCount = 0;
    let baseOrganicCount = 0;

    for (const c of companies) {
      if (c.status === 'active') activeCompanies++;
      if (c.status === 'suspended') suspendedCompanies++;
      if (c.planTier in plansBreakdown) {
        plansBreakdown[c.planTier]++;
      }
      if (c.planTier === 'FREE') {
        baseOrganicCount++;
      } else if (c.commercialActive) {
        commercialActiveCount++;
      }
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
      stats: {
        totalCompanies: companies.length,
        activeCompanies,
        suspendedCompanies,
        totalInvoicesCount: totalInvoices,
        totalUsersCount: Math.max(userEmailsSet.size, 1),
        commercialActiveCount,
        baseOrganicCount,
        plansBreakdown,
      },
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
 * GET /api/admin/companies/:companyId/details
 * Devolve perfil administrativo aprofundado para inspeção governamental.
 */
adminRouter.get('/companies/:companyId/details', async (req: AuthenticatedRequest, res) => {
  const ctx = getFirebaseAdminContext();
  const companyId = sanitizeId(req.params.companyId || '');

  if (!companyId) {
    res.status(400).json({ ok: false, error: 'Identificador da empresa inválido.' });
    return;
  }

  if (!ctx.db || !ctx.hasExplicitCredentials) {
    res.status(200).json({
      ok: true,
      company: {
        id: companyId,
        legalName: companyId === JAIMONA_COMPANY_ID ? JAIMONA_COMPANY.legalName : 'Empresa Local',
        shortName: companyId === JAIMONA_COMPANY_ID ? JAIMONA_COMPANY.shortName : companyId,
        nif: companyId === JAIMONA_COMPANY_ID ? JAIMONA_COMPANY.nif : '5000000000',
        normalizedNif: normalizeCompanyNif(companyId === JAIMONA_COMPANY_ID ? JAIMONA_COMPANY.nif : '5000000000'),
        cityCountry: 'Angola',
        address: companyId === JAIMONA_COMPANY_ID ? JAIMONA_COMPANY.address : 'Luanda, Angola',
        phone: companyId === JAIMONA_COMPANY_ID ? JAIMONA_COMPANY.phone : '+244 923 000 000',
        email: companyId === JAIMONA_COMPANY_ID ? JAIMONA_COMPANY.email : JAIMONA_OWNER_EMAIL,
        status: 'active' as CompanyOperationalStatus,
        planTier: (companyId === JAIMONA_COMPANY_ID ? 'PROFISSIONAL' : 'FREE') as PlanTier,
        commercialActive: true,
        baseSequence: 1,
        allowManagerCancel: false,
        createdAtIso: '2026-01-01T08:00:00.000Z',
        updatedAtIso: new Date().toISOString(),
      },
      counts: {
        invoices: 0,
        products: 0,
        customers: 0,
        cashSessions: 0,
      },
      members: [
        {
          uid: 'owner',
          email: JAIMONA_OWNER_EMAIL,
          role: 'owner' as CompanyRole,
          active: true,
          addedAtIso: '2026-01-01T08:00:00.000Z',
        },
      ],
      auditHistory: [],
    });
    return;
  }

  try {
    const compRef = ctx.db.collection('companies').doc(companyId);
    const compSnap = await compRef.get();

    if (!compSnap.exists && companyId !== JAIMONA_COMPANY_ID) {
      res.status(404).json({ ok: false, error: 'Empresa não encontrada no repositório cloud.' });
      return;
    }

    const d = compSnap.data() || {};
    const [invCountSnap, prodCountSnap, custCountSnap, cashCountSnap, membersSnap, auditSnap] =
      await Promise.all([
        compRef.collection('invoices').count().get().catch(() => null),
        compRef.collection('products').count().get().catch(() => null),
        compRef.collection('customers').count().get().catch(() => null),
        compRef.collection('cash_sessions').count().get().catch(() => null),
        compRef.collection('members').limit(50).get().catch(() => null),
        ctx.db.collection('platform_audit_logs').where('companyId', '==', companyId).orderBy('createdAt', 'desc').limit(15).get().catch(() => null),
      ]);

    const members = (membersSnap?.docs || []).map((m) => {
      const md = m.data();
      return {
        uid: m.id,
        email: String(md.email || md.emailLower || ''),
        role: (md.role || 'cashier') as CompanyRole,
        active: md.active !== false,
        allowInvoiceCancel: Boolean(md.allowInvoiceCancel),
        addedAtIso: md.createdAt?.toDate ? md.createdAt.toDate().toISOString() : '',
      };
    });

    const auditHistory = (auditSnap?.docs || []).map((l) => {
      const ld = l.data();
      return {
        id: l.id,
        action: String(ld.action || ''),
        adminEmail: String(ld.adminEmail || ''),
        details: String(ld.details || ''),
        createdAtIso: ld.createdAt?.toDate ? ld.createdAt.toDate().toISOString() : '',
      };
    });

    res.status(200).json({
      ok: true,
      company: {
        id: compSnap.id,
        legalName: String(d.legalName || d.shortName || compSnap.id),
        shortName: String(d.shortName || d.legalName || compSnap.id),
        nif: String(d.nif || d.normalizedNif || ''),
        normalizedNif: String(d.normalizedNif || normalizeCompanyNif(String(d.nif || ''))),
        cityCountry: String(d.cityCountry || 'Angola'),
        address: String(d.address || ''),
        phone: String(d.phone || ''),
        email: String(d.email || d.ownerEmail || ''),
        status: (VALID_STATUSES.includes(d.status) ? d.status : 'active') as CompanyOperationalStatus,
        planTier: (VALID_PLANS.includes(d.planTier) ? d.planTier : 'FREE') as PlanTier,
        commercialActive: Boolean(d.commercialActive ?? (d.planTier && d.planTier !== 'FREE')),
        baseSequence: Number(d.baseSequence || 1),
        allowManagerCancel: Boolean(d.allowManagerCancel),
        createdAtIso: d.createdAt?.toDate ? d.createdAt.toDate().toISOString() : '',
        updatedAtIso: d.updatedAt?.toDate ? d.updatedAt.toDate().toISOString() : '',
      },
      counts: {
        invoices: invCountSnap?.data()?.count || 0,
        products: prodCountSnap?.data()?.count || 0,
        customers: custCountSnap?.data()?.count || 0,
        cashSessions: cashCountSnap?.data()?.count || 0,
      },
      members,
      auditHistory,
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : 'Erro ao consultar detalhes da empresa.',
    });
  }
});

/**
 * POST /api/admin/companies
 * Registo administrativo de nova empresa na plataforma pelo Master.
 */
adminRouter.post('/companies', async (req: AuthenticatedRequest, res) => {
  const adminUser = req.firebaseUser!;
  const ctx = getFirebaseAdminContext();

  const body = req.body as {
    shortName?: string;
    legalName?: string;
    nif?: string;
    cityCountry?: string;
    ownerEmail?: string;
    planTier?: PlanTier;
    status?: CompanyOperationalStatus;
  };

  const shortName = String(body?.shortName || '').trim().slice(0, 80);
  const legalName = String(body?.legalName || shortName).trim().slice(0, 140);
  const rawNif = String(body?.nif || '').trim();
  const normalizedNif = normalizeCompanyNif(rawNif);
  const cityCountry = String(body?.cityCountry || 'Angola').trim().slice(0, 60);
  const ownerEmail = String(body?.ownerEmail || adminUser.email || '').trim().toLowerCase().slice(0, 120);
  const planTier = body?.planTier && VALID_PLANS.includes(body.planTier) ? body.planTier : 'FREE';
  const status = body?.status && VALID_STATUSES.includes(body.status) ? body.status : 'active';

  if (!shortName || !normalizedNif || !ownerEmail) {
    res.status(400).json({
      ok: false,
      error: 'Preencha obrigatoriamente Nome Curto, NIF válido e E-mail do proprietário.',
    });
    return;
  }

  const generatedId = `comp_${normalizedNif.toLowerCase().replace(/[^a-z0-9]/g, '')}_${Date.now().toString(36)}`;

  if (!ctx.db || !ctx.hasExplicitCredentials) {
    res.status(200).json({
      ok: true,
      persistedInFirestore: false,
      companyId: generatedId,
      message: 'Empresa registada com sucesso no ambiente local.',
    });
    return;
  }

  try {
    const compRef = ctx.db.collection('companies').doc(generatedId);
    await compRef.set({
      id: generatedId,
      shortName,
      legalName,
      nif: rawNif,
      normalizedNif,
      cityCountry,
      ownerEmail,
      ownerUid: adminUser.uid,
      planTier,
      status,
      commercialActive: planTier !== 'FREE',
      baseSequence: 1,
      allowManagerCancel: false,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    await ctx.db.collection('platform_audit_logs').add({
      adminUid: adminUser.uid,
      adminEmail: (adminUser.email || '').slice(0, 120),
      companyId: generatedId,
      companyName: shortName,
      action: 'ADMIN_COMPANY_CREATE',
      details: `Nova empresa registada: ${shortName} (NIF: ${rawNif}, Plano: ${planTier})`,
      createdAt: FieldValue.serverTimestamp(),
    });

    res.status(201).json({
      ok: true,
      persistedInFirestore: true,
      companyId: generatedId,
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : 'Erro ao criar empresa.',
    });
  }
});

/**
 * GET /api/admin/users
 * Diretório global consolidado de utilizadores da plataforma.
 */
adminRouter.get('/users', async (req: AuthenticatedRequest, res) => {
  const adminUser = req.firebaseUser!;
  const ctx = getFirebaseAdminContext();

  if (!ctx.db || !ctx.hasExplicitCredentials) {
    res.status(200).json({
      ok: true,
      users: [
        {
          uid: adminUser.uid,
          email: adminUser.email || '',
          emailVerified: true,
          isPlatformAdmin: true,
          companies: [
            {
              companyId: JAIMONA_COMPANY_ID,
              companyName: JAIMONA_COMPANY.shortName,
              role: 'owner' as CompanyRole,
              active: true,
            },
          ],
        },
      ],
    });
    return;
  }

  try {
    const [adminsSnap, companiesSnap] = await Promise.all([
      ctx.db.collection('platform_admins').get(),
      ctx.db.collection('companies').limit(100).get(),
    ]);

    interface UserDirectoryEntry {
      uid: string;
      email: string;
      isPlatformAdmin: boolean;
      companies: Array<{ companyId: string; companyName: string; role: CompanyRole; active: boolean }>;
    }

    const adminUids = new Set(adminsSnap.docs.map((d) => d.id));
    const userMap = new Map<string, UserDirectoryEntry>();

    // Adiciona o admin atual
    userMap.set(adminUser.uid, {
      uid: adminUser.uid,
      email: adminUser.email || '',
      isPlatformAdmin: true,
      companies: [],
    });

    for (const compDoc of companiesSnap.docs) {
      const cd = compDoc.data();
      const compId = compDoc.id;
      const compName = String(cd.shortName || cd.legalName || compId);

      // Regista proprietário
      if (cd.ownerUid && cd.ownerEmail) {
        const existing: UserDirectoryEntry = userMap.get(cd.ownerUid) || {
          uid: cd.ownerUid,
          email: String(cd.ownerEmail),
          isPlatformAdmin: adminUids.has(cd.ownerUid),
          companies: [],
        };
        existing.companies.push({
          companyId: compId,
          companyName: compName,
          role: 'owner',
          active: true,
        });
        userMap.set(cd.ownerUid, existing);
      }

      // Membros da subcoleção
      try {
        const membersSnap = await compDoc.ref.collection('members').limit(20).get();
        for (const mDoc of membersSnap.docs) {
          const md = mDoc.data();
          const email = String(md.email || md.emailLower || '');
          const existing: UserDirectoryEntry = userMap.get(mDoc.id) || {
            uid: mDoc.id,
            email,
            isPlatformAdmin: adminUids.has(mDoc.id),
            companies: [],
          };
          existing.companies.push({
            companyId: compId,
            companyName: compName,
            role: (md.role || 'cashier') as CompanyRole,
            active: md.active !== false,
          });
          userMap.set(mDoc.id, existing);
        }
      } catch {
        // Fallback silencioso
      }
    }

    res.status(200).json({
      ok: true,
      users: Array.from(userMap.values()),
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : 'Erro ao obter directório de utilizadores.',
    });
  }
});

/**
 * GET /api/admin/system-status
 * Telemetria e diagnóstico do ambiente em tempo real.
 */
adminRouter.get('/system-status', async (_req: AuthenticatedRequest, res) => {
  const ctx = getFirebaseAdminContext();
  const mem = process.memoryUsage();

  res.status(200).json({
    ok: true,
    telemetry: {
      uptimeSeconds: Math.floor(process.uptime()),
      nodeVersion: process.version,
      memory: {
        rssMb: Math.round(mem.rss / 1024 / 1024),
        heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
        heapTotalMb: Math.round(mem.heapTotal / 1024 / 1024),
      },
      environment: process.env.NODE_ENV || 'development',
      port: Number(process.env.PORT) || 3000,
    },
    firestore: {
      initialized: Boolean(ctx.app),
      databaseId: ctx.databaseId,
      hasExplicitCredentials: ctx.hasExplicitCredentials,
      credentialSource: ctx.credentialSource,
    },
    services: {
      backendApi: 'operational',
      cryptoEngine: 'ready',
      agtFiscalValidator: 'ready',
    },
    timestampIso: new Date().toISOString(),
  });
});

/**
 * PATCH /api/admin/companies/:companyId
 * Ativa/suspende empresa ou altera plano comercial com auditoria estrita.
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
      commercialActive: nextPlan ? nextPlan !== 'FREE' : undefined,
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
            : `Plano comercial alterado para ${nextPlan} (${nextPlan === 'FREE' ? 'Base Orgânico' : 'Comercial Ativo'})`)
      ).slice(0, 240),
      createdAt: FieldValue.serverTimestamp(),
    });

    res.status(200).json({
      ok: true,
      persistedInFirestore: true,
      companyId,
      status: nextStatus,
      planTier: nextPlan,
      commercialActive: nextPlan ? nextPlan !== 'FREE' : undefined,
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

