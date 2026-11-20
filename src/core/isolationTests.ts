/**
 * Suite de Testes de Isolamento e Segurança Multiempresa (Etapa 3)
 *
 * Valida:
 * 1. Isolamento estrito de permissões (Utilizador Comum vs. Platform Admin)
 * 2. Validação obrigatória de e-mail verificado (anti-spoofing)
 * 3. Middleware requirePlatformAdmin (rejeição 403 com mensagem padronizada)
 * 4. Isolamento estrito entre empresas (Tenant Isolation - Tenant A não acede a Tenant B)
 * 5. Papéis de utilizador e permissões de cancelamento (Cashier vs Manager vs Owner)
 * 6. Preservação e proteção da empresa âncora VITRONIS (comp_jaimona)
 */

import type { DecodedIdToken } from 'firebase-admin/auth';
import {
  checkIsPlatformAdmin,
  requirePlatformAdmin,
  verifyCompanyMembershipServer,
} from '../../backend/middleware/requirePlatformAdmin.ts';
import {
  canCompanyInviteCloudMembers,
  canCompanyManageMultiOperatorTeam,
  canCompanySyncCloudData,
  CompanyMember,
  CompanyRecord,
  isJaimonaOwnerEmail,
  JAIMONA_COMPANY,
  JAIMONA_COMPANY_ID,
  PLATFORM_ADMIN_EMAIL,
} from './types.ts';
import {
  buildDefaultCompanyRoles,
  canActorManageRoleDefinition,
  canActorManageTargetMember,
  canMemberAccessEstablishment,
  canMemberOperateCashier,
  computeProgressiveLockout,
  hashMemberPin,
  isPinCurrentlyLocked,
  normalizeLegacyMember,
  resolveMemberPermissions,
  validatePinFormat,
  verifyMemberPinHash,
} from './rbac.ts';

function assert(condition: boolean, msg: string): void {
  if (!condition) {
    throw new Error(`[FALHA DE ISOLAMENTO]: ${msg}`);
  }
}

export async function runIsolationTests(): Promise<{ passed: number; total: number }> {
  let passed = 0;
  let total = 0;

  async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    total++;
    try {
      await fn();
      passed++;
      console.log(`✓ [PASS] ${name}`);
    } catch (err) {
      console.error(`✗ [FAIL] ${name}:`, err);
      throw err;
    }
  }

  console.log('\n--- INICIANDO TESTES DE ISOLAMENTO DE PERMISSÕES & SEGURANÇA ---');

  // Teste 1: Utilizador comum autenticado com email verificado NÃO é platform admin
  await test('Utilizador comum (cashier/manager) não tem privilégios de Platform Admin', async () => {
    const regularUser: DecodedIdToken = {
      uid: 'user_regular_123',
      email: 'operador@empresa-x.co.ao',
      email_verified: true,
      auth_time: 1700000000,
      iat: 1700000000,
      exp: 1700003600,
      aud: 'sila-billing-app',
      iss: 'https://securetoken.google.com/sila-billing-app',
      sub: 'user_regular_123',
      firebase: { identities: {}, sign_in_provider: 'password' },
    };

    const isAdmin = await checkIsPlatformAdmin(regularUser, null);
    assert(isAdmin === false, 'Utilizador comum não deve ter privilégios de plataforma');
  });

  // Teste 2: Proteção Anti-Spoofing - Email de admin SEM email_verified = false é REJEITADO
  await test('Admin com e-mail não verificado é sumariamente bloqueado (Anti-Spoofing)', async () => {
    const unverifiedAdminUser: DecodedIdToken = {
      uid: 'fake_admin_999',
      email: PLATFORM_ADMIN_EMAIL,
      email_verified: false, // E-mail não validado
      auth_time: 1700000000,
      iat: 1700000000,
      exp: 1700003600,
      aud: 'sila-billing-app',
      iss: 'https://securetoken.google.com/sila-billing-app',
      sub: 'fake_admin_999',
      firebase: { identities: {}, sign_in_provider: 'password' },
    };

    const isAdmin = await checkIsPlatformAdmin(unverifiedAdminUser, null);
    assert(isAdmin === false, 'Tentativa de personificação sem e-mail verificado deve ser rejeitada');
  });

  // Teste 3: Platform Admin oficial autenticado e verificado é reconhecido
  await test('Super-Admin oficial verificado (wtmedia0@gmail.com) tem acesso de plataforma autorizado', async () => {
    const legitimateAdmin: DecodedIdToken = {
      uid: 'admin_root_1',
      email: PLATFORM_ADMIN_EMAIL,
      email_verified: true,
      auth_time: 1700000000,
      iat: 1700000000,
      exp: 1700003600,
      aud: 'sila-billing-app',
      iss: 'https://securetoken.google.com/sila-billing-app',
      sub: 'admin_root_1',
      firebase: { identities: {}, sign_in_provider: 'password' },
    };

    const isAdmin = await checkIsPlatformAdmin(legitimateAdmin, null);
    assert(isAdmin === true, 'Admin oficial verificado deve ter acesso autorizado');
  });

  // Teste 4: Middleware requirePlatformAdmin bloqueia utilizador comum com 403 Forbidden
  await test('Middleware requirePlatformAdmin responde 403 Forbidden para utilizadores comuns', async () => {
    let capturedStatus: number | null = null;
    let capturedBody: any = null;
    let nextCalled: boolean = false;

    const mockReq: any = {
      firebaseUser: {
        uid: 'user_regular_456',
        email: 'gestor@comercial.ao',
        email_verified: true,
      },
    };

    const mockRes: any = {
      status(code: number) {
        capturedStatus = code;
        return {
          json(data: any) {
            capturedBody = data;
          },
        };
      },
    };

    const mockNext = () => {
      nextCalled = true;
    };

    await requirePlatformAdmin(mockReq, mockRes, mockNext);

    assert(!nextCalled, 'next() não pode ser chamado para não-admins');
    assert(capturedStatus === 403, `Status HTTP esperado 403, obtido ${capturedStatus}`);
    assert(
      capturedBody?.error?.includes('Acesso restrito exclusivamente'),
      'Mensagem deve indicar restrição à administração global'
    );
  });

  // Teste 5: Middleware requirePlatformAdmin permite passagem a Super-Admin verificado
  await test('Middleware requirePlatformAdmin invoca next() para Super-Admin verificado', async () => {
    let capturedStatus: number | null = null;
    let nextCalled: boolean = false;

    const mockReq: any = {
      firebaseUser: {
        uid: 'admin_root_1',
        email: PLATFORM_ADMIN_EMAIL,
        email_verified: true,
      },
    };

    const mockRes: any = {
      status(code: number) {
        capturedStatus = code;
        return { json: () => {} };
      },
    };

    const mockNext = () => {
      nextCalled = true;
    };

    await requirePlatformAdmin(mockReq, mockRes, mockNext);

    assert(Boolean(nextCalled), 'next() DEVE ser invocado para Super-Admin válido');
    assert(capturedStatus === null, 'Nenhum erro HTTP deve ser emitido para Super-Admin');
  });

  // Teste 6: Isolamento estrito entre empresas (Tenant A não acede a Tenant B)
  await test('Isolamento Multi-Tenant: Utilizador da Empresa A não acede a dados da Empresa B', async () => {
    // Simulação do Firestore em memória para validação de segurança
    const mockCompanies: Record<string, any> = {
      empresa_alfa: {
        ownerUid: 'uid_proprietario_alfa',
        status: 'active',
        name: 'Alfa Lda',
        members: {
          uid_funcionario_alfa: { role: 'cashier', active: true },
        },
      },
      empresa_beta: {
        ownerUid: 'uid_proprietario_beta',
        status: 'active',
        name: 'Beta S.A.',
        members: {
          uid_gerente_beta: { role: 'manager', active: true, allowInvoiceCancel: true },
        },
      },
    };

    const createMockDb = (data: typeof mockCompanies) => {
      return {
        collection(collName: string) {
          if (collName !== 'companies') {
            return {
              doc: () => ({ get: async () => ({ exists: false, data: () => null }) }),
            };
          }
          return {
            doc(companyId: string) {
              const comp = data[companyId];
              return {
                get: async () => ({
                  exists: Boolean(comp),
                  data: () => comp || null,
                }),
                collection(subColl: string) {
                  return {
                    get: async () => ({ docs: [] }),
                    doc(memberUid: string) {
                      const member = comp?.members?.[memberUid];
                      return {
                        get: async () => ({
                          exists: Boolean(member),
                          data: () => member || null,
                        }),
                      };
                    },
                    where() {
                      return {
                        limit() {
                          return {
                            get: async () => ({ empty: true, docs: [] }),
                          };
                        },
                      };
                    },
                  };
                },
              };
            },
          };
        },
      } as any;
    };

    const db = createMockDb(mockCompanies);

    const userAlfa: DecodedIdToken = {
      uid: 'uid_funcionario_alfa',
      email: 'operador@alfa.ao',
      email_verified: true,
      auth_time: 1700000000,
      iat: 1700000000,
      exp: 1700003600,
      aud: 'sila-billing-app',
      iss: 'https://securetoken.google.com',
      sub: 'uid_funcionario_alfa',
      firebase: { identities: {}, sign_in_provider: 'password' },
    };

    // 6.1: Acesso de Alfa à própria Empresa Alfa -> Deve ter sucesso com papel 'cashier'
    const acessoPropria = await verifyCompanyMembershipServer(db, 'empresa_alfa', userAlfa);
    assert(acessoPropria !== null, 'Membro deve aceder à sua própria empresa');
    assert(acessoPropria?.role === 'cashier', 'Papel na própria empresa deve ser cashier');
    assert(acessoPropria?.allowCancel === false, 'Operador de caixa comum não deve poder anular faturas');

    // 6.2: Tentativa de Alfa aceder à Empresa Beta -> Deve ser SUMARIAMENTE NEGADO (retorna null)
    const invasaoBeta = await verifyCompanyMembershipServer(db, 'empresa_beta', userAlfa);
    assert(
      invasaoBeta === null,
      'VIOLAÇÃO CRÍTICA EVITADA: Membro da Empresa Alfa NÃO PODE aceder à Empresa Beta'
    );
  });

  // Teste 7: Papel de Gerente com permissão de anulação vs. sem permissão
  await test('Controlo RBAC: Manager com allowInvoiceCancel pode anular; sem permissão é bloqueado', async () => {
    const mockDb = {
      collection: (coll: string) => ({
        doc: (id: string) => ({
          get: async () => ({
            exists: true,
            data: () => ({ ownerUid: 'outro_owner', status: 'active', allowManagerCancel: false }),
          }),
          collection: () => ({
            get: async () => ({ docs: [] }),
            doc: (uid: string) => ({
              get: async () => ({
                exists: true,
                data: () =>
                  uid === 'gerente_autorizado'
                    ? { role: 'manager', active: true, allowInvoiceCancel: true }
                    : { role: 'manager', active: true, allowInvoiceCancel: false },
              }),
            }),
            where: () => ({ limit: () => ({ get: async () => ({ empty: true, docs: [] }) }) }),
          }),
        }),
      }),
    } as any;

    const userAutorizado: DecodedIdToken = {
      uid: 'gerente_autorizado',
      email: 'gerente1@loja.ao',
      email_verified: true,
      auth_time: 1700000000,
      iat: 1700000000,
      exp: 1700003600,
      aud: 'sila-billing-app',
      iss: 'https://securetoken.google.com',
      sub: 'gerente_autorizado',
      firebase: { identities: {}, sign_in_provider: 'password' },
    };

    const userNaoAutorizado: DecodedIdToken = {
      uid: 'gerente_bloqueado',
      email: 'gerente2@loja.ao',
      email_verified: true,
      auth_time: 1700000000,
      iat: 1700000000,
      exp: 1700003600,
      aud: 'sila-billing-app',
      iss: 'https://securetoken.google.com',
      sub: 'gerente_bloqueado',
      firebase: { identities: {}, sign_in_provider: 'password' },
    };

    const resAutorizado = await verifyCompanyMembershipServer(mockDb, 'loja_x', userAutorizado);
    assert(resAutorizado?.allowCancel === true, 'Gerente com flag explícita deve poder anular');

    const resNaoAutorizado = await verifyCompanyMembershipServer(mockDb, 'loja_x', userNaoAutorizado);
    assert(resNaoAutorizado?.allowCancel === false, 'Gerente sem flag explícita não pode anular');
  });

  // Teste 8: Empresa Âncora VITRONIS / JAIMONA (comp_jaimona) protegida
  await test('Empresa Âncora VITRONIS / JAIMONA (comp_jaimona) possui identificadores e titulares protegidos', () => {
    assert(JAIMONA_COMPANY_ID === 'comp_jaimona', 'ID da empresa âncora deve ser comp_jaimona');
    assert(isJaimonaOwnerEmail('jaimonacomercioeservicos@gmail.com') === true, 'jaimonacomercioeservicos@gmail.com é titular reconhecido da Jaimona');
    assert(isJaimonaOwnerEmail('hacker@externo.com') === false, 'Utilizador estranho não é titular da Jaimona');
    assert(PLATFORM_ADMIN_EMAIL === 'wtmedia0@gmail.com', 'wtmedia0@gmail.com é o Super-Admin da plataforma SILA');
  });

  // =========================================================================
  // FASE 6: RBAC, TERMINAL BLOQUEADO, PBKDF2 PIN, ISOLAMENTO & ANTI-ESCALADA
  // =========================================================================

  // Teste 9: PIN PBKDF2-SHA256 com salt aleatório único e validação estrita de formato
  await test('RBAC 6.1: PIN PBKDF2-SHA256 gera salt único, valida formato e rejeita PIN errado', async () => {
    assert(!validatePinFormat('').valid, 'PIN vazio deve ser rejeitado');
    assert(!validatePinFormat('123').valid, 'PIN com menos de 4 dígitos deve ser rejeitado');
    assert(!validatePinFormat('12a4').valid, 'PIN alfanumérico deve ser rejeitado');
    assert(validatePinFormat('4829').valid, 'PIN de 4 dígitos deve ser aceite');
    assert(validatePinFormat('482910').valid, 'PIN de 6 dígitos deve ser aceite');

    const hashA = await hashMemberPin('4829');
    const hashB = await hashMemberPin('4829');
    assert(hashA.startsWith('pbkdf2_sha256$100000$'), 'Hash deve usar formato pbkdf2_sha256$100000$...');
    assert(hashA !== hashB, 'Mesmo PIN deve gerar hashes distintos devido ao salt aleatório');
    assert(await verifyMemberPinHash('4829', hashA), 'PIN correcto deve validar contra hashA');
    assert(await verifyMemberPinHash('4829', hashB), 'PIN correcto deve validar contra hashB');
    assert(!(await verifyMemberPinHash('1234', hashA)), 'PIN incorrecto não pode autenticar');
    assert(!(await verifyMemberPinHash('4829', undefined)), 'Membro sem pinHash não pode desbloquear com PIN');
  });

  // Teste 10: Bloqueio progressivo após tentativas falhadas (3 -> 30s, 5 -> 300s, 8 -> 900s)
  await test('RBAC 6.2: Bloqueio progressivo de PIN (3 -> 30s, 5 -> 300s, 8+ -> 900s)', () => {
    const now = 1_700_000_000_000;
    const f1 = computeProgressiveLockout(0, now);
    assert(f1.failedAttempts === 1 && f1.lockoutSeconds === 0 && !f1.lockedUntilIso, '1.ª falha não bloqueia');

    const f2 = computeProgressiveLockout(1, now);
    assert(f2.failedAttempts === 2 && f2.lockoutSeconds === 0, '2.ª falha não bloqueia');

    const f3 = computeProgressiveLockout(2, now);
    assert(f3.failedAttempts === 3 && f3.lockoutSeconds === 30 && Boolean(f3.lockedUntilIso), '3.ª falha bloqueia 30s');
    const lock3 = isPinCurrentlyLocked({ pinLockedUntilIso: f3.lockedUntilIso }, now + 5_000);
    assert(lock3.locked && lock3.remainingSeconds === 25, 'Durante janela de 30s deve reportar 25s restantes');
    assert(!isPinCurrentlyLocked({ pinLockedUntilIso: f3.lockedUntilIso }, now + 31_000).locked, 'Após 30s deve desbloquear');

    const f5 = computeProgressiveLockout(4, now);
    assert(f5.failedAttempts === 5 && f5.lockoutSeconds === 300, '5.ª falha bloqueia 300s (5 min)');

    const f8 = computeProgressiveLockout(7, now);
    assert(f8.failedAttempts === 8 && f8.lockoutSeconds === 900, '8.ª falha bloqueia 900s (15 min)');
  });

  // Teste 11: Decisão 1 — Disponibilidade RBAC em todos os planos (FREE vs Cloud)
  await test('RBAC 6.3 (Decisão 1): Multi-operadores, PINs e RBAC disponíveis no plano FREE; Cloud só em planos pagos', () => {
    const freeCompany: CompanyRecord = {
      id: 'comp_free_loja',
      normalizedNif: '5001112223',
      profile: JAIMONA_COMPANY,
      status: 'active',
      plan: {
        planTier: 'FREE',
        commercialActive: false,
        maxUsers: null,
        maxInvoicesPerMonth: null,
        updatedAtIso: '2026-06-01T00:00:00.000Z',
      },
      baseSequence: 0,
      allowManagerCancel: false,
      createdAtIso: '2026-06-01T00:00:00.000Z',
      updatedAtIso: '2026-06-01T00:00:00.000Z',
    };
    const proCompany: CompanyRecord = {
      ...freeCompany,
      id: 'comp_pro_loja',
      plan: { ...freeCompany.plan, planTier: 'PROFISSIONAL', commercialActive: true },
    };

    assert(canCompanyManageMultiOperatorTeam(freeCompany) === true, 'Plano FREE deve permitir multi-operadores locais e RBAC');
    assert(canCompanySyncCloudData(freeCompany) === false, 'Plano FREE não tem sincronização Cloud');
    assert(canCompanyInviteCloudMembers(freeCompany) === false, 'Plano FREE não envia convites Cloud');
    assert(canCompanySyncCloudData(proCompany) === true, 'Plano PROFISSIONAL permite Cloud');
    assert(canCompanyInviteCloudMembers(proCompany) === true, 'Plano PROFISSIONAL permite convites Cloud');
  });

  // Teste 12: Matriz de permissões, isolamento de custos/margens e overrides individuais
  await test('RBAC 6.4: Matriz inicial, isolamento de preços de custo/margens e permissionOverrides', () => {
    const companyId = 'comp_rbac_1';
    const roles = buildDefaultCompanyRoles(companyId);
    const now = '2026-06-01T00:00:00.000Z';

    const owner: CompanyMember = {
      id: `${companyId}_owner`,
      companyId,
      uid: 'u_owner',
      email: 'dono@loja.ao',
      displayName: 'Proprietário',
      role: 'owner',
      allowInvoiceCancel: true,
      active: true,
      status: 'active',
      createdAtIso: now,
      updatedAtIso: now,
    };
    const cashier: CompanyMember = {
      id: `${companyId}_cashier`,
      companyId,
      uid: 'u_cashier',
      email: 'caixa@loja.ao',
      displayName: 'Caixa Turno A',
      role: 'cashier',
      allowInvoiceCancel: false,
      active: true,
      status: 'active',
      createdAtIso: now,
      updatedAtIso: now,
    };
    const managerNoCancel: CompanyMember = {
      id: `${companyId}_mgr`,
      companyId,
      uid: 'u_mgr',
      email: 'gerente@loja.ao',
      displayName: 'Gerente Loja',
      role: 'manager',
      allowInvoiceCancel: false,
      active: true,
      status: 'active',
      createdAtIso: now,
      updatedAtIso: now,
    };

    const ownerPerms = resolveMemberPermissions(owner, roles, false);
    assert(
      Object.values(ownerPerms).every(Boolean) && Object.keys(ownerPerms).length === 37,
      'Proprietário deve deter todas as 37 permissões activas'
    );

    const cashierPerms = resolveMemberPermissions(cashier, roles, false);
    assert(cashierPerms.pos_sell && cashierPerms.a4_sell && cashierPerms.customers_create, 'Caixa deve poder vender e criar clientes rápidos');
    assert(cashierPerms.reports_own_sales && cashierPerms.cash_own_shift, 'Caixa só acede às próprias vendas e turno');
    assert(
      !cashierPerms.cost_prices_view &&
        !cashierPerms.profits_margins_view &&
        !cashierPerms.finance_view &&
        !cashierPerms.saft_export &&
        !cashierPerms.users_manage &&
        !cashierPerms.master_edit &&
        !cashierPerms.invoice_cancel,
      'Caixa não pode ver custos, margens, finanças, SAF-T, utilizadores, ficha mestre nem anular facturas'
    );

    // Gerente sem permissão condicional vs. com grant individual
    const mgrPermsDefault = resolveMemberPermissions(managerNoCancel, roles, false);
    assert(
      !mgrPermsDefault.cost_prices_view && !mgrPermsDefault.invoice_cancel && !mgrPermsDefault.saft_export,
      'Gerente sem concessão condicional não vê custos, anulação nem SAF-T'
    );
    const mgrWithOverrides: CompanyMember = {
      ...managerNoCancel,
      permissionOverrides: {
        grant: ['cost_prices_view', 'invoice_cancel'],
        revoke: ['purchases_manage'],
      },
    };
    const mgrPermsCustom = resolveMemberPermissions(mgrWithOverrides, roles, false);
    assert(mgrPermsCustom.cost_prices_view && mgrPermsCustom.invoice_cancel, 'Grant individual deve activar permissão condicional');
    assert(!mgrPermsCustom.purchases_manage, 'Revoke individual deve remover permissão da função');

    // Membro suspenso não detém nenhuma permissão
    const suspendedPerms = resolveMemberPermissions({ ...owner, status: 'suspended', active: false }, roles, false);
    assert(!suspendedPerms.pos_sell && !suspendedPerms.master_view, 'Membro suspenso não deve manter permissões operacionais');
  });

  // Teste 13: Protecção anti-escalada de privilégios
  await test('RBAC 6.5: Anti-escalada impede auto-promoção, criação de Owner/par e atribuição de permissão não detida', () => {
    const roles = buildDefaultCompanyRoles('comp_sec');
    const now = '2026-06-01T00:00:00.000Z';

    const adminWithUsers: CompanyMember = {
      id: 'comp_sec_admin',
      companyId: 'comp_sec',
      uid: 'u_admin',
      email: 'admin@loja.ao',
      displayName: 'Admin Delegado',
      role: 'admin',
      allowInvoiceCancel: true,
      active: true,
      status: 'active',
      createdAtIso: now,
      updatedAtIso: now,
    };
    const adminPerms = resolveMemberPermissions(adminWithUsers, roles, false);

    // Admin não pode criar/editar Owner nem outro Admin, nem editar a si próprio
    const selfEdit = canActorManageTargetMember({
      actor: adminWithUsers,
      actorPermissions: adminPerms,
      targetCurrentRole: 'admin',
      targetNewRole: 'admin',
      isSelfEdit: true,
    });
    assert(!selfEdit.allowed, 'Não-proprietário não pode editar o próprio perfil');

    const promoteToOwner = canActorManageTargetMember({
      actor: adminWithUsers,
      actorPermissions: adminPerms,
      targetCurrentRole: 'cashier',
      targetNewRole: 'owner',
    });
    assert(!promoteToOwner.allowed, 'Administrador não pode atribuir função Proprietário');

    // Admin não detém saft_export nem master_edit por defeito -> não pode conceder a outrem
    const grantForbiddenPerm = canActorManageTargetMember({
      actor: adminWithUsers,
      actorPermissions: adminPerms,
      targetCurrentRole: 'cashier',
      targetNewRole: 'manager',
      targetPermissions: { ...resolveMemberPermissions({ ...adminWithUsers, role: 'manager' }, roles), saft_export: true },
    });
    assert(!grantForbiddenPerm.allowed, 'Administrador não pode conceder saft_export que não possui');

    // Gerente com users_view (sem users_manage) não pode gerir ninguém nem alterar funções
    const manager: CompanyMember = { ...adminWithUsers, uid: 'u_mgr', role: 'manager' };
    const mgrPerms = resolveMemberPermissions(manager, roles, false);
    const mgrCreateCashier = canActorManageTargetMember({
      actor: manager,
      actorPermissions: mgrPerms,
      targetNewRole: 'cashier',
    });
    assert(!mgrCreateCashier.allowed, 'Gerente sem users_manage não pode criar operadores');

    const mgrCreateCustomRole = canActorManageRoleDefinition({
      actor: manager,
      actorPermissions: mgrPerms,
      roleBase: 'cashier',
      requestedPermissions: { pos_sell: true },
    });
    assert(!mgrCreateCustomRole.allowed, 'Gerente sem roles_manage não pode criar função personalizada');

    // Proprietário pode tudo
    const owner: CompanyMember = { ...adminWithUsers, uid: 'u_owner', role: 'owner' };
    const ownerPerms = resolveMemberPermissions(owner, roles, false);
    const ownerCreatesAdmin = canActorManageTargetMember({
      actor: owner,
      actorPermissions: ownerPerms,
      targetNewRole: 'admin',
      targetPermissions: roles.find((r) => r.baseRole === 'admin')?.permissions as any,
    });
    assert(ownerCreatesAdmin.allowed, 'Proprietário deve poder criar Administrador e conceder qualquer permissão');
  });

  // Teste 14: Isolamento por estabelecimento, caixa e compatibilidade de membros legados
  await test('RBAC 6.6: Escopo por estabelecimento/caixa e migração segura de membros legados', () => {
    const now = '2026-06-01T00:00:00.000Z';
    const legacyMgr = normalizeLegacyMember(
      {
        id: `${JAIMONA_COMPANY_ID}_u1`,
        companyId: JAIMONA_COMPANY_ID,
        uid: 'u1',
        email: 'gerente@jaimona.ao',
        displayName: 'Gerente Legado',
        role: 'manager',
        allowInvoiceCancel: true,
        active: true,
        createdAtIso: now,
        updatedAtIso: now,
      },
      false
    );
    assert(legacyMgr.roleId === 'role_manager', 'Membro legado deve herdar roleId canónico role_manager');
    assert(legacyMgr.status === 'active', 'Membro legado activo deve ter status active');
    assert(
      Boolean(legacyMgr.permissionOverrides?.grant.includes('invoice_cancel')),
      'Flag legada allowInvoiceCancel deve converter-se em override invoice_cancel'
    );

    const scopedCashier: CompanyMember = {
      ...legacyMgr,
      role: 'cashier',
      establishmentIds: ['est_luanda_sul'],
      authorizedCashiers: ['02', '03'],
    };
    assert(canMemberAccessEstablishment(scopedCashier, 'est_luanda_sul'), 'Caixa autorizado no estabelecimento permitido');
    assert(!canMemberAccessEstablishment(scopedCashier, 'est_viana'), 'Caixa restrito não pode operar noutro estabelecimento');
    assert(canMemberOperateCashier(scopedCashier, '02'), 'Caixa autorizado no terminal 02');
    assert(!canMemberOperateCashier(scopedCashier, '01'), 'Caixa restrito não pode abrir terminal 01');
  });

  console.log(`\nTODOS OS ${passed}/${total} TESTES DE ISOLAMENTO PASSARAM COM SUCESSO!\n`);
  return { passed, total };
}

if (process.argv[1]?.endsWith('isolationTests.ts')) {
  runIsolationTests()
    .then((res) => {
      console.log('Resultado Final:', res);
      process.exit(0);
    })
    .catch((err) => {
      console.error('Falha nos testes de isolamento:', err);
      process.exit(1);
    });
}
