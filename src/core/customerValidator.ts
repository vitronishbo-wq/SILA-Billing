import {
  getDirectCustomerIdForCompany,
  validateCompanyNif,
  type Customer,
  type CustomerChangeLogEntry,
  type CustomerPaymentTerms,
  type CustomerType,
  type DocumentType,
  type PaymentMethod,
} from './types.ts';

export const CUSTOMER_TYPE_LABELS: Readonly<Record<CustomerType, string>> = {
  CONSUMIDOR_FINAL: 'Consumidor Final',
  PARTICULAR: 'Particular',
  EMPRESA: 'Empresa',
  ESTRANGEIRO: 'Estrangeiro',
};

export const CUSTOMER_PAYMENT_TERMS_LABELS: Readonly<Record<CustomerPaymentTerms, string>> = {
  IMEDIATO: 'Imediato',
  '15_DIAS': '15 dias',
  '30_DIAS': '30 dias',
  '45_DIAS': '45 dias',
  '60_DIAS': '60 dias',
  PERSONALIZADO: 'Personalizado',
};

export const FOREIGN_COUNTRY_OPTIONS: ReadonlyArray<{ code: string; name: string }> = [
  { code: 'PT', name: 'Portugal' },
  { code: 'BR', name: 'Brasil' },
  { code: 'ZA', name: 'África do Sul' },
  { code: 'NA', name: 'Namíbia' },
  { code: 'CV', name: 'Cabo Verde' },
  { code: 'MZ', name: 'Moçambique' },
  { code: 'CD', name: 'RD Congo' },
  { code: 'CG', name: 'Rep. Congo' },
  { code: 'CN', name: 'China' },
  { code: 'ES', name: 'Espanha' },
  { code: 'FR', name: 'França' },
  { code: 'GB', name: 'Reino Unido' },
  { code: 'US', name: 'Estados Unidos' },
  { code: 'AE', name: 'Emirados Árabes Unidos' },
  { code: 'OUT', name: 'Outro País' },
];

export function normalizeCustomerNif(raw: string | undefined | null): string {
  return String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/[\s.\-\/]/g, '');
}

export function isFinalConsumerNif(raw: string | undefined | null): boolean {
  const clean = String(raw || '').trim();
  if (!clean) return true;
  const norm = normalizeCustomerNif(clean);
  return norm === 'CONSUMIDORFINAL' || norm === '999999999' || norm === '000000000';
}

export function inferCustomerType(
  customer: Partial<Customer>,
  directCustomerId?: string
): CustomerType {
  if (customer.customerType) return customer.customerType;
  if (directCustomerId && customer.id === directCustomerId) return 'CONSUMIDOR_FINAL';
  if (customer.countryCode && customer.countryCode.toUpperCase() !== 'AO') return 'ESTRANGEIRO';
  if (isFinalConsumerNif(customer.nif)) {
    const cleanName = String(customer.name || '').trim().toLowerCase();
    if (!cleanName || cleanName.includes('consumidor final') || cleanName.includes('venda directa')) {
      return 'CONSUMIDOR_FINAL';
    }
    return 'PARTICULAR';
  }
  const norm = normalizeCustomerNif(customer.nif);
  // NIFs societários em Angola começam tipicamente por 5 (ex: 500...) com 10 dígitos
  if (/^5\d{9}$/.test(norm)) return 'EMPRESA';
  return 'PARTICULAR';
}

/**
 * Gera o próximo código interno único de cliente para a empresa (`CLI-0001`, `CLI-0002`, ...),
 * garantindo isolamento estrito por `companyId`.
 */
export function generateNextCustomerInternalCode(
  existingCustomers: readonly Customer[],
  companyId: string
): string {
  const directId = getDirectCustomerIdForCompany(companyId);
  const used = new Set<string>();
  let maxSeq = 0;

  for (const c of existingCustomers) {
    if (c.companyId && c.companyId !== companyId) continue;
    if (c.id === directId) continue;
    const code = String(c.internalCode || '').trim().toUpperCase();
    if (code) {
      used.add(code);
      const match = code.match(/^CLI-(\d+)$/);
      if (match) {
        const n = Number(match[1]);
        if (Number.isFinite(n) && n > maxSeq) maxSeq = n;
      }
    }
  }

  let candidateSeq = Math.max(maxSeq + 1, 1);
  let candidate = `CLI-${String(candidateSeq).padStart(4, '0')}`;
  while (used.has(candidate)) {
    candidateSeq += 1;
    candidate = `CLI-${String(candidateSeq).padStart(4, '0')}`;
  }
  return candidate;
}

export interface CustomerDraftInput {
  id?: string;
  companyId: string;
  customerType: CustomerType;
  active: boolean;
  internalCode?: string;
  name: string;
  nif: string;
  countryCode?: string;
  foreignTaxId?: string;
  phone: string;
  email?: string;
  province?: string;
  municipality?: string;
  address: string;
  locality?: string;
  creditLimit?: number;
  paymentTerms?: CustomerPaymentTerms;
  hasCreditAccount?: boolean;
  notes?: string;
  bankName?: string;
  bankIban?: string;
  documentRef?: string;
  representativeName?: string;
  representativePhone?: string;
  specialCreditNotes?: string;
}

export interface ValidateCustomerOptions {
  companyId: string;
  existingCustomers: readonly Customer[];
  previousCustomer?: Customer | null;
  defaultLocality?: string;
  actorLabel?: string;
  isQuickPosMode?: boolean;
}

export interface ValidateCustomerResult {
  ok: boolean;
  error?: string;
  customer?: Customer;
}

/**
 * Valida, normaliza e constrói um registo de Cliente cumprindo as regras fiscais e comerciais:
 * - Consumidor Final: não exige NIF nem morada;
 * - Particular: exige nome; valida NIF se informado e evita duplicados na empresa;
 * - Empresa: exige denominação social, NIF angolano válido e domicílio fiscal;
 * - Estrangeiro: exige país de origem (≠ AO) e aceita identificação fiscal estrangeira sem forçar NIF AO;
 * - Cliente com crédito: exige identificação nominal (não consumidor final), limite ou prazo comercial e contacto.
 */
export function validateAndBuildCustomer(
  input: CustomerDraftInput,
  options: ValidateCustomerOptions
): ValidateCustomerResult {
  const {
    companyId,
    existingCustomers,
    previousCustomer,
    defaultLocality = 'Luanda - Angola',
    actorLabel = 'Operador',
    isQuickPosMode = false,
  } = options;

  const directCustId = getDirectCustomerIdForCompany(companyId);
  const isDirectCust = Boolean(
    (input.id && input.id === directCustId) || (previousCustomer && previousCustomer.id === directCustId)
  );

  const customerType: CustomerType = isDirectCust ? 'CONSUMIDOR_FINAL' : input.customerType || 'PARTICULAR';
  const active = isDirectCust ? true : input.active !== false;
  const name = String(input.name || '').trim().slice(0, 160);
  const rawNif = String(input.nif || '').trim();
  const rawForeignTaxId = String(input.foreignTaxId || '').trim().slice(0, 40);
  const rawCountry = String(input.countryCode || (customerType === 'ESTRANGEIRO' ? '' : 'AO'))
    .trim()
    .toUpperCase()
    .slice(0, 8);
  const phone = String(input.phone || '').trim().slice(0, 40);
  const email = String(input.email || '').trim().slice(0, 120);
  const province = String(input.province || '').trim().slice(0, 80);
  const municipality = String(input.municipality || '').trim().slice(0, 80);
  const address = String(input.address || '').trim().slice(0, 200);
  const paymentTerms: CustomerPaymentTerms = isDirectCust
    ? 'IMEDIATO'
    : input.paymentTerms || 'IMEDIATO';
  const creditLimit =
    !isDirectCust && typeof input.creditLimit === 'number' && Number.isFinite(input.creditLimit) && input.creditLimit > 0
      ? Math.min(999999999, Math.round(input.creditLimit * 100) / 100)
      : undefined;
  const hasCreditAccount =
    !isDirectCust &&
    Boolean(input.hasCreditAccount || (creditLimit && creditLimit > 0) || paymentTerms !== 'IMEDIATO');

  const notes = String(input.notes || '').trim().slice(0, 500);
  const bankName = String(input.bankName || '').trim().slice(0, 80);
  const bankIban = String(input.bankIban || '').trim().toUpperCase().slice(0, 48);
  const documentRef = String(input.documentRef || '').trim().slice(0, 80);
  const representativeName = String(input.representativeName || '').trim().slice(0, 120);
  const representativePhone = String(input.representativePhone || '').trim().slice(0, 40);
  const specialCreditNotes = String(input.specialCreditNotes || '').trim().slice(0, 300);

  if (!name) {
    return {
      ok: false,
      error:
        customerType === 'EMPRESA'
          ? 'Indique a denominação social da empresa.'
          : 'Indique o nome completo do cliente.',
    };
  }

  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, error: 'Indique um endereço de e-mail válido.' };
  }

  let resolvedNif = 'Consumidor Final';
  let resolvedNormalizedNif = '';
  let resolvedCountryCode = 'AO';
  let resolvedForeignTaxId = '';

  if (customerType === 'CONSUMIDOR_FINAL') {
    resolvedNif = 'Consumidor Final';
    resolvedNormalizedNif = '';
    resolvedCountryCode = 'AO';
    if (hasCreditAccount) {
      return {
        ok: false,
        error: 'Consumidor Final não pode operar com crédito. Seleccione Particular, Empresa ou Estrangeiro.',
      };
    }
  } else if (customerType === 'PARTICULAR') {
    resolvedCountryCode = 'AO';
    if (rawNif && !isFinalConsumerNif(rawNif)) {
      const nifCheck = validateCompanyNif(rawNif);
      if (!nifCheck.valid) {
        return { ok: false, error: nifCheck.error || 'NIF angolano inválido para particular.' };
      }
      resolvedNif = nifCheck.normalized;
      resolvedNormalizedNif = nifCheck.normalized;
    } else {
      resolvedNif = 'Consumidor Final';
      resolvedNormalizedNif = '';
    }
  } else if (customerType === 'EMPRESA') {
    resolvedCountryCode = 'AO';
    if (!rawNif || isFinalConsumerNif(rawNif)) {
      return { ok: false, error: 'Empresa exige um NIF válido (não pode ser Consumidor Final).' };
    }
    const nifCheck = validateCompanyNif(rawNif);
    if (!nifCheck.valid) {
      return { ok: false, error: nifCheck.error || 'NIF inválido para empresa.' };
    }
    resolvedNif = nifCheck.normalized;
    resolvedNormalizedNif = nifCheck.normalized;

    const hasDomicile = Boolean(address || municipality || province || String(input.locality || '').trim());
    if (!address || (!province && !municipality && !String(input.locality || '').trim() && !hasDomicile)) {
      return {
        ok: false,
        error: 'Empresa exige domicílio fiscal completo (Província/Município e Morada).',
      };
    }
    if (!isQuickPosMode && !province && !municipality && !String(input.locality || '').trim()) {
      return {
        ok: false,
        error: 'Indique a Província ou Município do domicílio fiscal da empresa.',
      };
    }
  } else if (customerType === 'ESTRANGEIRO') {
    if (!rawCountry || rawCountry === 'AO') {
      return { ok: false, error: 'Seleccione o país de origem para cliente estrangeiro.' };
    }
    resolvedCountryCode = rawCountry;
    const candidateForeignId = normalizeCustomerNif(rawForeignTaxId || rawNif);
    if (!candidateForeignId || candidateForeignId === 'CONSUMIDORFINAL' || candidateForeignId.length < 4) {
      return {
        ok: false,
        error: 'Indique a identificação fiscal estrangeira (mín. 4 caracteres alfanuméricos).',
      };
    }
    resolvedForeignTaxId = candidateForeignId.slice(0, 40);
    resolvedNif = resolvedForeignTaxId;
    resolvedNormalizedNif = `${resolvedCountryCode}:${resolvedForeignTaxId}`;
  }

  // Regras adicionais para cliente com crédito comercial
  if (hasCreditAccount) {
    if (customerType === 'PARTICULAR' && !resolvedNormalizedNif) {
      return {
        ok: false,
        error: 'Cliente particular com crédito exige NIF de identificação fiscal.',
      };
    }
    if (!phone && !email) {
      return {
        ok: false,
        error: 'Cliente com crédito exige telefone ou e-mail para gestão de cobrança.',
      };
    }
    if (!address && !municipality && !province) {
      return {
        ok: false,
        error: 'Cliente com crédito exige morada para gestão comercial.',
      };
    }
    if (!creditLimit && paymentTerms === 'IMEDIATO') {
      return {
        ok: false,
        error: 'Defina um limite de crédito (Kz) ou prazo de pagamento para conta a crédito.',
      };
    }
  }

  // Bloqueio de duplicação de NIF / ID Fiscal dentro da mesma empresa (companyId)
  if (resolvedNormalizedNif) {
    const currentId = input.id || previousCustomer?.id || '';
    const dup = existingCustomers.find((c) => {
      if (c.companyId && c.companyId !== companyId) return false;
      if (c.id === currentId || c.id === directCustId) return false;
      const otherNorm =
        c.normalizedNif ||
        (c.customerType === 'ESTRANGEIRO' && (c.foreignTaxId || c.nif)
          ? `${(c.countryCode || 'OUT').toUpperCase()}:${normalizeCustomerNif(c.foreignTaxId || c.nif)}`
          : isFinalConsumerNif(c.nif)
            ? ''
            : normalizeCustomerNif(c.nif));
      return Boolean(otherNorm) && otherNorm === resolvedNormalizedNif;
    });
    if (dup) {
      return {
        ok: false,
        error: `Já existe um cliente cadastrado com esta identificação fiscal (${dup.internalCode ? `${dup.internalCode} · ` : ''}${dup.name}).`,
      };
    }
  }

  const computedLocality =
    String(input.locality || '').trim() ||
    [municipality, province, customerType === 'ESTRANGEIRO' ? resolvedCountryCode : 'Angola']
      .filter(Boolean)
      .join(' · ') ||
    defaultLocality;
  const computedAddress = address || computedLocality;

  const now = new Date().toISOString();
  const id =
    String(input.id || previousCustomer?.id || '').trim() ||
    `cust_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

  const internalCode = isDirectCust
    ? 'CLI-0000'
    : String(input.internalCode || previousCustomer?.internalCode || '').trim() ||
      generateNextCustomerInternalCode(existingCustomers, companyId);

  // Histórico de alterações auditado sem modificar facturas já emitidas
  const existingHistory = Array.isArray(previousCustomer?.changeHistory)
    ? previousCustomer!.changeHistory!
    : [];
  const nextHistory: CustomerChangeLogEntry[] = [...existingHistory];

  if (previousCustomer && !isDirectCust) {
    const changedParts: string[] = [];
    if (previousCustomer.name !== name || previousCustomer.nif !== resolvedNif) {
      changedParts.push('Identificação fiscal');
    }
    if (
      (previousCustomer.address || '') !== computedAddress ||
      (previousCustomer.province || '') !== province ||
      (previousCustomer.municipality || '') !== municipality
    ) {
      changedParts.push('Endereço');
    }
    if ((previousCustomer.phone || '') !== phone || (previousCustomer.email || '') !== email) {
      changedParts.push('Contactos');
    }
    if (
      (previousCustomer.creditLimit || 0) !== (creditLimit || 0) ||
      (previousCustomer.paymentTerms || 'IMEDIATO') !== paymentTerms
    ) {
      changedParts.push('Condições comerciais');
    }
    if ((previousCustomer.active !== false) !== active) {
      changedParts.push(active ? 'Activado' : 'Inactivado');
    }
    if (changedParts.length > 0) {
      nextHistory.unshift({
        changedAtIso: now,
        changedBy: actorLabel.slice(0, 60),
        summary: changedParts.join(', '),
      });
    }
  }

  const builtCustomer: Customer = {
    id,
    companyId,
    internalCode,
    customerType,
    active,
    name,
    nif: resolvedNif,
    ...(resolvedNormalizedNif ? { normalizedNif: resolvedNormalizedNif } : {}),
    countryCode: resolvedCountryCode,
    ...(resolvedForeignTaxId ? { foreignTaxId: resolvedForeignTaxId } : {}),
    ...(province ? { province } : {}),
    ...(municipality ? { municipality } : {}),
    locality: computedLocality.slice(0, 160),
    address: computedAddress.slice(0, 200),
    phone,
    ...(email ? { email } : {}),
    ...(creditLimit ? { creditLimit } : {}),
    paymentTerms,
    hasCreditAccount,
    ...(notes ? { notes } : {}),
    ...(bankName ? { bankName } : {}),
    ...(bankIban ? { bankIban } : {}),
    ...(documentRef ? { documentRef } : {}),
    ...(representativeName ? { representativeName } : {}),
    ...(representativePhone ? { representativePhone } : {}),
    ...(specialCreditNotes ? { specialCreditNotes } : {}),
    ...(nextHistory.length > 0 ? { changeHistory: nextHistory.slice(0, 20) } : {}),
    syncState: 'pending',
    synced: false,
    createdAtIso: previousCustomer?.createdAtIso || now,
    updatedAtIso: now,
  };

  return { ok: true, customer: builtCustomer };
}

export interface CustomerEmissionCheckResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Valida conformidade do cliente no acto de emissão de factura/recibo sem bloquear Consumidor Final em vendas directas.
 */
export function validateCustomerForInvoiceEmission(
  customer: Customer | null | undefined,
  options: {
    companyId: string;
    docType: DocumentType;
    paymentMethod: PaymentMethod;
    amountDue: number;
  }
): CustomerEmissionCheckResult {
  const { companyId, docType, paymentMethod, amountDue } = options;
  const directCustId = getDirectCustomerIdForCompany(companyId);

  if (!customer || customer.id === directCustId) {
    if (docType === 'FR' && amountDue > 0) {
      return {
        allowed: false,
        reason: 'Identifique ou cadastre o cliente para registar venda a crédito ou pagamento parcial.',
      };
    }
    if (docType === 'FA' && paymentMethod === 'Crédito') {
      return {
        allowed: false,
        reason: 'Factura a Prazo a crédito exige cliente identificado.',
      };
    }
    return { allowed: true };
  }

  if (customer.active === false) {
    return {
      allowed: false,
      reason: `O cliente "${customer.name}" encontra-se Inactivo. Reactive o cadastro ou seleccione outro cliente.`,
    };
  }

  const cType = inferCustomerType(customer, directCustId);
  if (cType === 'EMPRESA') {
    if (isFinalConsumerNif(customer.nif)) {
      return {
        allowed: false,
        reason: `O cliente empresarial "${customer.name}" não possui NIF válido para emissão fiscal.`,
      };
    }
    if (!String(customer.address || '').trim()) {
      return {
        allowed: false,
        reason: `Complete a morada fiscal do cliente "${customer.name}" antes de emitir factura empresarial.`,
      };
    }
  }

  if (cType === 'PARTICULAR' && (docType === 'FA' || amountDue > 0 || paymentMethod === 'Crédito')) {
    if (isFinalConsumerNif(customer.nif)) {
      return {
        allowed: false,
        reason: `Para emitir ${docType} ou venda a crédito ao particular "${customer.name}", preencha o NIF na ficha do cliente.`,
      };
    }
  }

  return { allowed: true };
}
