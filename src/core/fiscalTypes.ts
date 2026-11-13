/**
 * SILA-Billing — Dados de Referência e Tipagem Fiscal Angolana
 * Em conformidade com o Decreto Executivo n.º 683/25 e Decreto Presidencial n.º 71/25.
 * 
 * Regra: Dados de referência oficiais centralizados, imutáveis e auditáveis,
 * sem dispersão de códigos fiscais pelo código-fonte.
 */

// ============================================================================
// 1. TIPOS DE DOCUMENTOS OFICIAIS AGT
// ============================================================================

export type AgtDocumentType =
  | 'FA' // Factura
  | 'FT' // Factura de Transporte
  | 'FR' // Factura / Recibo
  | 'FG' // Factura Global
  | 'AC' // Aviso de Cobrança
  | 'AR' // Aviso de Recebimento
  | 'TV' // Talão de Venda
  | 'RC' // Recibo
  | 'RG' // Recibo Global
  | 'RE' // Recibo de Estorno
  | 'ND' // Nota de Débito
  | 'NC' // Nota de Crédito
  | 'AF' // Autofacturação
  | 'RP' // Recibo Provisório
  | 'RA' // Recibo de Adiantamento
  | 'CS' // Comprovativo de Saída
  | 'LD'; // Liquidação de Dívida

export type AgtDocumentCategory =
  | 'facturacao' // Faturas e Vendas com débito ao cliente
  | 'rectificacao' // Notas de crédito, débito e estornos
  | 'cobranca' // Recibos e liquidações de conta corrente
  | 'transporte_saida' // Guias, transportes e saídas de armazém
  | 'provisorio'; // Proformas, avisos e comprovativos sem valor de quitação final

export interface AgtDocumentTypeMetadata {
  code: AgtDocumentType;
  shortName: string;
  fullName: string;
  category: AgtDocumentCategory;
  isFiscalInvoice: boolean; // Gera débito de IVA/imposto fiscal
  requiresSeries: boolean; // Exige obrigatoriamente série aprovada AGT
  affectsStock: boolean; // Movimenta saídas ou devoluções de inventário
  requiresOriginReference: boolean; // Exige menção a documento anterior (ex: NC, ND, RE)
  allowsImmediateReceipt: boolean; // Permite quitação imediata na emissão (ex: FR, TV, RC)
}

export const AGT_DOCUMENT_TYPES: Readonly<Record<AgtDocumentType, AgtDocumentTypeMetadata>> = {
  FA: {
    code: 'FA',
    shortName: 'Factura',
    fullName: 'Factura a Prazo / Comercial',
    category: 'facturacao',
    isFiscalInvoice: true,
    requiresSeries: true,
    affectsStock: true,
    requiresOriginReference: false,
    allowsImmediateReceipt: false,
  },
  FT: {
    code: 'FT',
    shortName: 'Factura de Transporte',
    fullName: 'Factura de Transporte / Frete',
    category: 'facturacao',
    isFiscalInvoice: true,
    requiresSeries: true,
    affectsStock: false,
    requiresOriginReference: false,
    allowsImmediateReceipt: false,
  },
  FR: {
    code: 'FR',
    shortName: 'Factura/Recibo',
    fullName: 'Factura / Recibo com Pagamento Pronto',
    category: 'facturacao',
    isFiscalInvoice: true,
    requiresSeries: true,
    affectsStock: true,
    requiresOriginReference: false,
    allowsImmediateReceipt: true,
  },
  FG: {
    code: 'FG',
    shortName: 'Factura Global',
    fullName: 'Factura Global Consolidada de Período',
    category: 'facturacao',
    isFiscalInvoice: true,
    requiresSeries: true,
    affectsStock: false,
    requiresOriginReference: true,
    allowsImmediateReceipt: false,
  },
  AC: {
    code: 'AC',
    shortName: 'Aviso de Cobrança',
    fullName: 'Aviso de Cobrança / Solicitação de Pagamento',
    category: 'cobranca',
    isFiscalInvoice: false,
    requiresSeries: true,
    affectsStock: false,
    requiresOriginReference: true,
    allowsImmediateReceipt: false,
  },
  AR: {
    code: 'AR',
    shortName: 'Aviso de Recebimento',
    fullName: 'Aviso de Recebimento Postal / Entrega',
    category: 'cobranca',
    isFiscalInvoice: false,
    requiresSeries: false,
    affectsStock: false,
    requiresOriginReference: true,
    allowsImmediateReceipt: false,
  },
  TV: {
    code: 'TV',
    shortName: 'Talão de Venda',
    fullName: 'Talão de Venda a Dinheiro (Retalho)',
    category: 'facturacao',
    isFiscalInvoice: true,
    requiresSeries: true,
    affectsStock: true,
    requiresOriginReference: false,
    allowsImmediateReceipt: true,
  },
  RC: {
    code: 'RC',
    shortName: 'Recibo',
    fullName: 'Recibo de Quitação Fiscal',
    category: 'cobranca',
    isFiscalInvoice: false,
    requiresSeries: true,
    affectsStock: false,
    requiresOriginReference: true,
    allowsImmediateReceipt: true,
  },
  RG: {
    code: 'RG',
    shortName: 'Recibo Global',
    fullName: 'Recibo Global Consolidado',
    category: 'cobranca',
    isFiscalInvoice: false,
    requiresSeries: true,
    affectsStock: false,
    requiresOriginReference: true,
    allowsImmediateReceipt: true,
  },
  RE: {
    code: 'RE',
    shortName: 'Recibo de Estorno',
    fullName: 'Recibo de Estorno / Reversão Financeira',
    category: 'rectificacao',
    isFiscalInvoice: false,
    requiresSeries: true,
    affectsStock: false,
    requiresOriginReference: true,
    allowsImmediateReceipt: true,
  },
  ND: {
    code: 'ND',
    shortName: 'Nota de Débito',
    fullName: 'Nota de Débito (Agravamento / Ajuste a Débito)',
    category: 'rectificacao',
    isFiscalInvoice: true,
    requiresSeries: true,
    affectsStock: false,
    requiresOriginReference: true,
    allowsImmediateReceipt: false,
  },
  NC: {
    code: 'NC',
    shortName: 'Nota de Crédito',
    fullName: 'Nota de Crédito (Devolução / Anulação Parcial ou Total)',
    category: 'rectificacao',
    isFiscalInvoice: true,
    requiresSeries: true,
    affectsStock: true,
    requiresOriginReference: true,
    allowsImmediateReceipt: false,
  },
  AF: {
    code: 'AF',
    shortName: 'Autofacturação',
    fullName: 'Documento de Autofacturação a Fornecedores Particulares',
    category: 'facturacao',
    isFiscalInvoice: true,
    requiresSeries: true,
    affectsStock: true,
    requiresOriginReference: false,
    allowsImmediateReceipt: true,
  },
  RP: {
    code: 'RP',
    shortName: 'Recibo Provisório',
    fullName: 'Recibo Provisório de Caixa',
    category: 'provisorio',
    isFiscalInvoice: false,
    requiresSeries: true,
    affectsStock: false,
    requiresOriginReference: false,
    allowsImmediateReceipt: true,
  },
  RA: {
    code: 'RA',
    shortName: 'Recibo de Adiantamento',
    fullName: 'Recibo de Adiantamento / Sinal de Clientes',
    category: 'cobranca',
    isFiscalInvoice: false,
    requiresSeries: true,
    affectsStock: false,
    requiresOriginReference: false,
    allowsImmediateReceipt: true,
  },
  CS: {
    code: 'CS',
    shortName: 'Comprovativo de Saída',
    fullName: 'Comprovativo de Saída de Mercadorias / Guia',
    category: 'transporte_saida',
    isFiscalInvoice: false,
    requiresSeries: true,
    affectsStock: true,
    requiresOriginReference: false,
    allowsImmediateReceipt: false,
  },
  LD: {
    code: 'LD',
    shortName: 'Liquidação de Dívida',
    fullName: 'Liquidação de Dívida / Regularização de Conta Corrente',
    category: 'cobranca',
    isFiscalInvoice: false,
    requiresSeries: true,
    affectsStock: false,
    requiresOriginReference: true,
    allowsImmediateReceipt: true,
  },
};

// ============================================================================
// 2. ESTADOS FISCAIS DE DOCUMENTO (AGT)
// ============================================================================

export type AgtDocumentStatus =
  | 'N' // Normal: Documento emitido regularmente em condições normais
  | 'S' // Autofacturação: Documento de autofacturação emitido em nome de terceiro
  | 'A' // Anulado: Documento fiscal anulado formalmente com registo auditado
  | 'R' // Resumo: Documento emitido em sumário de períodos anteriores
  | 'C'; // Contingência: Emitido em modo de contingência por quebra de rede/serviço

export interface AgtDocumentStatusMetadata {
  code: AgtDocumentStatus;
  labelPt: string;
  description: string;
  isImmutable: boolean; // Após atingir este estado não pode ser editado
  requiresReason: boolean; // Exige justificação detalhada auditada
}

export const AGT_DOCUMENT_STATUSES: Readonly<Record<AgtDocumentStatus, AgtDocumentStatusMetadata>> = {
  N: {
    code: 'N',
    labelPt: 'Normal',
    description: 'Documento original emitido de forma regular e sequencial.',
    isImmutable: true,
    requiresReason: false,
  },
  S: {
    code: 'S',
    labelPt: 'Autofacturação',
    description: 'Documento de autofacturação emitido pelo adquirente em nome de produtor/fornecedor singular.',
    isImmutable: true,
    requiresReason: false,
  },
  A: {
    code: 'A',
    labelPt: 'Anulado',
    description: 'Documento anulado formalmente. Mantém numeração original, registo do operador e motivo legal.',
    isImmutable: true,
    requiresReason: true,
  },
  R: {
    code: 'R',
    labelPt: 'Resumo / Substituído',
    description: 'Documento consolidado de resumo ou substituído por rectificação aprovada.',
    isImmutable: true,
    requiresReason: true,
  },
  C: {
    code: 'C',
    labelPt: 'Contingência',
    description: 'Documento emitido no regime legal de contingência por quebra comprovada de comunicação com a AGT.',
    isImmutable: true,
    requiresReason: true,
  },
};

// ============================================================================
// 3. GESTÃO DE SÉRIES AGT
// ============================================================================

export type AgtSeriesStatus =
  | 'A' // Ativa: Série solicitada e autorizada pela AGT, pronta para emissão
  | 'U' // Utilizada / Em Uso: Série que já possui documentos emitidos na sequência corrente
  | 'F'; // Finalizada / Fechada: Série esgotada ou encerrada formalmente no final do ano civil

export type AgtSeriesEnvironment = 'SIMULACAO' | 'PRODUCAO';

export interface AgtSeriesRecord {
  id: string; // `${companyId}_${seriesCode}_${seriesYear}_${documentType}`
  companyId: string;
  seriesCode: string; // Ex: 'A2026', 'SERIE1'
  seriesYear: number; // Ex: 2026
  documentType: AgtDocumentType;
  firstDocumentNumber: number; // Geralmente 1
  lastDocumentNumber: number; // Número do último documento emitido nesta série
  status: AgtSeriesStatus;
  environment?: AgtSeriesEnvironment; // Separação estrita: SIMULACAO vs PRODUCAO
  establishmentId?: string; // Estabelecimento associado à série
  establishmentCode?: string; // Código curto do estabelecimento (ex: '001')
  agtAuthorizationCode?: string; // Código de autorização fornecido pela AGT
  requestedAtIso: string;
  authorizedAtIso?: string;
  closedAtIso?: string;
  notes?: string;
}

/**
 * Valida a regra temporal da AGT:
 * Séries para um novo ano fiscal só podem ser formalmente solicitadas
 * a partir de 15 de Dezembro do ano anterior ou durante o próprio ano fiscal.
 */
export function isSeriesCreationAllowedForYear(targetYear: number, referenceDate = new Date()): {
  allowed: boolean;
  reason?: string;
} {
  const currentYear = referenceDate.getFullYear();
  const currentMonth = referenceDate.getMonth(); // 0-indexed: 11 = Dezembro
  const currentDay = referenceDate.getDate();

  if (targetYear < currentYear) {
    return {
      allowed: false,
      reason: `Não é permitido abrir séries para anos fiscais transatos (${targetYear}).`,
    };
  }

  if (targetYear === currentYear) {
    return { allowed: true };
  }

  if (targetYear === currentYear + 1) {
    const isAfter15Dec = currentMonth === 11 && currentDay >= 15;
    if (!isAfter15Dec) {
      return {
        allowed: false,
        reason: `Séries para o ano seguinte (${targetYear}) só podem ser criadas a partir de 15 de Dezembro de ${currentYear}.`,
      };
    }
    return { allowed: true };
  }

  return {
    allowed: false,
    reason: `Não é permitido solicitar séries com mais de um ano de antecedência (${targetYear}).`,
  };
}

// ============================================================================
// 4. TAXAS DE IVA E CÓDIGOS TRIBUTÁRIOS OFICIAIS
// ============================================================================

export type AgtIvaTaxCode =
  | 'NOR' // Taxa Normal: 14%
  | 'INT' // Taxa Intermédia: 7% ou 5%
  | 'RED' // Taxa Reduzida: 5% ou 2%
  | 'ISE' // Isenta: 0%
  | 'OUT'; // Outra / Regimes especiais

export interface AgtIvaTaxMetadata {
  code: AgtIvaTaxCode;
  descriptionPt: string;
  standardPercentage: number;
  allowedPercentages: readonly number[];
  requiresExemptionCode: boolean;
}

export const AGT_IVA_TAX_CODES: Readonly<Record<AgtIvaTaxCode, AgtIvaTaxMetadata>> = {
  NOR: {
    code: 'NOR',
    descriptionPt: 'Taxa Normal de IVA (14%)',
    standardPercentage: 14,
    allowedPercentages: [14],
    requiresExemptionCode: false,
  },
  INT: {
    code: 'INT',
    descriptionPt: 'Taxa Intermédia / Especial (7% ou 1% Cabinda - Lei n.º 14/23)',
    standardPercentage: 7,
    allowedPercentages: [7, 5, 1],
    requiresExemptionCode: false,
  },
  RED: {
    code: 'RED',
    descriptionPt: 'Taxa Reduzida de IVA (5% ou 2%)',
    standardPercentage: 5,
    allowedPercentages: [5, 2],
    requiresExemptionCode: false,
  },
  ISE: {
    code: 'ISE',
    descriptionPt: 'Isento de IVA (0%)',
    standardPercentage: 0,
    allowedPercentages: [0],
    requiresExemptionCode: true,
  },
  OUT: {
    code: 'OUT',
    descriptionPt: 'Outras Taxas / Regimes Especiais',
    standardPercentage: 0,
    allowedPercentages: [0, 2, 5, 7, 14],
    requiresExemptionCode: true,
  },
};

// ============================================================================
// 5. CÓDIGOS OFICIAIS DE ISENÇÃO E NÃO SUJEIÇÃO DE IVA (AGT)
// ============================================================================

export type AgtIvaExemptionCode =
  // Isenções Gerais e Operações Internas (M10 a M24)
  | 'M10' // Bens da Cesta Básica (Art.º 12.º, al. a) do CIVA)
  | 'M11' // Medicamentos e Produtos Farmacêuticos (Art.º 12.º, al. b))
  | 'M12' // Livros, Jornais e Publicações Periódicas (Art.º 12.º, al. c))
  | 'M13' // Locação de Bens Imóveis para Habitação (Art.º 12.º, al. d))
  | 'M14' // Serviços Médicos e Sanitários (Art.º 12.º, al. e))
  | 'M15' // Serviços de Educação e Formação Profissional (Art.º 12.º, al. f))
  | 'M16' // Transportes Coletivos Urbanos de Passageiros (Art.º 12.º, al. g))
  | 'M17' // Bens e Equipamentos Petrolíferos e Mineiros
  | 'M18' // Transmissão de Estabelecimento Comercial (Art.º 3.º, n.º 6)
  | 'M19' // Amostras e Ofertas de Pequeno Valor (Art.º 3.º, n.º 7)
  | 'M20' // Operações de Exportação e Equiparadas (Art.º 14.º do CIVA)
  | 'M21' // Transportes Internacionais de Mercadorias / Passageiros
  | 'M22' // Serviços Conexos com Exportações
  | 'M23' // Isenção diplomática e consular
  | 'M24' // Fornecimentos a forças armadas / tratados internacionais
  // Isenções Financeiras e Seguros (M30 a M38)
  | 'M30' // Operações Bancárias e Financeiras sem comissão explícita
  | 'M31' // Operações de Seguro e Resseguro
  | 'M32' // Concessão e Negociação de Créditos
  | 'M33' // Gestão de Fundos de Investimento
  | 'M34' // Negociação de Títulos e Valores Mobiliários
  | 'M35' // Ouro e Moeda com curso legal
  | 'M36' // Serviços Postais Públicos
  | 'M37' // Jogos de Fortuna e Azar / Loterias
  | 'M38' // Actividades Culturais, Desportivas e Recreativas sem fins lucrativos
  // Regimes de Enquadramento Tributário (M80 a M86)
  | 'M80' // Regime de Exclusão do IVA (Art.º 16.º do CIVA)
  | 'M81' // Regime Simplificado do IVA (Pequenos Contribuintes)
  | 'M82' // Não Sujeição - Entidades Públicas e Autarquias
  | 'M83' // Não Sujeição - Operações fora do âmbito do CIVA
  | 'M84' // Regime Especial de Tributação dos Combustíveis
  | 'M85' // Regime Especial de Diamantes
  | 'M86' // Pequenos Agricultores e Produtores Singulares
  // Outras Isenções e Regimes Especiais (M90 a M93, M00, M02, M04)
  | 'M90' // Outras Isenções com direito à dedução
  | 'M91' // Outras Isenções sem direito à dedução
  | 'M92' // Isenção ao abrigo de Acordo / Lei Especial
  | 'M93' // Isenção de IVA para Zonas Francas / Pólos de Desenvolvimento
  | 'M00' // IVA - Não Sujeito / Isenção Geral
  | 'M02' // IVA - Autoliquidação (Inversão do Sujeito Passivo)
  | 'M04'; // IVA - Margem de Lucro (Bens em Segunda Mão)

export interface AgtIvaExemptionMetadata {
  code: AgtIvaExemptionCode;
  legalBasis: string;
  descriptionPt: string;
  category: 'cesta_basica' | 'saude_educacao' | 'exportacao' | 'financeiro' | 'regime_exclusao' | 'outros';
}

export const AGT_IVA_EXEMPTION_CODES: Readonly<Record<AgtIvaExemptionCode, AgtIvaExemptionMetadata>> = {
  M10: {
    code: 'M10',
    legalBasis: 'Art.º 12.º, alínea a) do CIVA',
    descriptionPt: 'Isento nos termos da Lei do IVA (Bens da Cesta Básica)',
    category: 'cesta_basica',
  },
  M11: {
    code: 'M11',
    legalBasis: 'Art.º 12.º, alínea b) do CIVA',
    descriptionPt: 'Isento nos termos da Lei do IVA (Medicamentos e Produtos Farmacêuticos)',
    category: 'saude_educacao',
  },
  M12: {
    code: 'M12',
    legalBasis: 'Art.º 12.º, alínea c) do CIVA',
    descriptionPt: 'Isento nos termos da Lei do IVA (Livros, Jornais e Publicações)',
    category: 'saude_educacao',
  },
  M13: {
    code: 'M13',
    legalBasis: 'Art.º 12.º, alínea d) do CIVA',
    descriptionPt: 'Isento nos termos da Lei do IVA (Locação de Imóveis Habitacionais)',
    category: 'outros',
  },
  M14: {
    code: 'M14',
    legalBasis: 'Art.º 12.º, alínea e) do CIVA',
    descriptionPt: 'Isento nos termos da Lei do IVA (Prestações de Serviços Médicos e Sanitários)',
    category: 'saude_educacao',
  },
  M15: {
    code: 'M15',
    legalBasis: 'Art.º 12.º, alínea f) do CIVA',
    descriptionPt: 'Isento nos termos da Lei do IVA (Serviços de Educação e Ensino)',
    category: 'saude_educacao',
  },
  M16: {
    code: 'M16',
    legalBasis: 'Art.º 12.º, alínea g) do CIVA',
    descriptionPt: 'Isento nos termos da Lei do IVA (Transporte Colectivo de Passageiros)',
    category: 'outros',
  },
  M17: {
    code: 'M17',
    legalBasis: 'Art.º 12.º, alínea h) do CIVA',
    descriptionPt: 'Isento nos termos da Lei do IVA (Equipamentos do Sector Petrolífero e Mineiro)',
    category: 'outros',
  },
  M18: {
    code: 'M18',
    legalBasis: 'Art.º 3.º, n.º 6 do CIVA',
    descriptionPt: 'Isento nos termos do CIVA (Cessão / Transmissão de Estabelecimento)',
    category: 'outros',
  },
  M19: {
    code: 'M19',
    legalBasis: 'Art.º 3.º, n.º 7 do CIVA',
    descriptionPt: 'Isento nos termos do CIVA (Amostras e Ofertas Comerciais de Reduzido Valor)',
    category: 'outros',
  },
  M20: {
    code: 'M20',
    legalBasis: 'Art.º 14.º do CIVA',
    descriptionPt: 'Isenção na Exportação de Bens e Operações Assemelhadas',
    category: 'exportacao',
  },
  M21: {
    code: 'M21',
    legalBasis: 'Art.º 14.º, n.º 2 do CIVA',
    descriptionPt: 'Isenção em Transportes Internacionais de Mercadorias / Passageiros',
    category: 'exportacao',
  },
  M22: {
    code: 'M22',
    legalBasis: 'Art.º 14.º, n.º 3 do CIVA',
    descriptionPt: 'Isenção em Serviços Conexos com a Exportação',
    category: 'exportacao',
  },
  M23: {
    code: 'M23',
    legalBasis: 'Art.º 15.º do CIVA',
    descriptionPt: 'Isenção Diplomática, Consular e Organismos Internacionais',
    category: 'outros',
  },
  M24: {
    code: 'M24',
    legalBasis: 'Art.º 15.º, n.º 2 do CIVA',
    descriptionPt: 'Isenção ao abrigo de Acordos Internacionais de Defesa e Segurança',
    category: 'outros',
  },
  M30: {
    code: 'M30',
    legalBasis: 'Art.º 12.º, alínea i) do CIVA',
    descriptionPt: 'Isenção em Operações Bancárias e Financeiras sem comissão explícita',
    category: 'financeiro',
  },
  M31: {
    code: 'M31',
    legalBasis: 'Art.º 12.º, alínea j) do CIVA',
    descriptionPt: 'Isenção em Operações de Seguro e Resseguro',
    category: 'financeiro',
  },
  M32: {
    code: 'M32',
    legalBasis: 'Art.º 12.º, alínea k) do CIVA',
    descriptionPt: 'Isenção na Concessão e Negociação de Crédito',
    category: 'financeiro',
  },
  M33: {
    code: 'M33',
    legalBasis: 'Art.º 12.º, alínea l) do CIVA',
    descriptionPt: 'Isenção na Gestão de Fundos de Investimento',
    category: 'financeiro',
  },
  M34: {
    code: 'M34',
    legalBasis: 'Art.º 12.º, alínea m) do CIVA',
    descriptionPt: 'Isenção na Negociação de Títulos e Valores Mobiliários',
    category: 'financeiro',
  },
  M35: {
    code: 'M35',
    legalBasis: 'Art.º 12.º, alínea n) do CIVA',
    descriptionPt: 'Isenção em Ouro e Moeda com Curso Legal',
    category: 'financeiro',
  },
  M36: {
    code: 'M36',
    legalBasis: 'Art.º 12.º, alínea o) do CIVA',
    descriptionPt: 'Isenção em Serviços Postais Oficiais',
    category: 'outros',
  },
  M37: {
    code: 'M37',
    legalBasis: 'Art.º 12.º, alínea p) do CIVA',
    descriptionPt: 'Isenção em Jogos de Fortuna e Azar e Apostas Mútuas',
    category: 'outros',
  },
  M38: {
    code: 'M38',
    legalBasis: 'Art.º 12.º, alínea q) do CIVA',
    descriptionPt: 'Isenção em Actividades Culturais e Desportivas sem fins lucrativos',
    category: 'outros',
  },
  M80: {
    code: 'M80',
    legalBasis: 'Art.º 16.º do CIVA',
    descriptionPt: 'Regime de Exclusão do IVA (Facturação sem incidência de imposto)',
    category: 'regime_exclusao',
  },
  M81: {
    code: 'M81',
    legalBasis: 'Art.º 17.º do CIVA',
    descriptionPt: 'Regime Simplificado do IVA (Pequenos Contribuintes)',
    category: 'regime_exclusao',
  },
  M82: {
    code: 'M82',
    legalBasis: 'Art.º 2.º, n.º 2 do CIVA',
    descriptionPt: 'Não Sujeição de IVA - Entidades Públicas e Autarquias',
    category: 'outros',
  },
  M83: {
    code: 'M83',
    legalBasis: 'Art.º 2.º do CIVA',
    descriptionPt: 'Não Sujeição de IVA - Operações fora do âmbito de incidência do imposto',
    category: 'outros',
  },
  M84: {
    code: 'M84',
    legalBasis: 'Regime Especial dos Combustíveis',
    descriptionPt: 'Regime Especial de Tributação Monofásica dos Combustíveis',
    category: 'outros',
  },
  M85: {
    code: 'M85',
    legalBasis: 'Regime Especial dos Diamantes',
    descriptionPt: 'Regime Especial de Comercialização de Diamantes em Bruto',
    category: 'outros',
  },
  M86: {
    code: 'M86',
    legalBasis: 'Art.º 16.º-A do CIVA',
    descriptionPt: 'Isenção de IVA para Pequenos Produtores e Agricultores Singulares',
    category: 'regime_exclusao',
  },
  M90: {
    code: 'M90',
    legalBasis: 'Legislação Específica',
    descriptionPt: 'Outras Isenções com direito integral à dedução',
    category: 'outros',
  },
  M91: {
    code: 'M91',
    legalBasis: 'Legislação Específica',
    descriptionPt: 'Outras Isenções sem direito à dedução',
    category: 'outros',
  },
  M92: {
    code: 'M92',
    legalBasis: 'Lei Especial / Acordo de Investimento',
    descriptionPt: 'Isenção ao abrigo de Acordo de Investimento Privado Aprovado',
    category: 'outros',
  },
  M93: {
    code: 'M93',
    legalBasis: 'Lei das Zonas Francas',
    descriptionPt: 'Isenção de IVA em Zonas Francas e Pólos Industriais Especiais',
    category: 'outros',
  },
  M00: {
    code: 'M00',
    legalBasis: 'Código do IVA',
    descriptionPt: 'IVA - Não Sujeito / Isenção Geral Aplicável',
    category: 'outros',
  },
  M02: {
    code: 'M02',
    legalBasis: 'Art.º 2.º, n.º 1, al. e) do CIVA',
    descriptionPt: 'IVA - Autoliquidação (Inversão do Sujeito Passivo)',
    category: 'outros',
  },
  M04: {
    code: 'M04',
    legalBasis: 'Decreto Executivo 683/25',
    descriptionPt: 'IVA - Regime Especial de Tributação da Margem de Lucro',
    category: 'outros',
  },
};

// ============================================================================
// 6. CÓDIGOS DE IMPOSTO DO SELO (IS) E IEC
// ============================================================================

export type AgtStampTaxCode =
  | 'S01' // Recibos de quitação / Pagamentos
  | 'S02' // Operações de crédito e financiamento
  | 'S03' // Seguros e apólices
  | 'S04' // Garantias, fianças e cauções
  | 'S05' // Letras e livranças
  | 'S06' // Cheques e ordens de pagamento
  | 'S07'; // Outras operações sujeitas a Imposto do Selo

export interface AgtStampTaxMetadata {
  code: AgtStampTaxCode;
  descriptionPt: string;
  defaultRatePct?: number;
  fixedAmountKz?: number;
}

export const AGT_STAMP_TAX_CODES: Readonly<Record<AgtStampTaxCode, AgtStampTaxMetadata>> = {
  S01: {
    code: 'S01',
    descriptionPt: 'IS - Recibos de Quitação e Liquidação (1%)',
    defaultRatePct: 1,
  },
  S02: {
    code: 'S02',
    descriptionPt: 'IS - Operações de Crédito e Financiamento (0,1% a 0,5%)',
    defaultRatePct: 0.5,
  },
  S03: {
    code: 'S03',
    descriptionPt: 'IS - Contratos de Seguro e Apólices (0,5%)',
    defaultRatePct: 0.5,
  },
  S04: {
    code: 'S04',
    descriptionPt: 'IS - Garantias, Fianças e Cauções (0,3%)',
    defaultRatePct: 0.3,
  },
  S05: {
    code: 'S05',
    descriptionPt: 'IS - Letras e Livranças Comerciais (0,5%)',
    defaultRatePct: 0.5,
  },
  S06: {
    code: 'S06',
    descriptionPt: 'IS - Cheques e Ordens de Pagamento',
    fixedAmountKz: 50,
  },
  S07: {
    code: 'S07',
    descriptionPt: 'IS - Outros Actos e Operações Notariais/Registo',
    defaultRatePct: 1,
  },
};

export type AgtIecCategory =
  | 'BEBIDAS_ALCOOLICAS'
  | 'TABACO'
  | 'VEICULOS'
  | 'AERONAVES_EMBARCACOES'
  | 'COMBUSTIVEIS'
  | 'OUTROS_LUXO';

export interface AgtIecMetadata {
  code: string;
  category: AgtIecCategory;
  descriptionPt: string;
  ratePct: number;
}

export const DEFAULT_AGT_IEC_TABLE: Readonly<Record<string, AgtIecMetadata>> = {
  IEC_CERVEJA: {
    code: 'IEC_CERVEJA',
    category: 'BEBIDAS_ALCOOLICAS',
    descriptionPt: 'IEC - Cervejas de Malte (11%)',
    ratePct: 11,
  },
  IEC_VINHO: {
    code: 'IEC_VINHO',
    category: 'BEBIDAS_ALCOOLICAS',
    descriptionPt: 'IEC - Vinhos e Espumantes (15%)',
    ratePct: 15,
  },
  IEC_ESPIRITUOSAS: {
    code: 'IEC_ESPIRITUOSAS',
    category: 'BEBIDAS_ALCOOLICAS',
    descriptionPt: 'IEC - Bebidas Espirituosas e Licores (25%)',
    ratePct: 25,
  },
  IEC_TABACO: {
    code: 'IEC_TABACO',
    category: 'TABACO',
    descriptionPt: 'IEC - Tabaco, Charutos e Cigarrilhas (30%)',
    ratePct: 30,
  },
  IEC_VEICULOS_LUXO: {
    code: 'IEC_VEICULOS_LUXO',
    category: 'VEICULOS',
    descriptionPt: 'IEC - Viaturas Ligeiras de Alta Cilindrada (20%)',
    ratePct: 20,
  },
  IEC_EMBARCACOES: {
    code: 'IEC_EMBARCACOES',
    category: 'AERONAVES_EMBARCACOES',
    descriptionPt: 'IEC - Embarcações de Recreio e Iates (20%)',
    ratePct: 20,
  },
};

// ============================================================================
// 7. RETENÇÕES NA FONTE E IMPOSTOS ESPECIAIS
// ============================================================================

export type AgtWithholdingTaxType =
  | 'II' // Imposto Industrial (ex: 6.5% sobre serviços prestados por pessoas coletivas)
  | 'IRT' // Imposto sobre o Rendimento do Trabalho (ex: 10.5% ou tabela)
  | 'IVA_RET'; // Retenção na Fonte de IVA (50% ou 100% conforme sujeito passivo)

export interface AgtWithholdingTax {
  type: AgtWithholdingTaxType;
  ratePct: number;
  baseAmount: number;
  withheldAmount: number;
  reason?: string;
}

// ============================================================================
// 8. ESTRUTURA CANÓNICA DO DOCUMENTO AGT (CONFORME ESPECIFICAÇÃO DECRETO 683/25)
// ============================================================================

export interface AgtSoftwareInfo {
  softwareApprovalNumber: string; // Ex: '123/AGT/2026'
  softwareName: string; // 'SILA-Billing'
  softwareVersion: string; // '2.0.0'
  producerTaxID: string; // NIF da software house
}

export interface AgtDocumentLineItem {
  lineNumber: number;
  productCode: string;
  productDescription: string;
  quantity: number;
  unitOfMeasure: string;
  unitPrice: number; // Preço unitário sem imposto (ou com imposto assinalado)
  unitPriceIncludesTax: boolean;
  discountPercentage: number;
  discountAmount: number;
  taxableBase: number;
  taxContribution: number; // Arredondado por excesso ao cêntimo
  taxCode: AgtIvaTaxCode;
  taxPercentage: number;
  exemptionCode?: AgtIvaExemptionCode;
  stampTaxCode?: AgtStampTaxCode;
  stampTaxAmount?: number;
  iecCode?: string;
  iecAmount?: number;
  lineTotal: number;
}

export interface AgtDocumentTotals {
  merchandiseTotalNet: number; // Total de mercadorias líquido sem imposto
  totalDiscounts: number;
  totalTaxBaseNOR: number;
  totalTaxAmountNOR: number;
  totalTaxBaseINT: number;
  totalTaxAmountINT: number;
  totalTaxBaseRED: number;
  totalTaxAmountRED: number;
  totalTaxBaseISE: number;
  totalStampTax: number;
  totalIecTax: number;
  totalWithholdingTax: number;
  grossTotal: number;
  netPayableTotal: number;
  amountInWords: string;
}

export interface AgtDocumentPayload {
  submissionGUID: string; // UUID v4 único por contribuinte
  submissionID?: string;
  requestID?: string;
  documentNo: string; // Ex: 'FR A2026/000001'
  series: string; // Ex: 'A2026'
  documentType: AgtDocumentType;
  documentStatus: AgtDocumentStatus;
  documentDate: string; // YYYY-MM-DD
  systemEntryDate: string; // ISO 8601 UTC
  customerTaxID: string;
  customerCountry: string; // 'AO'
  customerName: string;
  companyName: string;
  companyTaxID: string;
  softwareInfo: AgtSoftwareInfo;
  lines: AgtDocumentLineItem[];
  documentTotals: AgtDocumentTotals;
  withholdingTaxList?: AgtWithholdingTax[];
  jwsSoftwareSignature?: string;
  jwsDocumentSignature?: string;
  jwsSignature?: string;
  qrPayload?: string;
  validationState?: AgtValidationState;
}

// ============================================================================
// 9. ESTADOS DE VALIDAÇÃO E COMUNICAÇÃO COM A AGT
// ============================================================================

export type AgtValidationState =
  | 'V' // Válido: Documento formalmente aceite e validado pelo motor fiscal da AGT
  | 'I' // Inválido: Documento rejeitado estruturalmente ou fiscalmente pela AGT
  | 'P'; // Pendente: Submetido para processamento assíncrono (aguardando consulta)

export interface AgtBatchSubmissionSummary {
  submissionGUID: string;
  batchSize: number; // Máximo 30 documentos por chamada
  submittedAtIso: string;
  status: 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'PARTIAL';
  requestID?: string;
  agtResponseCode?: number;
  documentValidationStates: Record<string, AgtValidationState>;
  rejectionErrors?: Array<{ documentNo: string; errorCode: string; message: string }>;
}
