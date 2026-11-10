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
  isJaimonaOwnerEmail,
  JAIMONA_COMPANY_ID,
  PLATFORM_ADMIN_EMAIL,
} from './types.ts';

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
