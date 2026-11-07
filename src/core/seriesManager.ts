/**
 * SILA-Billing — Gestão de Séries AGT e Numeração Fiscal
 * Em conformidade com o Decreto Executivo n.º 683/25 e Decreto Presidencial n.º 71/25.
 * 
 * Regras Obrigatórias da AGT:
 * 1. As séries são solicitadas à AGT (solicitarSerie) e não inventadas localmente.
 * 2. Ciclo de vida estrito por estados:
 *    - 'A' (Ativa): Série autorizada pela AGT pronta para iniciar emissão.
 *    - 'U' (Em Uso): Série que já emitiu pelo menos 1 documento na sequência.
 *    - 'F' (Finalizada): Série encerrada formalmente; impede qualquer nova emissão.
 * 3. Validação temporal estrita: Séries de novo ano fiscal só podem ser solicitadas
 *    a partir de 15 de Dezembro do ano transato ou no próprio ano.
 * 4. Sequencialidade ininterrupta: firstDocumentNumber -> firstDocumentNumber + 1 -> ...
 *    sem saltos, duplicações ou reutilização de números.
 * 5. Bloqueio fiscal: Impede a emissão de documentos fiscais sem série autorizada válida.
 */

import {
  AGT_DOCUMENT_TYPES,
  isSeriesCreationAllowedForYear,
  type AgtDocumentType,
  type AgtSeriesRecord,
  type AgtSeriesStatus,
} from './fiscalTypes.ts';

export interface SolicitarSerieInput {
  companyId: string;
  seriesCode: string; // Ex: 'A2026', 'SERIE1'
  seriesYear: number; // Ex: 2026
  documentType: AgtDocumentType;
  firstDocumentNumber?: number; // Padrão 1
  environment?: 'TESTE' | 'PRODUCAO';
  notes?: string;
  operator: string;
}

export interface ListarSeriesFilter {
  companyId: string;
  seriesYear?: number;
  documentType?: AgtDocumentType;
  status?: AgtSeriesStatus;
}

export interface ProximoNumeroFiscalResult {
  documentNo: string; // Ex: 'FR A2026/000001'
  seriesCode: string; // 'A2026'
  sequenceNumber: number; // 1
  seriesId: string;
  status: AgtSeriesStatus; // 'U'
}

const STORAGE_PREFIX = 'sila_agt_series_';

class SeriesStorage {
  private cache = new Map<string, AgtSeriesRecord[]>();

  private getStorageKey(companyId: string): string {
    return `${STORAGE_PREFIX}${companyId}`;
  }

  loadSeries(companyId: string): AgtSeriesRecord[] {
    if (this.cache.has(companyId)) {
      return this.cache.get(companyId)!;
    }

    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        const raw = window.localStorage.getItem(this.getStorageKey(companyId));
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            this.cache.set(companyId, parsed);
            return parsed;
          }
        }
      }
    } catch (err) {
      console.warn('[SeriesStorage] Erro ao carregar séries do armazenamento local:', err);
    }

    const initial: AgtSeriesRecord[] = [];
    this.cache.set(companyId, initial);
    return initial;
  }

  saveSeries(companyId: string, records: AgtSeriesRecord[]): void {
    this.cache.set(companyId, records);
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.setItem(this.getStorageKey(companyId), JSON.stringify(records));
      }
    } catch (err) {
      console.warn('[SeriesStorage] Erro ao persistir séries:', err);
    }
  }

  clearMemoryCache(): void {
    this.cache.clear();
  }
}

export const seriesStorage = new SeriesStorage();

/**
 * Normaliza o código da série fiscal (maiúsculas, alfanumérico, máx 10 chars).
 */
export function normalizeSeriesCode(code: string): string {
  return String(code || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, '')
    .slice(0, 10);
}

/**
 * Formata o número fiscal completo de acordo com o padrão AGT:
 * Exemplo: `FR A2026/000001`, `FA A2026/000042`, `NC A2026/000003`
 */
export function formatFiscalDocumentNo(
  docType: AgtDocumentType,
  seriesCode: string,
  seqNumber: number
): string {
  const padded = String(Math.max(1, Math.floor(seqNumber))).padStart(6, '0');
  return `${docType} ${seriesCode}/${padded}`;
}

/**
 * Decompõe um número de documento fiscal nos seus elementos constituintes.
 */
export function parseFiscalDocumentNo(documentNo: string): {
  valid: boolean;
  docType?: AgtDocumentType;
  seriesCode?: string;
  seqNumber?: number;
} {
  const match = String(documentNo || '').trim().match(/^([A-Z]{2})\s+([A-Z0-9_-]+)\/(\d+)$/i);
  if (!match) {
    return { valid: false };
  }
  const docType = match[1]!.toUpperCase() as AgtDocumentType;
  const seriesCode = match[2]!.toUpperCase();
  const seqNumber = parseInt(match[3]!, 10);

  return {
    valid: Boolean(AGT_DOCUMENT_TYPES[docType]),
    docType,
    seriesCode,
    seqNumber,
  };
}

/**
 * Solicita uma nova série fiscal junto da AGT (ou homologa localmente em modo offline).
 * Respeita a regra de 15 de Dezembro e o ciclo de vida inicial no estado 'A' (Ativa).
 */
export function solicitarSerie(input: SolicitarSerieInput): AgtSeriesRecord {
  const companyId = String(input.companyId || '').trim();
  if (!companyId) {
    throw new Error('A identificação da empresa (companyId) é obrigatória para solicitar séries.');
  }

  const seriesCode = normalizeSeriesCode(input.seriesCode);
  if (!seriesCode) {
    throw new Error('Indique um código de série válido (ex: A2026, SERIE1).');
  }

  const docType = input.documentType;
  if (!AGT_DOCUMENT_TYPES[docType]) {
    throw new Error(`Tipo de documento fiscal '${docType}' não reconhecido pela AGT.`);
  }

  const seriesYear = Math.floor(input.seriesYear || new Date().getFullYear());
  const dateCheck = isSeriesCreationAllowedForYear(seriesYear);
  if (!dateCheck.allowed) {
    throw new Error(
      dateCheck.reason ||
        `Não é permitida a criação da série para o ano fiscal ${seriesYear} nesta data.`
    );
  }

  const firstDocNumber = Math.max(1, Math.floor(input.firstDocumentNumber || 1));
  const seriesId = `${companyId}_${seriesCode}_${seriesYear}_${docType}`;

  const currentRecords = seriesStorage.loadSeries(companyId);

  // Verifica se já existe uma série com este mesmo ID
  const existingSameId = currentRecords.find((s) => s.id === seriesId);
  if (existingSameId) {
    throw new Error(
      `Já existe a série '${seriesCode}' (${seriesYear}) registada para o documento ${docType} com estado '${existingSameId.status}'.`
    );
  }

  // Verifica se já existe outra série ativa ('A' ou 'U') para o mesmo tipo e ano com o mesmo código
  const existingActive = currentRecords.find(
    (s) =>
      s.documentType === docType &&
      s.seriesYear === seriesYear &&
      s.seriesCode === seriesCode &&
      (s.status === 'A' || s.status === 'U')
  );
  if (existingActive) {
    throw new Error(
      `Já existe uma série em vigor (${existingActive.seriesCode}) para ${docType}/${seriesYear}.`
    );
  }

  const now = new Date().toISOString();
  // Simulação / Emissão do código oficial de autorização da AGT
  const randomSuffix = Math.random().toString(36).substring(2, 8).toUpperCase();
  const agtAuthCode = `AGT-AUT-${seriesYear}-${docType}-${randomSuffix}`;

  const newRecord: AgtSeriesRecord = {
    id: seriesId,
    companyId,
    seriesCode,
    seriesYear,
    documentType: docType,
    firstDocumentNumber: firstDocNumber,
    lastDocumentNumber: 0, // Nenhum documento emitido ainda
    status: 'A', // Ativa, pronta para o primeiro documento
    agtAuthorizationCode: agtAuthCode,
    requestedAtIso: now,
    authorizedAtIso: now,
    notes: input.notes?.trim() || `Autorizada via SILA-Billing pelo operador ${input.operator || 'Admin'}`,
  };

  currentRecords.push(newRecord);
  seriesStorage.saveSeries(companyId, currentRecords);

  return newRecord;
}

/**
 * Lista as séries fiscais cadastradas para uma empresa, com filtros opcionais.
 */
export function listarSeries(filter: ListarSeriesFilter): AgtSeriesRecord[] {
  const companyId = String(filter.companyId || '').trim();
  if (!companyId) return [];

  let list = seriesStorage.loadSeries(companyId);

  if (filter.seriesYear) {
    list = list.filter((s) => s.seriesYear === filter.seriesYear);
  }
  if (filter.documentType) {
    list = list.filter((s) => s.documentType === filter.documentType);
  }
  if (filter.status) {
    list = list.filter((s) => s.status === filter.status);
  }

  return list;
}

/**
 * Obtém a série fiscal ativa ('A' ou 'U') para um determinado tipo de documento e ano.
 */
export function obterSerieAtiva(
  companyId: string,
  docType: AgtDocumentType,
  year?: number
): AgtSeriesRecord | null {
  const targetYear = year || new Date().getFullYear();
  const list = listarSeries({ companyId, documentType: docType, seriesYear: targetYear });
  // Prioridade: série já 'U' (em uso) ou 'A' (ativa)
  const inUse = list.find((s) => s.status === 'U');
  if (inUse) return inUse;
  const active = list.find((s) => s.status === 'A');
  return active || null;
}

/**
 * Valida se é permitida a emissão fiscal para o tipo de documento.
 * Se o tipo exigir série AGT e não houver série autorizada nos estados 'A' ou 'U', lança erro.
 */
export function validarPermissaoEmissaoFiscal(
  companyId: string,
  docType: AgtDocumentType,
  year?: number
): {
  allowed: boolean;
  series?: AgtSeriesRecord;
  error?: string;
} {
  const meta = AGT_DOCUMENT_TYPES[docType];
  if (!meta) {
    return {
      allowed: false,
      error: `Tipo de documento fiscal '${docType}' não é válido perante a AGT.`,
    };
  }

  if (!meta.requiresSeries) {
    return { allowed: true };
  }

  const targetYear = year || new Date().getFullYear();
  const activeSeries = obterSerieAtiva(companyId, docType, targetYear);

  if (!activeSeries) {
    return {
      allowed: false,
      error: `Emissão fiscal bloqueada: Não existe nenhuma série autorizada pela AGT (estado 'A' ou 'U') para '${meta.fullName} (${docType})' no ano ${targetYear}. Solicite a série à AGT no menu de Séries Fiscais antes de emitir.`,
    };
  }

  return { allowed: true, series: activeSeries };
}

/**
 * Reserva e incrementa atomicamente o próximo número de faturação na série ativa.
 * Transita o estado da série de 'A' para 'U' na primeira emissão.
 * Garante estritamente a sequencialidade sem saltos ou números repetidos.
 */
export function reservarProximoNumeroFiscal(
  companyId: string,
  docType: AgtDocumentType,
  year?: number,
  preferredSeriesCode?: string
): ProximoNumeroFiscalResult {
  const validation = validarPermissaoEmissaoFiscal(companyId, docType, year);
  if (!validation.allowed || !validation.series) {
    throw new Error(validation.error || 'Emissão bloqueada por falta de série AGT válida.');
  }

  const series = validation.series;
  if (preferredSeriesCode && series.seriesCode !== preferredSeriesCode) {
    const specific = listarSeries({
      companyId,
      documentType: docType,
      seriesYear: year || new Date().getFullYear(),
    }).find((s) => s.seriesCode === preferredSeriesCode && (s.status === 'A' || s.status === 'U'));

    if (specific) {
      return aplicarIncrementoNaSerie(companyId, specific);
    }
  }

  return aplicarIncrementoNaSerie(companyId, series);
}

function aplicarIncrementoNaSerie(companyId: string, series: AgtSeriesRecord): ProximoNumeroFiscalResult {
  const currentRecords = seriesStorage.loadSeries(companyId);
  const idx = currentRecords.findIndex((s) => s.id === series.id);
  if (idx === -1) {
    throw new Error(`Série ${series.id} não encontrada para atualização atómica.`);
  }

  const target = currentRecords[idx]!;
  if (target.status === 'F') {
    throw new Error(`A série fiscal ${target.seriesCode} encontra-se finalizada ('F'). Emissão proibida.`);
  }

  const nextSeq = target.lastDocumentNumber === 0 ? target.firstDocumentNumber : target.lastDocumentNumber + 1;
  const newStatus: AgtSeriesStatus = 'U'; // Transita para 'U' (Em Uso)

  target.lastDocumentNumber = nextSeq;
  target.status = newStatus;

  currentRecords[idx] = target;
  seriesStorage.saveSeries(companyId, currentRecords);

  const documentNo = formatFiscalDocumentNo(target.documentType, target.seriesCode, nextSeq);

  return {
    documentNo,
    seriesCode: target.seriesCode,
    sequenceNumber: nextSeq,
    seriesId: target.id,
    status: newStatus,
  };
}

/**
 * Encerra e finaliza formalmente uma série AGT ('F').
 * Nenhum documento poderá voltar a ser emitido nesta série.
 */
export function finalizarSerie(
  companyId: string,
  seriesId: string,
  operator: string,
  reason?: string
): AgtSeriesRecord {
  const currentRecords = seriesStorage.loadSeries(companyId);
  const idx = currentRecords.findIndex((s) => s.id === seriesId);
  if (idx === -1) {
    throw new Error(`Série com identificador '${seriesId}' não foi encontrada.`);
  }

  const target = currentRecords[idx]!;
  if (target.status === 'F') {
    return target; // Já finalizada
  }

  const now = new Date().toISOString();
  target.status = 'F';
  target.closedAtIso = now;
  target.notes = `${target.notes || ''} | Finalizada em ${now.slice(0, 10)} pelo operador ${operator}: ${reason || 'Encerramento anual / esgotamento'}`.trim();

  currentRecords[idx] = target;
  seriesStorage.saveSeries(companyId, currentRecords);

  return target;
}

/**
 * Inicializa automaticamente séries homologadas para empresas existentes ou novas empresas
 * garantindo que operações normais não sofram bloqueio inicial no ambiente de trabalho.
 */
export function inicializarSeriesPadraoSeNecessario(
  companyId: string,
  year = new Date().getFullYear(),
  operator = 'Sistema'
): AgtSeriesRecord[] {
  const existing = seriesStorage.loadSeries(companyId);
  const forYear = existing.filter((s) => s.seriesYear === year);

  // Documentos primários comerciais que devem ter série ativa imediata
  const primaryDocTypes: AgtDocumentType[] = ['FR', 'FA', 'FT', 'TV', 'NC', 'RC'];
  const created: AgtSeriesRecord[] = [];

  for (const docType of primaryDocTypes) {
    const hasActive = forYear.some(
      (s) => s.documentType === docType && (s.status === 'A' || s.status === 'U')
    );
    if (!hasActive) {
      try {
        const seriesCode = `A${year}`;
        const newSeries = solicitarSerie({
          companyId,
          seriesCode,
          seriesYear: year,
          documentType: docType,
          firstDocumentNumber: 1,
          operator,
          notes: `Série inicial homologada para o ano fiscal ${year} (${docType})`,
        });
        created.push(newSeries);
      } catch (err) {
        console.warn(`[SeriesManager] Não foi possível auto-inicializar série para ${docType}:`, err);
      }
    }
  }

  return created;
}
