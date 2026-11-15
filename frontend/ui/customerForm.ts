import {
  CUSTOMER_PAYMENT_TERMS_LABELS,
  CUSTOMER_TYPE_LABELS,
  FOREIGN_COUNTRY_OPTIONS,
  inferCustomerType,
  type CustomerDraftInput,
} from '../../src/core/customerValidator';
import {
  type Customer,
  type CustomerPaymentTerms,
  type CustomerType,
} from '../../src/core/types';
import { ANGOLA_PROVINCES } from './companyMasterForm';
import { ICONS } from './icons';

export type CustomerFormViewMode = 'DESKTOP' | 'MOBILE';

export interface CustomerMasterFormOptions {
  mode: CustomerFormViewMode;
  companyId: string;
  customer: Customer;
  creditLimitInput: string;
  formId: string;
  isDirectCustomer: boolean;
  showAdvanced: boolean;
  errorMessage: string | null;
  canManage: boolean;
  defaultLocality: string;
}

function escapeHtml(raw: string): string {
  return String(raw || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function parseDecimalFlexible(raw: string): number {
  const cleaned = String(raw || '').trim().replace(/\s+/g, '').replace(',', '.');
  if (!cleaned) return 0;
  const val = Number(cleaned);
  return Number.isFinite(val) ? val : Number.NaN;
}

/**
 * Extrai um CustomerDraftInput normalizado a partir de FormData,
 * preservando campos avançados existentes quando a secção avançada estiver recolhida.
 */
export function extractCustomerDraftFromFormData(
  fd: FormData,
  baseCustomer: Customer | null | undefined,
  options: {
    companyId: string;
    isDirectCustomer: boolean;
    defaultLocality: string;
  }
): { draft: CustomerDraftInput; rawCreditLimitInvalid: boolean } {
  const { companyId, isDirectCustomer, defaultLocality } = options;

  const rawType = String(
    fd.get('customerType') ?? baseCustomer?.customerType ?? (isDirectCustomer ? 'CONSUMIDOR_FINAL' : 'PARTICULAR')
  ).trim() as CustomerType;
  const customerType: CustomerType = isDirectCustomer
    ? 'CONSUMIDOR_FINAL'
    : rawType === 'CONSUMIDOR_FINAL' || rawType === 'PARTICULAR' || rawType === 'EMPRESA' || rawType === 'ESTRANGEIRO'
      ? rawType
      : 'PARTICULAR';

  const rawActive = fd.get('active');
  const active = isDirectCustomer
    ? true
    : rawActive !== null
      ? String(rawActive) !== 'false'
      : baseCustomer?.active !== false;

  const rawLimit = String(fd.get('creditLimit') ?? '').trim();
  const parsedLimit = rawLimit ? parseDecimalFlexible(rawLimit) : 0;
  const rawCreditLimitInvalid = Boolean(
    !isDirectCustomer && rawLimit && (Number.isNaN(parsedLimit) || parsedLimit < 0)
  );
  const creditLimit = !isDirectCustomer && parsedLimit > 0 ? parsedLimit : undefined;

  const rawTerms = String(
    fd.get('paymentTerms') ?? baseCustomer?.paymentTerms ?? 'IMEDIATO'
  ).trim() as CustomerPaymentTerms;
  const paymentTerms: CustomerPaymentTerms = isDirectCustomer
    ? 'IMEDIATO'
    : rawTerms === 'IMEDIATO' ||
        rawTerms === '15_DIAS' ||
        rawTerms === '30_DIAS' ||
        rawTerms === '45_DIAS' ||
        rawTerms === '60_DIAS' ||
        rawTerms === 'PERSONALIZADO'
      ? rawTerms
      : 'IMEDIATO';

  const getField = (key: string, fallback = ''): string => {
    const val = fd.get(key);
    return val !== null ? String(val).trim() : fallback;
  };

  const countryCode =
    customerType === 'ESTRANGEIRO'
      ? getField('countryCode', baseCustomer?.countryCode && baseCustomer.countryCode !== 'AO' ? baseCustomer.countryCode : 'PT')
      : 'AO';

  const foreignTaxId =
    customerType === 'ESTRANGEIRO'
      ? getField('foreignTaxId', baseCustomer?.foreignTaxId || baseCustomer?.nif || '')
      : '';

  const province = getField('province', baseCustomer?.province || '');
  const municipality = getField('municipality', baseCustomer?.municipality || '');
  const address = getField('address', baseCustomer?.address || '');
  const locality =
    getField('locality', '') ||
    [municipality, province, customerType === 'ESTRANGEIRO' ? countryCode : 'Angola']
      .filter(Boolean)
      .join(' · ') ||
    baseCustomer?.locality ||
    defaultLocality;

  return {
    rawCreditLimitInvalid,
    draft: {
      id: baseCustomer?.id,
      companyId,
      customerType,
      active,
      internalCode: getField('internalCode', baseCustomer?.internalCode || ''),
      name: getField('name', baseCustomer?.name || ''),
      nif: isDirectCustomer
        ? 'Consumidor Final'
        : customerType === 'ESTRANGEIRO'
          ? foreignTaxId
          : getField('nif', baseCustomer?.nif || ''),
      countryCode,
      foreignTaxId,
      phone: getField('phone', baseCustomer?.phone || ''),
      email: getField('email', baseCustomer?.email || ''),
      province,
      municipality,
      address,
      locality,
      creditLimit,
      paymentTerms,
      hasCreditAccount: Boolean((creditLimit && creditLimit > 0) || paymentTerms !== 'IMEDIATO'),
      notes: getField('notes', baseCustomer?.notes || ''),
      bankName: getField('bankName', baseCustomer?.bankName || ''),
      bankIban: getField('bankIban', baseCustomer?.bankIban || ''),
      documentRef: getField('documentRef', baseCustomer?.documentRef || ''),
      representativeName: getField('representativeName', baseCustomer?.representativeName || ''),
      representativePhone: getField('representativePhone', baseCustomer?.representativePhone || ''),
      specialCreditNotes: getField('specialCreditNotes', baseCustomer?.specialCreditNotes || ''),
    },
  };
}

/**
 * Formulário unificado de Cadastro de Cliente em 5 secções operacionais + campos avançados colapsáveis.
 * Garante paridade funcional entre Desktop e Mobile.
 */
export function renderCustomerMasterForm(options: CustomerMasterFormOptions): string {
  const {
    mode,
    customer,
    creditLimitInput,
    formId,
    isDirectCustomer,
    showAdvanced,
    errorMessage,
    canManage,
  } = options;

  const isMobile = mode === 'MOBILE';
  const cType: CustomerType = isDirectCustomer
    ? 'CONSUMIDOR_FINAL'
    : customer.customerType || inferCustomerType(customer);
  const isActive = isDirectCustomer ? true : customer.active !== false;
  const isForeign = cType === 'ESTRANGEIRO';
  const isCompanyType = cType === 'EMPRESA';
  const isFinalConsumer = cType === 'CONSUMIDOR_FINAL' || isDirectCustomer;

  const paymentTerms: CustomerPaymentTerms = isDirectCustomer
    ? 'IMEDIATO'
    : customer.paymentTerms || 'IMEDIATO';

  const cardCls = isMobile
    ? 'rounded-xl bg-slate-900 border border-slate-800 p-3 space-y-2.5'
    : 'rounded-lg bg-white border border-slate-200 p-3 space-y-2.5';
  const sectionHeaderCls = isMobile
    ? 'text-[10.5px] font-bold tracking-wider uppercase text-slate-400 border-b border-slate-800 pb-1.5'
    : 'text-[10.5px] font-bold tracking-wider uppercase text-slate-500 border-b border-slate-100 pb-1.5';
  const labelCls = isMobile
    ? 'block text-[11px] font-medium text-slate-300 mb-1'
    : 'block text-[11px] font-medium text-slate-600 mb-1';
  const inputCls = isMobile
    ? 'w-full h-11 px-3 rounded-xl bg-slate-950 border border-slate-700 text-sm text-white focus:outline-none focus:border-blue-500'
    : 'w-full h-9 px-2.5 rounded-md bg-white border border-slate-200 text-xs text-slate-900 focus:outline-none focus:border-blue-600';
  const readonlyCls = isMobile
    ? 'w-full h-11 px-3 rounded-xl bg-slate-800/70 border border-slate-700 text-sm text-slate-400 font-mono'
    : 'w-full h-9 px-2.5 rounded-md bg-slate-100 border border-slate-200 text-xs text-slate-500 font-mono';
  const textareaCls = isMobile
    ? 'w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-700 text-sm text-white focus:outline-none focus:border-blue-500'
    : 'w-full px-2.5 py-2 rounded-md bg-white border border-slate-200 text-xs text-slate-900 focus:outline-none focus:border-blue-600';

  const formAttr = isMobile ? `id="${escapeHtml(formId)}"` : `data-form="${escapeHtml(formId)}"`;
  const cancelAction = isMobile ? 'mobile-close-modals' : 'cancel-edit-customer';
  const provinceListId = `${escapeHtml(formId)}-ao-provinces`;

  return `
    <form
      ${formAttr}
      class="${isMobile ? 'space-y-3' : 'p-3.5 border-b border-slate-200 bg-slate-50 space-y-3 shrink-0 max-h-[65vh] overflow-y-auto'}"
    >
      ${
        errorMessage
          ? `<div class="${
              isMobile
                ? 'p-3 rounded-xl bg-red-950/70 border border-red-800/80 text-red-200 text-xs font-medium'
                : 'p-2.5 rounded-md bg-red-50 border border-red-200 text-xs text-red-700'
            }">${escapeHtml(errorMessage)}</div>`
          : ''
      }

      <div class="grid grid-cols-1 ${isMobile ? '' : 'lg:grid-cols-2'} gap-3">
        <!-- 01 — IDENTIFICAÇÃO -->
        <section class="${cardCls}">
          <div class="${sectionHeaderCls} flex items-center justify-between">
            <span>01 — Identificação</span>
            <span class="font-mono text-[10px] ${isMobile ? 'text-slate-400' : 'text-slate-500'}">${escapeHtml(customer.internalCode || 'CLI-AUTO')}</span>
          </div>

          <input type="hidden" name="internalCode" value="${escapeHtml(customer.internalCode || '')}" />

          <div class="grid grid-cols-2 gap-2">
            <div>
              <label class="${labelCls}">Tipo de cliente *</label>
              <select
                name="customerType"
                ${isDirectCustomer || !canManage ? 'disabled' : ''}
                class="${isDirectCustomer || !canManage ? readonlyCls : inputCls}"
              >
                ${(['PARTICULAR', 'EMPRESA', 'ESTRANGEIRO', 'CONSUMIDOR_FINAL'] as CustomerType[])
                  .map(
                    (t) => `<option value="${t}" ${cType === t ? 'selected' : ''}>${escapeHtml(CUSTOMER_TYPE_LABELS[t])}</option>`
                  )
                  .join('')}
              </select>
              ${
                isDirectCustomer
                  ? `<input type="hidden" name="customerType" value="CONSUMIDOR_FINAL" />`
                  : ''
              }
            </div>

            <div>
              <label class="${labelCls}">Estado *</label>
              <select
                name="active"
                ${isDirectCustomer || !canManage ? 'disabled' : ''}
                class="${isDirectCustomer || !canManage ? readonlyCls : inputCls}"
              >
                <option value="true" ${isActive ? 'selected' : ''}>Activo</option>
                <option value="false" ${!isActive ? 'selected' : ''}>Inactivo</option>
              </select>
              ${isDirectCustomer ? `<input type="hidden" name="active" value="true" />` : ''}
            </div>
          </div>

          <div>
            <label class="${labelCls}">${isCompanyType ? 'Denominação social *' : 'Nome completo / Denominação social *'}</label>
            <input
              id="customer-form-name-input"
              name="name"
              type="text"
              required
              maxlength="160"
              ${!canManage ? 'readonly' : ''}
              value="${escapeHtml(customer.name || '')}"
              placeholder="${isCompanyType ? 'Denominação da empresa' : 'Nome do cliente'}"
              class="${!canManage ? readonlyCls : inputCls}"
            />
          </div>

          ${
            isForeign
              ? `<div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <div>
                    <label class="${labelCls}">País de origem *</label>
                    <select
                      name="countryCode"
                      ${!canManage ? 'disabled' : ''}
                      class="${!canManage ? readonlyCls : inputCls}"
                    >
                      ${FOREIGN_COUNTRY_OPTIONS.map(
                        (opt) =>
                          `<option value="${opt.code}" ${(customer.countryCode || 'PT') === opt.code ? 'selected' : ''}>${escapeHtml(opt.name)} (${opt.code})</option>`
                      ).join('')}
                    </select>
                  </div>
                  <div>
                    <label class="${labelCls}">ID fiscal estrangeiro *</label>
                    <input
                      name="foreignTaxId"
                      type="text"
                      maxlength="40"
                      ${!canManage ? 'readonly' : ''}
                      value="${escapeHtml(customer.foreignTaxId || (customer.nif !== 'Consumidor Final' ? customer.nif : ''))}"
                      placeholder="NIF / VAT do país"
                      class="${!canManage ? readonlyCls : `${inputCls} font-mono tabular-nums`}"
                    />
                  </div>
                </div>`
              : `<div>
                  <label class="${labelCls}">NIF${isCompanyType ? ' *' : ''}</label>
                  <input
                    name="nif"
                    type="text"
                    maxlength="32"
                    ${isDirectCustomer || isFinalConsumer || !canManage ? 'readonly' : ''}
                    value="${escapeHtml(isDirectCustomer ? 'Consumidor Final' : customer.nif || '')}"
                    placeholder="${isFinalConsumer ? 'Consumidor Final' : isCompanyType ? '5001234567' : 'Número de identificação fiscal'}"
                    class="${isDirectCustomer || isFinalConsumer || !canManage ? readonlyCls : `${inputCls} font-mono tabular-nums`}"
                  />
                </div>`
          }
        </section>

        <!-- 02 — CONTACTOS & 03 — ENDEREÇO -->
        <div class="space-y-3">
          <section class="${cardCls}">
            <div class="${sectionHeaderCls}">02 — Contactos</div>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <div>
                <label class="${labelCls}">Telefone</label>
                <input
                  name="phone"
                  type="tel"
                  maxlength="40"
                  ${!canManage ? 'readonly' : ''}
                  value="${escapeHtml(customer.phone || '')}"
                  placeholder="+244 ..."
                  class="${!canManage ? readonlyCls : `${inputCls} font-mono tabular-nums`}"
                />
              </div>
              <div>
                <label class="${labelCls}">E-mail</label>
                <input
                  name="email"
                  type="email"
                  maxlength="120"
                  ${!canManage ? 'readonly' : ''}
                  value="${escapeHtml(customer.email || '')}"
                  placeholder="cliente@email.com"
                  class="${!canManage ? readonlyCls : inputCls}"
                />
              </div>
            </div>
          </section>

          <section class="${cardCls}">
            <div class="${sectionHeaderCls}">03 — Endereço</div>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <div>
                <label class="${labelCls}">${isForeign ? 'Região / Estado' : `Província${isCompanyType ? ' *' : ''}`}</label>
                <input
                  name="province"
                  type="text"
                  maxlength="80"
                  ${!isForeign ? `list="${provinceListId}"` : ''}
                  ${!canManage ? 'readonly' : ''}
                  value="${escapeHtml(customer.province || '')}"
                  placeholder="Seleccionar"
                  class="${!canManage ? readonlyCls : inputCls}"
                />
                ${
                  !isForeign
                    ? `<datalist id="${provinceListId}">
                        ${ANGOLA_PROVINCES.map((p) => `<option value="${escapeHtml(p)}"></option>`).join('')}
                      </datalist>`
                    : ''
                }
              </div>
              <div>
                <label class="${labelCls}">${isForeign ? 'Cidade' : 'Município'}</label>
                <input
                  name="municipality"
                  type="text"
                  maxlength="80"
                  ${!canManage ? 'readonly' : ''}
                  value="${escapeHtml(customer.municipality || '')}"
                  placeholder="${isForeign ? 'Cidade' : 'Seleccionar'}"
                  class="${!canManage ? readonlyCls : inputCls}"
                />
              </div>
            </div>
            <div>
              <label class="${labelCls}">Morada${isCompanyType ? ' *' : ''}</label>
              <input
                name="address"
                type="text"
                maxlength="200"
                ${!canManage ? 'readonly' : ''}
                value="${escapeHtml(customer.address || '')}"
                placeholder="Rua, bairro, edifício..."
                class="${!canManage ? readonlyCls : inputCls}"
              />
            </div>
          </section>
        </div>

        <!-- 04 — DADOS COMERCIAIS -->
        <section class="${cardCls}">
          <div class="${sectionHeaderCls}">04 — Dados Comerciais</div>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <div>
              <label class="${labelCls}">Limite de crédito (Kz)</label>
              <input
                name="creditLimit"
                type="text"
                inputmode="decimal"
                autocomplete="off"
                ${isDirectCustomer || isFinalConsumer || !canManage ? 'disabled' : ''}
                value="${escapeHtml(isDirectCustomer || isFinalConsumer ? '' : creditLimitInput)}"
                placeholder="${isDirectCustomer || isFinalConsumer ? 'Não aplicável' : '0,00 Kz'}"
                class="${isDirectCustomer || isFinalConsumer || !canManage ? readonlyCls : `${inputCls} font-mono tabular-nums`}"
              />
            </div>
            <div>
              <label class="${labelCls}">Prazo de pagamento</label>
              <select
                name="paymentTerms"
                ${isDirectCustomer || isFinalConsumer || !canManage ? 'disabled' : ''}
                class="${isDirectCustomer || isFinalConsumer || !canManage ? readonlyCls : inputCls}"
              >
                ${(['IMEDIATO', '15_DIAS', '30_DIAS', '45_DIAS', '60_DIAS', 'PERSONALIZADO'] as CustomerPaymentTerms[])
                  .map(
                    (term) =>
                      `<option value="${term}" ${paymentTerms === term ? 'selected' : ''}>${escapeHtml(CUSTOMER_PAYMENT_TERMS_LABELS[term])}</option>`
                  )
                  .join('')}
              </select>
            </div>
          </div>
        </section>

        <!-- 05 — OBSERVAÇÕES -->
        <section class="${cardCls}">
          <div class="${sectionHeaderCls}">05 — Observações</div>
          <div>
            <textarea
              name="notes"
              rows="2"
              maxlength="500"
              ${!canManage ? 'readonly' : ''}
              placeholder="Notas internas sobre o cliente..."
              class="${!canManage ? readonlyCls : textareaCls}"
            >${escapeHtml(customer.notes || '')}</textarea>
          </div>
        </section>
      </div>

      <!-- CAMPOS AVANÇADOS (RECOLHÍVEL) -->
      <div class="${isMobile ? 'rounded-xl bg-slate-900 border border-slate-800 overflow-hidden' : 'rounded-lg bg-white border border-slate-200 overflow-hidden'}">
        <button
          type="button"
          data-action="toggle-customer-advanced"
          class="${
            isMobile
              ? 'w-full px-3 py-2.5 flex items-center justify-between text-xs font-semibold text-slate-300 hover:bg-slate-800/60'
              : 'w-full px-3 py-2 flex items-center justify-between text-xs font-semibold text-slate-700 hover:bg-slate-50'
          }"
        >
          <span>Campos avançados (banco, documento anexo, representante, crédito)</span>
          <span class="text-[11px] font-mono ${isMobile ? 'text-blue-400' : 'text-blue-600'}">${showAdvanced ? 'Ocultar' : '+ Abrir'}</span>
        </button>

        <div class="${showAdvanced ? 'p-3 border-t ' + (isMobile ? 'border-slate-800' : 'border-slate-100') + ' grid grid-cols-1 sm:grid-cols-3 gap-2.5' : 'hidden'}">
          <div>
            <label class="${labelCls}">Banco</label>
            <input
              name="bankName"
              type="text"
              maxlength="80"
              ${!canManage ? 'readonly' : ''}
              value="${escapeHtml(customer.bankName || '')}"
              placeholder="Nome do banco"
              class="${!canManage ? readonlyCls : inputCls}"
            />
          </div>
          <div>
            <label class="${labelCls}">IBAN</label>
            <input
              name="bankIban"
              type="text"
              maxlength="48"
              ${!canManage ? 'readonly' : ''}
              value="${escapeHtml(customer.bankIban || '')}"
              placeholder="AO06 ..."
              class="${!canManage ? readonlyCls : `${inputCls} font-mono tabular-nums`}"
            />
          </div>
          <div>
            <label class="${labelCls}">Ref. documento anexo</label>
            <input
              name="documentRef"
              type="text"
              maxlength="80"
              ${!canManage ? 'readonly' : ''}
              value="${escapeHtml(customer.documentRef || '')}"
              placeholder="BI / Alvará / Contrato"
              class="${!canManage ? readonlyCls : inputCls}"
            />
          </div>
          <div>
            <label class="${labelCls}">Representante</label>
            <input
              name="representativeName"
              type="text"
              maxlength="120"
              ${!canManage ? 'readonly' : ''}
              value="${escapeHtml(customer.representativeName || '')}"
              placeholder="Nome do responsável"
              class="${!canManage ? readonlyCls : inputCls}"
            />
          </div>
          <div>
            <label class="${labelCls}">Tel. representante</label>
            <input
              name="representativePhone"
              type="tel"
              maxlength="40"
              ${!canManage ? 'readonly' : ''}
              value="${escapeHtml(customer.representativePhone || '')}"
              placeholder="+244 ..."
              class="${!canManage ? readonlyCls : `${inputCls} font-mono tabular-nums`}"
            />
          </div>
          <div>
            <label class="${labelCls}">Condições especiais de crédito</label>
            <input
              name="specialCreditNotes"
              type="text"
              maxlength="300"
              ${!canManage ? 'readonly' : ''}
              value="${escapeHtml(customer.specialCreditNotes || '')}"
              placeholder="Regra ou garantia acordada"
              class="${!canManage ? readonlyCls : inputCls}"
            />
          </div>
        </div>
      </div>

      <!-- RODAPÉ & ACÇÕES -->
      <div class="flex flex-wrap items-center justify-between gap-2 pt-1">
        <span class="text-[11px] ${isMobile ? 'text-slate-400' : 'text-slate-500'}">* Campos obrigatórios no cadastro.</span>
        <div class="flex items-center gap-2 ${isMobile ? 'w-full sm:w-auto' : ''}">
          ${
            canManage
              ? `<button
                  type="submit"
                  class="${
                    isMobile
                      ? 'flex-1 h-12 px-5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-bold text-sm flex items-center justify-center gap-2'
                      : 'h-9 px-4 rounded-md bg-blue-600 text-white text-xs font-semibold hover:bg-blue-700 whitespace-nowrap flex items-center gap-1.5'
                  }"
                >${ICONS.check}<span>Guardar Cliente</span></button>`
              : ''
          }
          <button
            type="button"
            data-action="${cancelAction}"
            class="${
              isMobile
                ? 'h-12 px-4 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold'
                : 'h-9 px-3 rounded-md border border-slate-200 bg-white text-slate-600 text-xs font-medium hover:bg-slate-100'
            }"
          >${canManage ? 'Cancelar' : 'Fechar'}</button>
        </div>
      </div>
    </form>
  `;
}
