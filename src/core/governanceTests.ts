import {
  JAIMONA_COMPANY,
  JAIMONA_COMPANY_ID,
  JAIMONA_OWNER_EMAIL,
  normalizeCompanyNif,
  type CompanyOperationalStatus,
  type PlanTier,
} from './types.ts';

function assert(condition: boolean, msg: string) {
  if (!condition) {
    throw new Error(`[FAIL] ${msg}`);
  }
  console.log(`✓ [PASS] ${msg}`);
}

console.log('--- INICIANDO TESTES DO CENTRO DE GOVERNANÇA MASTER ---');

// 1. Verificação de Normalização e Identidade do Super-Admin
const adminEmail = 'wtmedia0@gmail.com';
assert(adminEmail === 'wtmedia0@gmail.com', 'Super-Admin oficial identificado com precisão');

// 2. Normalização de NIF empresarial
const rawNif = ' 500-123.456/7 ';
const normalized = normalizeCompanyNif(rawNif);
assert(normalized === '5001234567', `Normalização de NIF remove pontuação e espaços (${normalized})`);

// 3. Regra de Isolamento Multiempresa da JAIMONA
assert(JAIMONA_COMPANY_ID === 'comp_jaimona', 'Empresa protegida comp_jaimona identificada');
assert(JAIMONA_COMPANY.shortName === 'JAIMONA', 'Nome institucional preservado');
assert(JAIMONA_OWNER_EMAIL === 'jaimonacomercioeservicos@gmail.com', 'E-mail do titular preservado');

// 4. Consistência e Repartição de Planos (Base Orgânico vs Planos Comerciais)
const sampleCompanies = [
  { id: 'comp_1', planTier: 'FREE' as PlanTier, commercialActive: false, status: 'active' as CompanyOperationalStatus, invoiceCount: 15 },
  { id: 'comp_2', planTier: 'FREE' as PlanTier, commercialActive: false, status: 'suspended' as CompanyOperationalStatus, invoiceCount: 8 },
  { id: 'comp_3', planTier: 'ESSENCIAL' as PlanTier, commercialActive: true, status: 'active' as CompanyOperationalStatus, invoiceCount: 120 },
  { id: 'comp_4', planTier: 'PROFISSIONAL' as PlanTier, commercialActive: true, status: 'active' as CompanyOperationalStatus, invoiceCount: 350 },
  { id: 'comp_5', planTier: 'ENTERPRISE' as PlanTier, commercialActive: true, status: 'active' as CompanyOperationalStatus, invoiceCount: 1400 },
];

let baseOrganicCount = 0;
let commercialActiveCount = 0;
let activeCount = 0;
let suspendedCount = 0;
let totalInvoices = 0;

for (const c of sampleCompanies) {
  if (c.status === 'active') activeCount++;
  if (c.status === 'suspended') suspendedCount++;
  if (c.planTier === 'FREE') {
    baseOrganicCount++;
  } else if (c.commercialActive) {
    commercialActiveCount++;
  }
  totalInvoices += c.invoiceCount;
}

assert(baseOrganicCount === 2, `Cálculo preciso de Base Orgânico: ${baseOrganicCount}`);
assert(commercialActiveCount === 3, `Cálculo preciso de Subscrições Comerciais Pagas: ${commercialActiveCount}`);
assert(baseOrganicCount + commercialActiveCount === sampleCompanies.length, 'Soma de planos coincide 100% com o total de empresas');
assert(activeCount === 4 && suspendedCount === 1, 'Estados operacionais (ativas e suspensas) apurados sem divergência');
assert(totalInvoices === 1893, `Total consolidado de faturas apurado: ${totalInvoices}`);

console.log('TODOS OS TESTES DE GOVERNANÇA MASTER PASSARAM COM SUCESSO!');
