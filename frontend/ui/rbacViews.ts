import { formatDateTimePt } from '../../src/core/billingEngine';
import {
  PRIVACY_POLICY_VERSION,
  SILA_PRIVACY_SECTIONS,
} from '../../src/core/privacyTerms';
import {
  ALL_PERMISSION_KEYS,
  BASE_ROLE_HIERARCHY,
  canActorManageRoleDefinition,
  canActorManageTargetMember,
  formatRoleLabelPt,
  isPinCurrentlyLocked,
  PERMISSION_CATALOG,
  resolveMemberBaseRole,
  resolveMemberPermissions,
  resolveMemberStatus,
} from '../../src/core/rbac';
import {
  CompanyMember,
  CompanyRecord,
  CompanyRole,
  CompanyRoleDefinition,
  EstablishmentRecord,
  PermissionKey,
  SecurityAuditAction,
  SecurityAuditEntry,
  VITRONIS_INSTITUTIONAL,
} from '../../src/core/types';
import { renderGeometricWatermarkLayer, renderSilaGeometricMark } from './brandIdentity';
import { ICONS } from './icons';

export type RbacPanelTab = 'USERS' | 'ROLES' | 'AUDIT';

function escapeHtml(raw: string): string {
  return String(raw || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const AUDIT_ACTION_LABELS: Record<SecurityAuditAction, string> = {
  LOGIN: 'Login Cloud',
  LOGOUT: 'Logout Cloud',
  PIN_SETUP: 'Configuração de PIN',
  PIN_UNLOCK_OK: 'Desbloqueio OK',
  PIN_UNLOCK_FAIL: 'PIN Incorrecto',
  PIN_LOCKOUT: 'Bloqueio Progressivo',
  TERMINAL_LOCK: 'Terminal Bloqueado',
  OPERATOR_SWITCH: 'Troca de Operador',
  ACCESS_DENIED: 'Acesso Negado',
  INVOICE_EMIT: 'Documento Emitido',
  INVOICE_CANCEL: 'Documento Anulado',
  PRICE_EDIT: 'Preço Alterado',
  DISCOUNT_OVERRIDE: 'Desconto Autorizado',
  USER_CREATE: 'Utilizador Criado/Convidado',
  USER_UPDATE: 'Utilizador Actualizado',
  USER_SUSPEND: 'Utilizador Suspenso/Removido',
  ROLE_UPDATE: 'Função Criada/Actualizada',
  INVITE_CLAIM: 'Convite Cloud Reivindicado',
  PRIVACY_ACCEPTED: 'Privacidade Aceite',
};

function formatAuditDt(iso: string): string {
  const dt = formatDateTimePt(iso);
  return `${dt.slashDate} ${dt.time}`;
}

function getMemberRoleDisplayName(
  member: CompanyMember,
  roles: CompanyRoleDefinition[]
): string {
  if (member.roleId) {
    const found = roles.find((r) => r.id === member.roleId);
    if (found) return found.name;
  }
  return formatRoleLabelPt(member.role);
}

// ==================== 1. ECRÃ DE BLOQUEIO DO TERMINAL PARTILHADO ====================

export type OwnerPinRecoveryStep = 'NONE' | 'VERIFY_GOOGLE' | 'SET_NEW_PIN';

export function renderTerminalLockScreen(params: {
  company: CompanyRecord;
  companies: CompanyRecord[];
  members: CompanyMember[];
  roles: CompanyRoleDefinition[];
  selectedMemberId: string;
  pinInput: string;
  newPinConfirmInput: string;
  isSubmitting: boolean;
  errorMessage: string | null;
  lockReasonMessage: string | null;
  isOnline: boolean;
  isSignedIn: boolean;
  signedInEmail: string;
  isPlatformAdmin: boolean;
  ownerRecoveryStep?: OwnerPinRecoveryStep;
}): string {
  const {
    company,
    companies,
    members,
    roles,
    selectedMemberId,
    pinInput,
    newPinConfirmInput,
    isSubmitting,
    errorMessage,
    lockReasonMessage,
    isOnline,
    isSignedIn,
    signedInEmail,
    isPlatformAdmin,
    ownerRecoveryStep = 'NONE',
  } = params;

  const activeMembers = members.filter((m) => resolveMemberStatus(m) === 'active');
  const selectedMember =
    activeMembers.find((m) => m.id === selectedMemberId) ||
    activeMembers[0] ||
    null;

  const isSelectedOwner = Boolean(
    selectedMember && resolveMemberBaseRole(selectedMember) === 'owner'
  );
  const isOwnerInitialSetup = Boolean(
    isSelectedOwner && selectedMember && !selectedMember.pinHash
  );
  const activeRecoveryStep: OwnerPinRecoveryStep =
    isSelectedOwner && selectedMember?.pinHash ? ownerRecoveryStep : 'NONE';
  const lockStatus = selectedMember
    ? isPinCurrentlyLocked(selectedMember)
    : { locked: false, remainingSeconds: 0 };

  return `
    <div class="no-print relative min-h-dvh w-screen sila-bg-grid-dark text-slate-100 flex flex-col justify-between p-4 sm:p-6 overflow-x-hidden overflow-y-auto">
      ${renderGeometricWatermarkLayer('dark', 'center')}
      <!-- Topo limpo: apenas empresa activa e controlos operacionais essenciais -->
      <header class="relative z-10 max-w-md w-full mx-auto flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-slate-800/80">
        <div class="flex items-center gap-2 min-w-0">
          ${renderSilaGeometricMark('w-4 h-4 text-slate-300 shrink-0')}
          <div class="flex items-baseline gap-2 min-w-0">
            <h1 class="text-sm sm:text-base font-bold text-white truncate">
              ${escapeHtml(company.profile.shortName || company.profile.legalName)}
            </h1>
            <span class="text-xs font-mono text-slate-400 shrink-0 tabular-nums">NIF ${escapeHtml(company.profile.nif)}</span>
          </div>
        </div>

        <div class="flex items-center gap-2 shrink-0">
          ${
            companies.length > 1
              ? `<select
                  id="lock-screen-company-select"
                  class="h-8 px-2 rounded-lg bg-slate-900 border border-slate-700 text-xs text-slate-200 focus:outline-none focus:border-blue-500"
                  aria-label="Seleccionar empresa"
                >
                  ${companies
                    .map(
                      (c) =>
                        `<option value="${escapeHtml(c.id)}" ${c.id === company.id ? 'selected' : ''}>${escapeHtml(
                          c.profile.shortName || c.profile.legalName
                        )} (${escapeHtml(c.profile.nif)})</option>`
                    )
                    .join('')}
                </select>`
              : ''
          }
          ${
            isPlatformAdmin
              ? `<button
                  type="button"
                  data-action="open-master-admin"
                  class="h-8 px-2.5 rounded-lg border border-slate-700 bg-slate-900 hover:bg-slate-800 text-xs font-medium text-slate-200 flex items-center gap-1.5"
                >
                  ${ICONS.shield}
                  <span>VITRONIS</span>
                </button>`
              : ''
          }
        </div>
      </header>

      <!-- Cartão Único Central: Selector Ultra-Minimalista de Operador + PIN -->
      <main class="relative z-10 max-w-md w-full mx-auto my-auto py-4">
        <section class="relative overflow-hidden bg-slate-900/95 border border-slate-800/90 rounded-2xl p-4 sm:p-5 space-y-4 shadow-2xl">
          <div class="pointer-events-none absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r from-transparent via-blue-600/80 to-transparent" aria-hidden="true"></div>
          ${
            activeMembers.length === 0
              ? `<div class="p-3 rounded-xl border border-red-900/60 bg-red-950/40 text-xs text-red-200">
                  Nenhum operador activo neste terminal. Contacte o Proprietário ou entre com a conta Google autorizada.
                </div>`
              : `<div>
                  <select
                    id="lock-screen-member-select"
                    aria-label="Operador"
                    class="w-full h-10 px-3 rounded-xl bg-slate-950 border border-slate-700 text-xs font-medium text-white focus:outline-none focus:border-blue-500"
                  >
                    ${activeMembers
                      .map((m) => {
                        const mLock = isPinCurrentlyLocked(m);
                        const roleLabel = getMemberRoleDisplayName(m, roles);
                        const suffix = mLock.locked ? ` · Bloqueado (${mLock.remainingSeconds}s)` : '';
                        return `<option value="${escapeHtml(m.id)}" ${
                          selectedMember?.id === m.id ? 'selected' : ''
                        }>${escapeHtml(m.displayName)} (${escapeHtml(roleLabel)})${suffix}</option>`;
                      })
                      .join('')}
                  </select>
                </div>`
          }

          ${
            lockReasonMessage
              ? `<div class="px-3 py-2 rounded-lg bg-amber-950/50 border border-amber-800/70 text-[11px] text-amber-200">
                  ${escapeHtml(lockReasonMessage)}
                </div>`
              : ''
          }

          ${
            !selectedMember
              ? ''
              : isOwnerInitialSetup
                ? `
                  ${
                    errorMessage
                      ? `<div class="p-2.5 rounded-xl bg-red-950/70 border border-red-800 text-xs text-red-200">${escapeHtml(errorMessage)}</div>`
                      : ''
                  }
                  <form data-form="setup-owner-pin-form" class="space-y-3">
                    <input type="hidden" name="memberId" value="${escapeHtml(selectedMember.id)}" />
                    <div>
                      <label class="block text-xs font-medium text-slate-300 mb-1">Definir PIN inicial (4 a 6 dígitos)</label>
                      <input
                        type="password"
                        name="pin"
                        id="lock-setup-pin"
                        inputmode="numeric"
                        pattern="\\d{4,6}"
                        maxlength="6"
                        required
                        autocomplete="new-password"
                        value="${escapeHtml(pinInput)}"
                        placeholder="••••"
                        class="w-full h-11 px-4 rounded-xl bg-slate-950 border border-slate-700 text-center text-xl font-mono tracking-[0.4em] text-white focus:outline-none focus:border-blue-500"
                      />
                    </div>
                    <div>
                      <label class="block text-xs font-medium text-slate-300 mb-1">Confirmar PIN</label>
                      <input
                        type="password"
                        name="pinConfirm"
                        id="lock-setup-pin-confirm"
                        inputmode="numeric"
                        pattern="\\d{4,6}"
                        maxlength="6"
                        required
                        autocomplete="new-password"
                        value="${escapeHtml(newPinConfirmInput)}"
                        placeholder="••••"
                        class="w-full h-11 px-4 rounded-xl bg-slate-950 border border-slate-700 text-center text-xl font-mono tracking-[0.4em] text-white focus:outline-none focus:border-blue-500"
                      />
                    </div>
                    <button
                      type="submit"
                      ${isSubmitting ? 'disabled' : ''}
                      class="w-full h-11 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white font-bold text-sm flex items-center justify-center gap-2 transition-colors"
                    >
                      ${ICONS.shieldCheck}
                      <span>${isSubmitting ? 'A guardar...' : 'Guardar PIN e Desbloquear'}</span>
                    </button>
                  </form>
                `
                : !selectedMember.pinHash
                  ? `<div class="p-3 rounded-xl bg-amber-950/50 border border-amber-800/80 text-xs text-amber-200 leading-relaxed">
                      Operador sem PIN configurado. Solicite definição ao Proprietário ou Administrador.
                    </div>`
                  : activeRecoveryStep === 'VERIFY_GOOGLE'
                    ? `
                      ${
                        errorMessage
                          ? `<div class="p-2.5 rounded-xl bg-red-950/70 border border-red-800 text-xs text-red-200">${escapeHtml(errorMessage)}</div>`
                          : ''
                      }
                      <div class="space-y-3">
                        <p class="text-xs text-slate-300 leading-relaxed">
                          Confirme a sua conta Google de Proprietário para redefinir o PIN deste terminal.
                        </p>
                        ${
                          !isOnline
                            ? `<div class="p-2.5 rounded-xl bg-amber-950/50 border border-amber-800/80 text-xs text-amber-200">
                                Ligação à internet necessária para confirmar a conta Google.
                              </div>`
                            : ''
                        }
                        <button
                          type="button"
                          data-action="lock-owner-recovery-verify-google"
                          ${!isOnline || isSubmitting ? 'disabled' : ''}
                          class="w-full h-11 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white font-bold text-sm flex items-center justify-center gap-2 transition-colors"
                        >
                          ${ICONS.shieldCheck}
                          <span>${isSubmitting ? 'A confirmar...' : 'Confirmar com Google'}</span>
                        </button>
                        <button
                          type="button"
                          data-action="lock-owner-recovery-cancel"
                          ${isSubmitting ? 'disabled' : ''}
                          class="w-full h-9 rounded-xl border border-slate-700 bg-slate-950 hover:bg-slate-800 text-xs font-medium text-slate-300 transition-colors"
                        >Voltar ao PIN</button>
                      </div>
                    `
                    : activeRecoveryStep === 'SET_NEW_PIN'
                      ? `
                        ${
                          errorMessage
                            ? `<div class="p-2.5 rounded-xl bg-red-950/70 border border-red-800 text-xs text-red-200">${escapeHtml(errorMessage)}</div>`
                            : ''
                        }
                        <div class="px-3 py-2 rounded-lg bg-emerald-950/40 border border-emerald-800/70 text-[11px] text-emerald-200 truncate">
                          Identidade confirmada: ${escapeHtml(signedInEmail || 'Google')}
                        </div>
                        <form data-form="recover-owner-pin-form" class="space-y-3">
                          <input type="hidden" name="memberId" value="${escapeHtml(selectedMember.id)}" />
                          <div>
                            <label for="lock-recover-pin" class="block text-xs font-medium text-slate-300 mb-1">Novo PIN (4 a 6 dígitos)</label>
                            <input
                              type="password"
                              name="pin"
                              id="lock-recover-pin"
                              inputmode="numeric"
                              pattern="\\d{4,6}"
                              maxlength="6"
                              required
                              autocomplete="new-password"
                              value="${escapeHtml(pinInput)}"
                              placeholder="••••"
                              class="w-full h-11 px-4 rounded-xl bg-slate-950 border border-slate-700 text-center text-xl font-mono tracking-[0.4em] text-white focus:outline-none focus:border-blue-500"
                            />
                          </div>
                          <div>
                            <label for="lock-recover-pin-confirm" class="block text-xs font-medium text-slate-300 mb-1">Confirmar novo PIN</label>
                            <input
                              type="password"
                              name="pinConfirm"
                              id="lock-recover-pin-confirm"
                              inputmode="numeric"
                              pattern="\\d{4,6}"
                              maxlength="6"
                              required
                              autocomplete="new-password"
                              value="${escapeHtml(newPinConfirmInput)}"
                              placeholder="••••"
                              class="w-full h-11 px-4 rounded-xl bg-slate-950 border border-slate-700 text-center text-xl font-mono tracking-[0.4em] text-white focus:outline-none focus:border-blue-500"
                            />
                          </div>
                          <button
                            type="submit"
                            ${isSubmitting ? 'disabled' : ''}
                            class="w-full h-11 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white font-bold text-sm flex items-center justify-center gap-2 transition-colors"
                          >
                            ${ICONS.shieldCheck}
                            <span>${isSubmitting ? 'A redefinir...' : 'Redefinir PIN e Desbloquear'}</span>
                          </button>
                          <button
                            type="button"
                            data-action="lock-owner-recovery-cancel"
                            ${isSubmitting ? 'disabled' : ''}
                            class="w-full h-9 rounded-xl border border-slate-700 bg-slate-950 hover:bg-slate-800 text-xs font-medium text-slate-300 transition-colors"
                          >Cancelar</button>
                        </form>
                      `
                      : `
                    ${
                      errorMessage
                        ? `<div class="p-2.5 rounded-xl bg-red-950/70 border border-red-800 text-xs text-red-200">${escapeHtml(errorMessage)}</div>`
                        : ''
                    }

                    ${
                      lockStatus.locked
                        ? `<div class="p-2.5 rounded-xl bg-red-950/60 border border-red-800 text-xs text-red-200">
                            Bloqueado temporariamente (${lockStatus.remainingSeconds}s).
                          </div>`
                        : ''
                    }

                    <form data-form="terminal-unlock-form" class="space-y-3">
                      <input type="hidden" name="memberId" value="${escapeHtml(selectedMember.id)}" />
                      <div>
                        <label for="terminal-unlock-pin-input" class="block text-xs font-medium text-slate-300 mb-1.5">Introduza o seu PIN (4 a 6 dígitos)</label>
                        <input
                          type="password"
                          name="pin"
                          id="terminal-unlock-pin-input"
                          inputmode="numeric"
                          maxlength="6"
                          required
                          ${lockStatus.locked ? 'disabled' : ''}
                          autocomplete="current-password"
                          value="${escapeHtml(pinInput)}"
                          placeholder="••••"
                          class="w-full h-12 px-4 rounded-xl bg-slate-950 border border-slate-700 text-center text-2xl font-mono tracking-[0.45em] text-white focus:outline-none focus:border-blue-500"
                        />
                      </div>

                      <!-- Teclado Numérico Táctil Compacto (apagamento tradicional via teclado ou ⌫) -->
                      <div class="grid grid-cols-3 gap-2">
                        ${['1', '2', '3', '4', '5', '6', '7', '8', '9']
                          .map(
                            (d) => `<button
                              type="button"
                              data-action="lock-keypad-digit"
                              data-value="${d}"
                              ${lockStatus.locked ? 'disabled' : ''}
                              class="h-10 rounded-xl bg-slate-800 hover:bg-slate-700 active:scale-95 disabled:opacity-40 text-base font-mono font-bold text-white transition-all"
                            >${d}</button>`
                          )
                          .join('')}
                        <button
                          type="button"
                          data-action="lock-keypad-digit"
                          data-value="0"
                          ${lockStatus.locked ? 'disabled' : ''}
                          class="col-span-2 h-10 rounded-xl bg-slate-800 hover:bg-slate-700 active:scale-95 disabled:opacity-40 text-base font-mono font-bold text-white transition-all"
                        >0</button>
                        <button
                          type="button"
                          data-action="lock-keypad-backspace"
                          ${lockStatus.locked ? 'disabled' : ''}
                          aria-label="Apagar último dígito"
                          title="Apagar dígito"
                          class="h-10 rounded-xl bg-slate-950 border border-slate-800 hover:bg-slate-800 disabled:opacity-40 text-xs font-medium text-slate-300"
                        >⌫</button>
                      </div>

                      <button
                        type="submit"
                        ${isSubmitting || lockStatus.locked ? 'disabled' : ''}
                        class="w-full h-11 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white font-bold text-sm flex items-center justify-center gap-2 transition-colors"
                      >
                        ${ICONS.unlock}
                        <span>${isSubmitting ? 'A verificar...' : 'Desbloquear Terminal'}</span>
                      </button>
                      ${
                        isSelectedOwner
                          ? `<button
                              type="button"
                              data-action="lock-owner-recovery-open"
                              class="w-full pt-1 text-center text-[11px] text-slate-400 hover:text-blue-300 transition-colors"
                            >Esqueceu o PIN do Proprietário?</button>`
                          : ''
                      }
                    </form>
                  `
          }
        </section>
      </main>

      <!-- Rodapé minimalista: apenas sessão Google -->
      <footer class="relative z-10 max-w-md w-full mx-auto pt-3 border-t border-slate-800/80 flex items-center justify-between gap-2 text-xs text-slate-400">
        ${
          isSignedIn
            ? `<span class="font-mono text-[11px] text-slate-400 truncate">${escapeHtml(signedInEmail)}</span>
               <button type="button" data-action="signout-google" class="h-7 px-2.5 rounded-md border border-slate-700 hover:bg-slate-800 text-[11px] text-slate-200 shrink-0">Terminar Sessão</button>`
            : `<button type="button" data-action="signin-google" ${!isOnline ? 'disabled' : ''} class="h-8 px-3 rounded-lg border border-slate-700 bg-slate-900 hover:bg-slate-800 disabled:opacity-40 text-xs text-slate-200">
                 Entrar com Google
               </button>`
        }
      </footer>
    </div>
  `;
}

// ==================== 2. MODAL POLÍTICA DE PRIVACIDADE ====================

export function renderPrivacyPolicyModal(params: {
  company: CompanyRecord | null;
  acceptedVersion?: string;
  acceptedAtIso?: string;
}): string {
  const { company, acceptedVersion, acceptedAtIso } = params;
  const isCurrentAccepted = acceptedVersion === PRIVACY_POLICY_VERSION;

  return `
    <div class="fixed inset-0 z-60 bg-slate-950/75 backdrop-blur-sm flex items-center justify-center p-3 sm:p-5">
      <div class="bg-white text-slate-900 rounded-2xl border border-slate-200 w-full max-w-3xl max-h-[90vh] flex flex-col overflow-hidden shadow-2xl">
        <div class="px-5 py-4 border-b border-slate-200 flex items-start justify-between gap-3 bg-slate-50 shrink-0">
          <div>
            <div class="text-[11px] font-bold uppercase tracking-wider text-blue-700">SILA-Billing · Governança &amp; Privacidade</div>
            <h2 class="text-base font-bold text-slate-900 mt-0.5">Política de Privacidade, Segurança e Controlo de Acessos</h2>
            <p class="text-[11px] text-slate-500 mt-0.5">
              Versão ${escapeHtml(PRIVACY_POLICY_VERSION)}${
                company ? ` · Empresa: ${escapeHtml(company.profile.shortName)} (NIF ${escapeHtml(company.profile.nif)})` : ''
              }
            </p>
          </div>
          <button
            type="button"
            data-action="close-privacy-policy"
            class="h-8 w-8 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-200/70 flex items-center justify-center"
          >${ICONS.close}</button>
        </div>

        <div class="flex-1 overflow-y-auto p-5 space-y-4 text-xs">
          ${
            isCurrentAccepted && acceptedAtIso
              ? `<div class="p-3 rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-900 flex items-center gap-2">
                  <span class="text-emerald-600">${ICONS.shieldCheck}</span>
                  <span>Versão actual (${escapeHtml(PRIVACY_POLICY_VERSION)}) registada e aceite em ${escapeHtml(formatAuditDt(acceptedAtIso))}.</span>
                </div>`
              : `<div class="p-3 rounded-lg border border-blue-200 bg-blue-50 text-blue-900">
                  Leia as regras de tratamento de dados, isolamento por empresa e proteção de PIN de terminal do SILA-Billing.
                </div>`
          }

          ${SILA_PRIVACY_SECTIONS.map(
            (sec) => `
              <section class="border border-slate-200 rounded-xl p-4 space-y-2 bg-white">
                <h3 class="text-sm font-bold text-slate-900">${escapeHtml(sec.title)}</h3>
                <p class="text-xs text-slate-600 leading-relaxed">${escapeHtml(sec.summary)}</p>
                <ul class="space-y-1.5 pt-1 text-xs text-slate-700 list-disc pl-4">
                  ${sec.items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}
                </ul>
              </section>
            `
          ).join('')}
        </div>

        <div class="px-5 py-3.5 border-t border-slate-200 bg-slate-50 flex flex-wrap items-center justify-between gap-2 shrink-0">
          <span class="text-[11px] text-slate-500">${escapeHtml(VITRONIS_INSTITUTIONAL.legalName)} · NIF ${escapeHtml(VITRONIS_INSTITUTIONAL.nif)}</span>
          <div class="flex items-center gap-2">
            <button
              type="button"
              data-action="accept-privacy-policy"
              class="h-9 px-4 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold flex items-center gap-1.5"
            >
              ${ICONS.check}
              <span>${isCurrentAccepted ? 'Confirmar Leitura' : 'Aceitar e Continuar'}</span>
            </button>
            <button
              type="button"
              data-action="close-privacy-policy"
              class="h-9 px-3 rounded-lg border border-slate-200 bg-white hover:bg-slate-100 text-xs font-medium text-slate-700"
            >Fechar</button>
          </div>
        </div>
      </div>
    </div>
  `;
}

// ==================== 3. PAINEL RBAC (UTILIZADORES, FUNÇÕES & AUDITORIA) ====================

export function renderRbacTeamSection(params: {
  company: CompanyRecord;
  actor: CompanyMember | null;
  actorPermissions: Record<PermissionKey, boolean>;
  members: CompanyMember[];
  roles: CompanyRoleDefinition[];
  securityAuditLogs: SecurityAuditEntry[];
  inactivityLockMinutes: number;
  activeTab: RbacPanelTab;
  editingMemberId: string | null;
  editingRoleId: string | null;
  formError: string | null;
  noticeMessage: string | null;
  auditSearch: string;
  auditActionFilter: string;
  establishments: EstablishmentRecord[];
  isOnline: boolean;
  isCloudTeamEntitled: boolean;
}): string {
  const {
    company,
    actor,
    actorPermissions,
    members,
    roles,
    securityAuditLogs,
    inactivityLockMinutes,
    activeTab,
    editingMemberId,
    editingRoleId,
    formError,
    noticeMessage,
    auditSearch,
    auditActionFilter,
    establishments,
    isCloudTeamEntitled,
  } = params;

  const canManageUsers = Boolean(actor && (actor.role === 'owner' || actorPermissions.users_manage));
  const canManageRoles = Boolean(actor && (actor.role === 'owner' || actorPermissions.roles_manage));
  const canViewAudit = Boolean(actor && (actor.role === 'owner' || actorPermissions.audit_view));
  const canManageSettings = Boolean(actor && (actor.role === 'owner' || actorPermissions.settings_manage));

  return `
    <div class="bg-white rounded-xl border border-slate-200 overflow-hidden shadow-sm">
      <!-- Cabeçalho RBAC (Decisão 1: Segurança Local Incluída em TODOS os Planos) -->
      <div class="px-5 py-4 border-b border-slate-200 bg-slate-50 flex flex-wrap items-center justify-between gap-3">
        <div class="space-y-1">
          <div class="flex items-center gap-2 flex-wrap">
            <h3 class="text-sm font-bold text-slate-900 flex items-center gap-1.5">
              ${ICONS.shieldCheck}
              <span>Utilizadores, Funções, PINs e Segurança (RBAC)</span>
            </h3>
            <span class="px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 text-[10px] font-semibold">
              Multi-Operador Local Activo (Todos os Planos)
            </span>
            <span class="px-2 py-0.5 rounded text-[10px] font-medium ${
              isCloudTeamEntitled
                ? 'bg-blue-100 text-blue-800'
                : 'bg-slate-200 text-slate-700'
            }">
              ${isCloudTeamEntitled ? 'Sincronização & Convites Cloud Activos' : 'Modo Local · Sync Multi-dispositivo via Cloud'}
            </span>
          </div>
          <p class="text-[11px] text-slate-500">
            Isolado para <strong>${escapeHtml(company.profile.shortName)}</strong> (companyId: <span class="font-mono">${escapeHtml(company.id)}</span>).
            Cada colaborador possui perfil e PIN próprio.
          </p>
        </div>

        <div class="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            data-action="lock-terminal-now"
            class="h-8 px-3 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold flex items-center gap-1.5"
          >
            ${ICONS.lock}
            <span>Bloquear Terminal</span>
          </button>
        </div>
      </div>

      <!-- Abas RBAC -->
      <div class="px-5 pt-3 border-b border-slate-200 flex items-center gap-2 overflow-x-auto bg-white">
        ${(
          [
            { id: 'USERS', label: `Utilizadores (${members.length})`, visible: true },
            { id: 'ROLES', label: `Funções e Permissões (${roles.length})`, visible: true },
            { id: 'AUDIT', label: `Auditoria de Segurança (${securityAuditLogs.length})`, visible: canViewAudit },
          ] as { id: RbacPanelTab; label: string; visible: boolean }[]
        )
          .filter((t) => t.visible)
          .map(
            (t) => `
              <button
                type="button"
                data-action="switch-rbac-tab"
                data-value="${t.id}"
                class="px-3.5 py-2 text-xs font-semibold border-b-2 transition-colors whitespace-nowrap ${
                  activeTab === t.id
                    ? 'border-blue-600 text-blue-700'
                    : 'border-transparent text-slate-500 hover:text-slate-800'
                }"
              >${escapeHtml(t.label)}</button>
            `
          )
          .join('')}
      </div>

      <div class="p-5 space-y-5">
        ${
          formError
            ? `<div class="p-3 rounded-lg border border-red-200 bg-red-50 text-xs text-red-700">${escapeHtml(formError)}</div>`
            : ''
        }
        ${
          noticeMessage
            ? `<div class="p-3 rounded-lg border border-emerald-200 bg-emerald-50 text-xs text-emerald-800">${escapeHtml(noticeMessage)}</div>`
            : ''
        }

        ${
          activeTab === 'USERS'
            ? renderRbacUsersTab({
                company,
                actor,
                actorPermissions,
                members,
                roles,
                editingMemberId,
                establishments,
                canManageUsers,
                isCloudTeamEntitled,
              })
            : activeTab === 'ROLES'
              ? renderRbacRolesTab({
                  actor,
                  actorPermissions,
                  roles,
                  editingRoleId,
                  canManageRoles,
                })
              : renderRbacAuditTab({
                  securityAuditLogs,
                  inactivityLockMinutes,
                  auditSearch,
                  auditActionFilter,
                  canManageSettings,
                })
        }
      </div>
    </div>
  `;
}

function renderRbacUsersTab(params: {
  company: CompanyRecord;
  actor: CompanyMember | null;
  actorPermissions: Record<PermissionKey, boolean>;
  members: CompanyMember[];
  roles: CompanyRoleDefinition[];
  editingMemberId: string | null;
  establishments: EstablishmentRecord[];
  canManageUsers: boolean;
  isCloudTeamEntitled: boolean;
}): string {
  const {
    company,
    actor,
    actorPermissions,
    members,
    roles,
    editingMemberId,
    establishments,
    canManageUsers,
    isCloudTeamEntitled,
  } = params;

  const editingMember = editingMemberId
    ? members.find((m) => m.id === editingMemberId) || null
    : null;

  // Funções que o utilizador actual pode atribuir sem escalada de privilégios
  const selectableRoles = roles.filter((r) => {
    if (!actor) return false;
    if (actor.role === 'owner') return r.baseRole !== 'owner' || editingMember?.role === 'owner';
    if (r.baseRole === 'owner') return false;
    const actorRank = BASE_ROLE_HIERARCHY[resolveMemberBaseRole(actor)];
    const roleRank = BASE_ROLE_HIERARCHY[r.baseRole];
    if (roleRank >= actorRank) return false;
    for (const k of ALL_PERMISSION_KEYS) {
      if (r.permissions[k] && !actorPermissions[k]) return false;
    }
    return true;
  });

  const editingCurrentRoleId =
    editingMember?.roleId ||
    selectableRoles.find((r) => r.baseRole === 'cashier')?.id ||
    selectableRoles[0]?.id ||
    'role_cashier';

  const currentGrants = new Set(editingMember?.permissionOverrides?.grant || []);
  const currentRevokes = new Set(editingMember?.permissionOverrides?.revoke || []);

  return `
    <div class="grid grid-cols-1 lg:grid-cols-12 gap-5">
      <!-- Lista de Colaboradores -->
      <div class="${canManageUsers ? 'lg:col-span-7' : 'lg:col-span-12'} space-y-3">
        <div class="flex items-center justify-between">
          <h4 class="text-xs font-bold uppercase tracking-wider text-slate-500">Equipa e Operadores da Empresa</h4>
          ${
            canManageUsers && editingMember
              ? `<button type="button" data-action="rbac-new-member" class="text-xs font-semibold text-blue-600 hover:underline">+ Novo Utilizador</button>`
              : ''
          }
        </div>

        <div class="divide-y divide-slate-100 border border-slate-200 rounded-xl overflow-hidden">
          ${
            members.length === 0
              ? `<div class="p-6 text-center text-xs text-slate-500">Sem utilizadores registados.</div>`
              : members
                  .map((m) => {
                    const mStatus = resolveMemberStatus(m);
                    const mRoleLabel = getMemberRoleDisplayName(m, roles);
                    const isSelf = Boolean(actor && m.id === actor.id);
                    const manageCheck = actor
                      ? canActorManageTargetMember({
                          actor,
                          actorPermissions,
                          targetCurrentRole: m.role,
                          targetNewRole: m.role,
                          isSelfEdit: isSelf,
                        })
                      : { allowed: false };
                    const mLock = isPinCurrentlyLocked(m);

                    return `
                      <div class="p-3.5 bg-white hover:bg-slate-50/70 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                        <div class="min-w-0 space-y-1">
                          <div class="flex items-center gap-2 flex-wrap">
                            <span class="text-xs font-bold text-slate-900">${escapeHtml(m.displayName)}</span>
                            <span class="px-2 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200 text-[10px] font-semibold">
                              ${escapeHtml(mRoleLabel)}
                            </span>
                            <span class="px-2 py-0.5 rounded text-[10px] font-medium ${
                              mStatus === 'active'
                                ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                                : mStatus === 'pending_invite'
                                  ? 'bg-amber-50 text-amber-700 border border-amber-200'
                                  : 'bg-red-50 text-red-700 border border-red-200'
                            }">
                              ${
                                mStatus === 'active'
                                  ? 'Activo'
                                  : mStatus === 'pending_invite'
                                    ? 'Convite Pendente'
                                    : 'Suspenso'
                              }
                            </span>
                            <span class="px-1.5 py-0.5 rounded text-[10px] font-mono ${
                              m.pinHash ? 'bg-slate-100 text-slate-700' : 'bg-amber-100 text-amber-800'
                            }">
                              ${m.pinHash ? 'PIN ✓' : 'Sem PIN'}
                            </span>
                            ${
                              mLock.locked
                                ? `<span class="px-1.5 py-0.5 rounded bg-red-100 text-red-700 text-[10px] font-semibold">Bloqueado ${mLock.remainingSeconds}s</span>`
                                : ''
                            }
                            ${isSelf ? `<span class="text-[10px] text-slate-400">(Sessão actual)</span>` : ''}
                          </div>

                          <div class="text-[11px] text-slate-500 flex flex-wrap items-center gap-x-3 gap-y-0.5">
                            ${m.email ? `<span class="font-mono">${escapeHtml(m.email)}</span>` : ''}
                            ${m.phone ? `<span class="font-mono">${escapeHtml(m.phone)}</span>` : ''}
                            <span>
                              Estabelecimentos: ${
                                m.establishmentIds && m.establishmentIds.length > 0
                                  ? escapeHtml(
                                      m.establishmentIds
                                        .map((eid) => establishments.find((e) => e.id === eid)?.code || eid)
                                        .join(', ')
                                    )
                                  : 'Todos'
                              }
                            </span>
                            <span>
                              Caixas: ${
                                m.authorizedCashiers && m.authorizedCashiers.length > 0
                                  ? escapeHtml(m.authorizedCashiers.join(', '))
                                  : 'Todas'
                              }
                            </span>
                          </div>
                        </div>

                        ${
                          canManageUsers && manageCheck.allowed
                            ? `<div class="flex items-center gap-1.5 shrink-0">
                                <button
                                  type="button"
                                  data-action="rbac-edit-member"
                                  data-id="${escapeHtml(m.id)}"
                                  class="h-7 px-2.5 rounded-md border border-slate-200 bg-white hover:bg-slate-100 text-[11px] font-medium text-slate-700"
                                >Editar / PIN</button>
                                ${
                                  m.role !== 'owner'
                                    ? `<button
                                        type="button"
                                        data-action="rbac-toggle-member-status"
                                        data-id="${escapeHtml(m.id)}"
                                        class="h-7 px-2.5 rounded-md border border-slate-200 bg-white hover:bg-slate-100 text-[11px] font-medium ${
                                          mStatus === 'suspended' ? 'text-emerald-700' : 'text-amber-700'
                                        }"
                                      >${mStatus === 'suspended' ? 'Reativar' : 'Suspender'}</button>
                                      <button
                                        type="button"
                                        data-action="rbac-remove-member"
                                        data-id="${escapeHtml(m.id)}"
                                        class="h-7 px-2 rounded-md border border-red-200 bg-red-50 hover:bg-red-100 text-[11px] text-red-700"
                                        title="Remover utilizador"
                                      >${ICONS.trash}</button>`
                                    : ''
                                }
                              </div>`
                            : ''
                        }
                      </div>
                    `;
                  })
                  .join('')
          }
        </div>
      </div>

      <!-- Formulário de Criação / Edição de Colaborador -->
      ${
        canManageUsers
          ? `<div class="lg:col-span-5 bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-3">
              <div class="flex items-center justify-between">
                <h4 class="text-xs font-bold text-slate-900">
                  ${editingMember ? `Editar: ${escapeHtml(editingMember.displayName)}` : 'Adicionar Operador / Colaborador'}
                </h4>
                ${
                  editingMember
                    ? `<button type="button" data-action="rbac-cancel-member-edit" class="text-[11px] text-slate-500 hover:text-slate-800">Cancelar</button>`
                    : ''
                }
              </div>

              <form data-form="rbac-member-form" class="space-y-3 text-xs">
                ${editingMember ? `<input type="hidden" name="memberId" value="${escapeHtml(editingMember.id)}" />` : ''}

                <div>
                  <label class="block text-[11px] font-medium text-slate-700 mb-1">Nome do Colaborador *</label>
                  <input
                    type="text"
                    name="displayName"
                    required
                    maxlength="120"
                    value="${escapeHtml(editingMember?.displayName || '')}"
                    placeholder="Ex: Maria Santos — Caixa 02"
                    class="w-full h-9 px-2.5 rounded-lg bg-white border border-slate-200 text-xs focus:outline-none focus:border-blue-600"
                  />
                </div>

                <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  <div>
                    <label class="block text-[11px] font-medium text-slate-700 mb-1">
                      E-mail ${isCloudTeamEntitled ? '(Convite Cloud opcional)' : '(Identificador opcional)'}
                    </label>
                    <input
                      type="email"
                      name="email"
                      maxlength="120"
                      value="${escapeHtml(editingMember?.email || '')}"
                      placeholder="operador@empresa.ao"
                      class="w-full h-9 px-2.5 rounded-lg bg-white border border-slate-200 text-xs font-mono focus:outline-none focus:border-blue-600"
                    />
                  </div>
                  <div>
                    <label class="block text-[11px] font-medium text-slate-700 mb-1">Telefone</label>
                    <input
                      type="text"
                      name="phone"
                      maxlength="32"
                      value="${escapeHtml(editingMember?.phone || '')}"
                      placeholder="+244 9..."
                      class="w-full h-9 px-2.5 rounded-lg bg-white border border-slate-200 text-xs font-mono focus:outline-none focus:border-blue-600"
                    />
                  </div>
                </div>

                <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  <div>
                    <label class="block text-[11px] font-medium text-slate-700 mb-1">Função / Perfil *</label>
                    <select
                      name="roleId"
                      ${editingMember?.role === 'owner' ? 'disabled' : ''}
                      class="w-full h-9 px-2 rounded-lg bg-white border border-slate-200 text-xs focus:outline-none focus:border-blue-600"
                    >
                      ${
                        editingMember?.role === 'owner'
                          ? `<option value="role_owner" selected>Proprietário (Titular)</option>`
                          : selectableRoles
                              .map(
                                (r) =>
                                  `<option value="${escapeHtml(r.id)}" ${
                                    editingCurrentRoleId === r.id ? 'selected' : ''
                                  }>${escapeHtml(r.name)}${r.isSystem ? '' : ' (Personalizada)'}</option>`
                              )
                              .join('')
                      }
                    </select>
                  </div>

                  <div>
                    <label class="block text-[11px] font-medium text-slate-700 mb-1">
                      ${editingMember ? 'Alterar PIN (4–6 dígitos, opcional)' : 'PIN de Terminal (4–6 dígitos) *'}
                    </label>
                    <input
                      type="password"
                      name="pin"
                      inputmode="numeric"
                      maxlength="6"
                      ${!editingMember ? '' : ''}
                      autocomplete="new-password"
                      placeholder="${editingMember?.pinHash ? 'Manter PIN actual' : 'Ex: 4821'}"
                      class="w-full h-9 px-2.5 rounded-lg bg-white border border-slate-200 text-xs font-mono tracking-widest focus:outline-none focus:border-blue-600"
                    />
                  </div>
                </div>

                <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  <div>
                    <label class="block text-[11px] font-medium text-slate-700 mb-1">Caixas Autorizadas (ex: 01, 02)</label>
                    <input
                      type="text"
                      name="authorizedCashiers"
                      value="${escapeHtml((editingMember?.authorizedCashiers || []).join(', '))}"
                      placeholder="Vazio = todas as caixas"
                      class="w-full h-9 px-2.5 rounded-lg bg-white border border-slate-200 text-xs font-mono focus:outline-none focus:border-blue-600"
                    />
                  </div>
                  <div>
                    <label class="block text-[11px] font-medium text-slate-700 mb-1">Modo de Registo</label>
                    <select
                      name="status"
                      ${editingMember?.role === 'owner' ? 'disabled' : ''}
                      class="w-full h-9 px-2 rounded-lg bg-white border border-slate-200 text-xs focus:outline-none focus:border-blue-600"
                    >
                      <option value="active" ${!editingMember || resolveMemberStatus(editingMember) === 'active' ? 'selected' : ''}>Activo neste terminal</option>
                      ${
                        isCloudTeamEntitled
                          ? `<option value="pending_invite" ${editingMember && resolveMemberStatus(editingMember) === 'pending_invite' ? 'selected' : ''}>Convite Cloud pendente</option>`
                          : ''
                      }
                      ${
                        editingMember
                          ? `<option value="suspended" ${resolveMemberStatus(editingMember) === 'suspended' ? 'selected' : ''}>Suspenso</option>`
                          : ''
                      }
                    </select>
                  </div>
                </div>

                ${
                  establishments.length > 0
                    ? `<div>
                        <label class="block text-[11px] font-medium text-slate-700 mb-1">Estabelecimentos Permitidos (vazio = todos)</label>
                        <div class="flex flex-wrap gap-2">
                          ${establishments
                            .map((est) => {
                              const checked = editingMember?.establishmentIds?.includes(est.id) ?? false;
                              return `<label class="inline-flex items-center gap-1.5 px-2 py-1 rounded border border-slate-200 bg-white text-[11px] cursor-pointer">
                                <input type="checkbox" name="establishmentIds" value="${escapeHtml(est.id)}" ${checked ? 'checked' : ''} class="rounded text-blue-600" />
                                <span>${escapeHtml(est.code)} · ${escapeHtml(est.name)}</span>
                              </label>`;
                            })
                            .join('')}
                        </div>
                      </div>`
                    : ''
                }

                ${
                  editingMember?.role !== 'owner'
                    ? `<details class="border border-slate-200 rounded-lg bg-white p-2.5">
                        <summary class="text-[11px] font-semibold text-slate-700 cursor-pointer select-none">
                          Excepções Individuais de Permissão (Opcional)
                        </summary>
                        <div class="pt-2 mt-2 border-t border-slate-100 max-h-48 overflow-y-auto space-y-1.5">
                          ${PERMISSION_CATALOG.filter(
                            (p) => actor?.role === 'owner' || actorPermissions[p.key]
                          )
                            .map((p) => {
                              const state = currentGrants.has(p.key)
                                ? 'grant'
                                : currentRevokes.has(p.key)
                                  ? 'revoke'
                                  : 'inherit';
                              return `
                                <div class="flex items-center justify-between gap-2 text-[11px]">
                                  <span class="text-slate-700 truncate">${escapeHtml(p.label)}</span>
                                  <select name="override_${escapeHtml(p.key)}" class="h-7 px-1.5 rounded border border-slate-200 text-[10.5px] bg-slate-50">
                                    <option value="inherit" ${state === 'inherit' ? 'selected' : ''}>Da função</option>
                                    <option value="grant" ${state === 'grant' ? 'selected' : ''}>Permitir</option>
                                    <option value="revoke" ${state === 'revoke' ? 'selected' : ''}>Bloquear</option>
                                  </select>
                                </div>
                              `;
                            })
                            .join('')}
                        </div>
                      </details>`
                    : ''
                }

                <p class="text-[10.5px] text-slate-500 leading-snug">
                  O PIN é guardado com PBKDF2-SHA256 e salt aleatório individual.
                  ${
                    !isCloudTeamEntitled
                      ? `Para convidar utilizadores noutros dispositivos na nuvem, considere a opção Cloud Profissional (este terminal local permite utilizadores ilimitados no plano actual: ${escapeHtml(
                          company.plan.planTier
                        )}).`
                      : 'Quando informar o e-mail, o colaborador também poderá reivindicar o convite na Cloud.'
                  }
                </p>

                <button
                  type="submit"
                  class="w-full h-9 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold flex items-center justify-center gap-1.5"
                >
                  ${ICONS.check}
                  <span>${editingMember ? 'Guardar Alterações' : 'Criar Utilizador'}</span>
                </button>
              </form>
            </div>`
          : `<div class="lg:col-span-12 text-xs text-slate-500">Modo apenas de consulta. Apenas o Proprietário ou Administrador autorizado pode gerir utilizadores.</div>`
      }
    </div>
  `;
}

function renderRbacRolesTab(params: {
  actor: CompanyMember | null;
  actorPermissions: Record<PermissionKey, boolean>;
  roles: CompanyRoleDefinition[];
  editingRoleId: string | null;
  canManageRoles: boolean;
}): string {
  const { actor, actorPermissions, roles, editingRoleId, canManageRoles } = params;
  const editingRole = editingRoleId ? roles.find((r) => r.id === editingRoleId) || null : null;

  const groups: Array<'Vendas & POS' | 'Clientes & Stock' | 'Compras & Finanças' | 'Fiscal & Administração'> = [
    'Vendas & POS',
    'Clientes & Stock',
    'Compras & Finanças',
    'Fiscal & Administração',
  ];

  const baseRoleOptions: CompanyRole[] = ['admin', 'manager', 'accountant', 'warehouse', 'seller', 'cashier'];

  return `
    <div class="space-y-5">
      <!-- Matriz Comparativa das Funções -->
      <div class="space-y-2">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h4 class="text-xs font-bold uppercase tracking-wider text-slate-500">Funções Disponíveis e Matriz de Permissões</h4>
            <p class="text-[11px] text-slate-500">7 perfis padrão + funções personalizadas da empresa.</p>
          </div>
          ${
            canManageRoles && editingRole
              ? `<button type="button" data-action="rbac-new-role" class="text-xs font-semibold text-blue-600 hover:underline">+ Nova Função Personalizada</button>`
              : ''
          }
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          ${roles
            .map((r) => {
              const grantedCount = ALL_PERMISSION_KEYS.filter((k) => Boolean(r.permissions[k])).length;
              const rolePermCheck = actor
                ? canActorManageRoleDefinition({
                    actor,
                    actorPermissions,
                    roleBase: r.baseRole,
                    requestedPermissions: r.permissions,
                  })
                : { allowed: false };
              return `
                <div class="p-3.5 rounded-xl border ${
                  editingRole?.id === r.id ? 'border-blue-500 bg-blue-50/30' : 'border-slate-200 bg-white'
                } flex flex-col justify-between gap-2">
                  <div>
                    <div class="flex items-center justify-between gap-2">
                      <span class="text-xs font-bold text-slate-900">${escapeHtml(r.name)}</span>
                      <span class="px-1.5 py-0.5 rounded text-[10px] font-medium ${
                        r.isSystem ? 'bg-slate-100 text-slate-600' : 'bg-indigo-100 text-indigo-700'
                      }">${r.isSystem ? 'Sistema' : 'Personalizada'}</span>
                    </div>
                    <p class="text-[11px] text-slate-500 mt-1 leading-snug">${escapeHtml(r.description || '')}</p>
                  </div>
                  <div class="flex items-center justify-between pt-2 border-t border-slate-100 text-[11px]">
                    <span class="font-mono text-slate-600">${grantedCount}/${ALL_PERMISSION_KEYS.length} permissões</span>
                    ${
                      canManageRoles && !r.isSystem && rolePermCheck.allowed
                        ? `<button type="button" data-action="rbac-edit-role" data-id="${escapeHtml(r.id)}" class="text-blue-600 font-semibold hover:underline">Editar</button>`
                        : `<span class="text-slate-400">Hierarquia: ${escapeHtml(formatRoleLabelPt(r.baseRole))}</span>`
                    }
                  </div>
                </div>
              `;
            })
            .join('')}
        </div>
      </div>

      <!-- Editor / Criador de Função Personalizada -->
      ${
        canManageRoles
          ? `<form data-form="rbac-role-form" class="p-4 rounded-xl border border-slate-200 bg-slate-50 space-y-4">
              <div class="flex items-center justify-between">
                <h4 class="text-xs font-bold text-slate-900">
                  ${editingRole ? `Editar Função Personalizada: ${escapeHtml(editingRole.name)}` : 'Criar Função Personalizada'}
                </h4>
                ${
                  editingRole
                    ? `<button type="button" data-action="rbac-cancel-role-edit" class="text-[11px] text-slate-500 hover:text-slate-800">Cancelar</button>`
                    : ''
                }
              </div>

              ${editingRole ? `<input type="hidden" name="roleId" value="${escapeHtml(editingRole.id)}" />` : ''}

              <div class="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
                <div>
                  <label class="block text-[11px] font-medium text-slate-700 mb-1">Nome da Função *</label>
                  <input
                    type="text"
                    name="name"
                    required
                    maxlength="60"
                    value="${escapeHtml(editingRole?.name || '')}"
                    placeholder="Ex: Supervisor de Loja"
                    class="w-full h-9 px-2.5 rounded-lg bg-white border border-slate-200 text-xs focus:outline-none focus:border-blue-600"
                  />
                </div>
                <div>
                  <label class="block text-[11px] font-medium text-slate-700 mb-1">Perfil Base de Hierarquia *</label>
                  <select name="baseRole" class="w-full h-9 px-2 rounded-lg bg-white border border-slate-200 text-xs focus:outline-none focus:border-blue-600">
                    ${baseRoleOptions
                      .filter(
                        (br) =>
                          actor?.role === 'owner' ||
                          (actor && BASE_ROLE_HIERARCHY[br] < BASE_ROLE_HIERARCHY[resolveMemberBaseRole(actor)])
                      )
                      .map(
                        (br) =>
                          `<option value="${br}" ${(editingRole?.baseRole || 'seller') === br ? 'selected' : ''}>${escapeHtml(
                            formatRoleLabelPt(br)
                          )}</option>`
                      )
                      .join('')}
                  </select>
                </div>
                <div>
                  <label class="block text-[11px] font-medium text-slate-700 mb-1">Descrição</label>
                  <input
                    type="text"
                    name="description"
                    maxlength="160"
                    value="${escapeHtml(editingRole?.description || '')}"
                    placeholder="Responsabilidades operacionais..."
                    class="w-full h-9 px-2.5 rounded-lg bg-white border border-slate-200 text-xs focus:outline-none focus:border-blue-600"
                  />
                </div>
              </div>

              <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
                ${groups
                  .map(
                    (grp) => `
                      <div class="bg-white border border-slate-200 rounded-lg p-3 space-y-1.5">
                        <div class="text-[11px] font-bold text-slate-800 uppercase tracking-wider pb-1 border-b border-slate-100">${escapeHtml(grp)}</div>
                        ${PERMISSION_CATALOG.filter((p) => p.group === grp)
                          .map((p) => {
                            const canDelegate = Boolean(actor?.role === 'owner' || actorPermissions[p.key]);
                            const checked = Boolean(editingRole?.permissions?.[p.key]);
                            return `
                              <label class="flex items-center gap-2 text-[11px] ${canDelegate ? 'text-slate-700 cursor-pointer' : 'text-slate-400 cursor-not-allowed'}">
                                <input
                                  type="checkbox"
                                  name="perm_${escapeHtml(p.key)}"
                                  ${checked ? 'checked' : ''}
                                  ${!canDelegate ? 'disabled' : ''}
                                  class="rounded border-slate-300 text-blue-600"
                                />
                                <span>${escapeHtml(p.label)}</span>
                              </label>
                            `;
                          })
                          .join('')}
                      </div>
                    `
                  )
                  .join('')}
              </div>

              <div class="flex justify-end">
                <button
                  type="submit"
                  class="h-9 px-4 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold flex items-center gap-1.5"
                >
                  ${ICONS.check}
                  <span>${editingRole ? 'Actualizar Função' : 'Guardar Função Personalizada'}</span>
                </button>
              </div>
            </form>`
          : `<div class="p-3 rounded-lg bg-slate-50 border border-slate-200 text-xs text-slate-500">
              A criação e alteração de funções personalizadas é reservada ao Proprietário ou perfil com permissão de gestão de funções.
            </div>`
      }
    </div>
  `;
}

function renderRbacAuditTab(params: {
  securityAuditLogs: SecurityAuditEntry[];
  inactivityLockMinutes: number;
  auditSearch: string;
  auditActionFilter: string;
  canManageSettings: boolean;
}): string {
  const {
    securityAuditLogs,
    inactivityLockMinutes,
    auditSearch,
    auditActionFilter,
    canManageSettings,
  } = params;

  const q = auditSearch.trim().toLowerCase();
  const filtered = securityAuditLogs.filter((entry) => {
    if (auditActionFilter !== 'ALL' && entry.action !== auditActionFilter) return false;
    if (!q) return true;
    return (
      entry.summary.toLowerCase().includes(q) ||
      entry.actorName.toLowerCase().includes(q) ||
      entry.targetType.toLowerCase().includes(q) ||
      (entry.targetId && entry.targetId.toLowerCase().includes(q)) ||
      entry.action.toLowerCase().includes(q)
    );
  });

  return `
    <div class="space-y-4">
      <!-- Configuração de Bloqueio por Inactividade -->
      <div class="p-3.5 rounded-xl border border-slate-200 bg-slate-50 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div class="text-xs font-bold text-slate-900">Bloqueio Automático por Inactividade (Terminal Partilhado)</div>
          <p class="text-[11px] text-slate-500">O terminal arranca sempre bloqueado ao abrir e tranca automaticamente ao expirar este tempo sem actividade.</p>
        </div>
        <select
          id="rbac-inactivity-minutes-select"
          ${!canManageSettings ? 'disabled' : ''}
          class="h-9 px-2.5 rounded-lg bg-white border border-slate-200 text-xs font-medium text-slate-800 disabled:opacity-50"
        >
          ${[3, 5, 10, 15, 30]
            .map(
              (m) =>
                `<option value="${m}" ${inactivityLockMinutes === m ? 'selected' : ''}>${m} minutos</option>`
            )
            .join('')}
        </select>
      </div>

      <!-- Barra de Pesquisa e Exportação de Auditoria -->
      <div class="flex flex-wrap items-center justify-between gap-2.5">
        <div class="flex flex-wrap items-center gap-2 flex-1 min-w-[240px]">
          <input
            type="text"
            id="rbac-audit-search-input"
            value="${escapeHtml(auditSearch)}"
            placeholder="Filtrar por operador, detalhe ou acção..."
            class="h-9 px-3 rounded-lg border border-slate-200 bg-white text-xs flex-1 min-w-[180px] focus:outline-none focus:border-blue-600"
          />
          <select
            id="rbac-audit-action-filter"
            class="h-9 px-2.5 rounded-lg border border-slate-200 bg-white text-xs text-slate-700"
          >
            <option value="ALL" ${auditActionFilter === 'ALL' ? 'selected' : ''}>Todas as acções</option>
            ${(Object.keys(AUDIT_ACTION_LABELS) as SecurityAuditAction[])
              .map(
                (act) =>
                  `<option value="${act}" ${auditActionFilter === act ? 'selected' : ''}>${escapeHtml(
                    AUDIT_ACTION_LABELS[act]
                  )}</option>`
              )
              .join('')}
          </select>
        </div>

        <button
          type="button"
          data-action="export-security-audit-csv"
          class="h-9 px-3 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-xs font-medium text-slate-700 flex items-center gap-1.5"
        >
          ${ICONS.download}
          <span>Exportar Auditoria CSV</span>
        </button>
      </div>

      <!-- Tabela Imutável de Auditoria -->
      <div class="border border-slate-200 rounded-xl overflow-hidden">
        <div class="max-h-96 overflow-y-auto divide-y divide-slate-100">
          ${
            filtered.length === 0
              ? `<div class="p-6 text-center text-xs text-slate-500">Nenhum evento de segurança registado para este filtro.</div>`
              : filtered
                  .slice(0, 120)
                  .map((entry) => {
                    const isAlert =
                      entry.outcome === 'denied' ||
                      entry.action === 'ACCESS_DENIED' ||
                      entry.action === 'PIN_UNLOCK_FAIL' ||
                      entry.action === 'PIN_LOCKOUT';
                    return `
                      <div class="p-3 bg-white text-xs flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                        <div class="min-w-0 space-y-0.5">
                          <div class="flex items-center gap-2 flex-wrap">
                            <span class="px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                              isAlert ? 'bg-red-100 text-red-700' : 'bg-slate-100 text-slate-700'
                            }">
                              ${escapeHtml(AUDIT_ACTION_LABELS[entry.action] || entry.action)}
                            </span>
                            <span class="font-semibold text-slate-900">${escapeHtml(entry.actorName)}</span>
                            <span class="text-[11px] text-slate-400">(${escapeHtml(formatRoleLabelPt(entry.actorRole))})</span>
                            ${entry.targetType ? `<span class="text-[11px] text-slate-500">→ ${escapeHtml(entry.targetType)}${entry.targetId ? ` #${escapeHtml(entry.targetId)}` : ''}</span>` : ''}
                          </div>
                          <p class="text-[11px] text-slate-600">${escapeHtml(entry.summary)}</p>
                        </div>
                        <span class="text-[10.5px] font-mono text-slate-400 shrink-0 tabular-nums">
                          ${escapeHtml(formatAuditDt(entry.createdAtIso))}
                        </span>
                      </div>
                    `;
                  })
                  .join('')
          }
        </div>
        <div class="px-3 py-2 bg-slate-50 border-t border-slate-200 text-[10.5px] text-slate-500 flex items-center justify-between">
          <span>Registo imutável de auditoria (append-only · sem eliminação manual)</span>
          <span class="font-mono">${filtered.length} evento(s)</span>
        </div>
      </div>
    </div>
  `;
}

export function renderRbacMobileModal(params: Parameters<typeof renderRbacTeamSection>[0]): string {
  return `
    <div class="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div class="bg-slate-100 w-full max-w-4xl rounded-t-3xl sm:rounded-2xl max-h-[92dvh] flex flex-col overflow-hidden shadow-2xl">
        <div class="px-4 py-3 bg-white border-b border-slate-200 flex items-center justify-between shrink-0">
          <span class="text-sm font-bold text-slate-900">Equipa, Funções e Segurança</span>
          <button type="button" data-action="close-rbac-mobile-modal" class="h-8 w-8 rounded-lg text-slate-500 hover:bg-slate-100 flex items-center justify-center">
            ${ICONS.close}
          </button>
        </div>
        <div class="flex-1 overflow-y-auto p-3 sm:p-4 text-slate-900">
          ${renderRbacTeamSection(params)}
        </div>
      </div>
    </div>
  `;
}

// Helper para garantir que resolveMemberPermissions é re-exportável se necessário
export { resolveMemberPermissions };
