import { Customer, InvoiceRecord, Product } from './types';

const DIACRITIC_FALLBACK_MAP: Record<string, string> = {
  á: 'a', à: 'a', â: 'a', ã: 'a', ä: 'a', å: 'a',
  é: 'e', è: 'e', ê: 'e', ë: 'e',
  í: 'i', ì: 'i', î: 'i', ï: 'i',
  ó: 'o', ò: 'o', ô: 'o', õ: 'o', ö: 'o',
  ú: 'u', ù: 'u', û: 'u', ü: 'u',
  ç: 'c', ñ: 'n', ý: 'y', ÿ: 'y',
};

/**
 * Remove acentos/diacríticos, pontuação irrelevante e espaços duplicados.
 * Compatível com motores antigos (Windows 7) e modernos (iOS / Android / Desktop).
 */
export function normalizeSearchText(raw: string): string {
  if (!raw) return '';
  let text = String(raw).toLowerCase();

  if (typeof text.normalize === 'function') {
    text = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  } else {
    text = text.replace(/[áàâãäåéèêëíìîïóòôõöúùûüçñýÿ]/g, (ch) => DIACRITIC_FALLBACK_MAP[ch] || ch);
  }

  return text
    .replace(/[,.;:/\\()[\]{}"'`´~^!@#$%&*+=|<>?_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Redução fonética e ortográfica leve para Português em Angola (pré e pós-AO90).
 * Ex.: facto <-> fato, contacto <-> contato, recepcao <-> rececao,
 * electrico <-> eletrico, optico <-> otico, accao <-> acao, sessao <-> sesao.
 */
export function foldOrthographyPt(normalized: string): string {
  if (!normalized) return '';
  return normalized
    .replace(/ph/g, 'f')
    .replace(/th/g, 't')
    .replace(/ct/g, 't')
    .replace(/cc/g, 'c')
    .replace(/pc/g, 'c')
    .replace(/pt/g, 't')
    .replace(/mn/g, 'n')
    .replace(/([a-z])\1+/g, '$1');
}

/**
 * Normaliza identificadores fiscais e telefónicos (NIF, telefone, número documental),
 * ignorando espaços, pontos, traços e parênteses.
 */
export function normalizeIdentifierSearch(raw: string): string {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[\s.\-/()]+/g, '');
}

/**
 * Extrai o núcleo numérico de telefones angolanos ignorando +244 / 00244
 * para permitir pesquisar "943671515" e encontrar "(+244) 943 671 515".
 */
function stripAngolaPhonePrefix(cleanId: string): string {
  const withoutPlus = cleanId.startsWith('+') ? cleanId.slice(1) : cleanId;
  if (withoutPlus.startsWith('00244') && withoutPlus.length >= 14) {
    return withoutPlus.slice(5);
  }
  if (withoutPlus.startsWith('244') && withoutPlus.length >= 12 && /^\d+$/.test(withoutPlus)) {
    return withoutPlus.slice(3);
  }
  return withoutPlus;
}

function matchesFormattedIdentifier(candidateRaw: string, queryRaw: string): boolean {
  const qId = normalizeIdentifierSearch(queryRaw);
  if (qId.length < 2) return false;
  const cId = normalizeIdentifierSearch(candidateRaw);
  if (!cId) return false;
  if (cId.includes(qId)) return true;

  const qPhone = stripAngolaPhonePrefix(qId);
  const cPhone = stripAngolaPhonePrefix(cId);
  return qPhone.length >= 3 && cPhone.includes(qPhone);
}

/**
 * Distância de edição (Levenshtein) com limite máximo e saída antecipada O(min(m,n)).
 */
export function boundedLevenshtein(a: string, b: string, maxDist: number): number {
  if (a === b) return 0;
  const lenA = a.length;
  const lenB = b.length;
  if (Math.abs(lenA - lenB) > maxDist) return maxDist + 1;
  if (lenA === 0) return lenB;
  if (lenB === 0) return lenA;

  // Garante lenA <= lenB para usar menos memória
  if (lenA > lenB) {
    return boundedLevenshtein(b, a, maxDist);
  }

  const prev = new Array<number>(lenA + 1);
  const curr = new Array<number>(lenA + 1);
  for (let i = 0; i <= lenA; i++) prev[i] = i;

  for (let j = 1; j <= lenB; j++) {
    curr[0] = j;
    let rowMin = curr[0];
    const chB = b.charCodeAt(j - 1);

    for (let i = 1; i <= lenA; i++) {
      const cost = a.charCodeAt(i - 1) === chB ? 0 : 1;
      const del = prev[i]! + 1;
      const ins = curr[i - 1]! + 1;
      const sub = prev[i - 1]! + cost;
      const val = del < ins ? (del < sub ? del : sub) : ins < sub ? ins : sub;
      curr[i] = val;
      if (val < rowMin) rowMin = val;
    }

    if (rowMin > maxDist) return maxDist + 1;
    for (let i = 0; i <= lenA; i++) prev[i] = curr[i]!;
  }

  return prev[lenA]!;
}

function tokenMatchesWordsWithTypo(
  qFoldedToken: string,
  candidateFoldedWords: string[],
  maxDist: number
): boolean {
  for (let i = 0; i < candidateFoldedWords.length; i++) {
    const word = candidateFoldedWords[i]!;
    if (!word) continue;
    if (word.includes(qFoldedToken)) return true;

    if (maxDist > 0 && qFoldedToken.length >= 4 && word.length >= 3) {
      if (boundedLevenshtein(qFoldedToken, word, maxDist) <= maxDist) {
        return true;
      }
      // Suporta palavras mais compridas enquanto o operador ainda está a digitar o prefixo
      if (word.length > qFoldedToken.length) {
        const prefix = word.slice(0, qFoldedToken.length);
        if (boundedLevenshtein(qFoldedToken, prefix, 1) <= 1) {
          return true;
        }
      }
    }
  }
  return false;
}

export interface SmartProductSearchResult {
  matches: Product[];
  suggestions: Product[];
  exactCodeMatch: Product | null;
}

/**
 * Pesquisa inteligente em cascata para artigos e serviços:
 * 1) Código exato (prioridade absoluta para leitores de código de barras e Enter rápido)
 * 2) Prefixo/subcadeia de código ou correspondência normalizada sem acentos
 * 3) Equivalência ortográfica angolana (facto/fato, contacto/contato, recepcao/rececao)
 * 4) Tolerância controlada a pequenos erros de digitação
 * 5) Até 3 sugestões próximas caso a pesquisa direta devolva 0 resultados
 */
export function searchProductsSmart(
  products: Product[],
  rawQuery: string
): SmartProductSearchResult {
  const trimmed = String(rawQuery || '').trim();
  if (!trimmed) {
    return { matches: products, suggestions: [], exactCodeMatch: null };
  }

  const rawLower = trimmed.toLowerCase();
  const qCompactCode = normalizeIdentifierSearch(trimmed);
  const qNorm = normalizeSearchText(trimmed);
  const qFolded = foldOrthographyPt(qNorm);
  const qTokens = qNorm ? qNorm.split(' ').filter(Boolean) : [];
  const qFoldedTokens = qFolded ? qFolded.split(' ').filter(Boolean) : [];

  let exactCodeMatch: Product | null = null;
  const scoredMatches: Array<{ product: Product; score: number }> = [];
  const suggestionCandidates: Array<{ product: Product; score: number }> = [];

  for (let idx = 0; idx < products.length; idx++) {
    const p = products[idx]!;
    const codeLower = String(p.code || '').trim().toLowerCase();
    const codeCompact = normalizeIdentifierSearch(p.code);

    if (
      (codeLower && codeLower === rawLower) ||
      (qCompactCode.length >= 2 && codeCompact === qCompactCode)
    ) {
      if (!exactCodeMatch) exactCodeMatch = p;
      scoredMatches.push({ product: p, score: 1000 });
      continue;
    }

    if (codeLower.startsWith(rawLower) || (qCompactCode.length >= 2 && codeCompact.startsWith(qCompactCode))) {
      scoredMatches.push({ product: p, score: 860 });
      continue;
    }

    if (codeLower.includes(rawLower) || (qCompactCode.length >= 3 && codeCompact.includes(qCompactCode))) {
      scoredMatches.push({ product: p, score: 760 });
      continue;
    }

    if (!qNorm) continue;

    const normName = normalizeSearchText(p.name);
    const normCat = normalizeSearchText(p.category || '');
    const normCode = normalizeSearchText(p.code);
    const fullNorm = `${normCode} ${normName} ${normCat}`.trim();

    if (normName.startsWith(qNorm)) {
      scoredMatches.push({ product: p, score: 700 });
      continue;
    }

    if (normName.includes(qNorm) || normCat.includes(qNorm)) {
      scoredMatches.push({ product: p, score: 640 });
      continue;
    }

    if (qTokens.length > 1 && qTokens.every((t) => fullNorm.includes(t))) {
      scoredMatches.push({ product: p, score: 580 });
      continue;
    }

    // Camada 2: Equivalência ortográfica PT-AO (ex.: facto <-> fato, contacto <-> contato)
    const foldedName = foldOrthographyPt(normName);
    const foldedCat = foldOrthographyPt(normCat);
    const fullFolded = `${normCode} ${foldedName} ${foldedCat}`.trim();

    if (qFolded && (foldedName.includes(qFolded) || foldedCat.includes(qFolded))) {
      scoredMatches.push({ product: p, score: 500 });
      continue;
    }

    if (qFoldedTokens.length > 0 && qFoldedTokens.every((ft) => fullFolded.includes(ft))) {
      scoredMatches.push({ product: p, score: 460 });
      continue;
    }

    // Camada 3: Tolerância leve a erro de digitação (1 erro em 4-6 letras, 2 erros em >= 7 letras)
    const candidateWords = fullFolded.split(' ').filter(Boolean);
    const allowDirectTypo = qFoldedTokens.some((ft) => ft.length >= 4);
    if (
      allowDirectTypo &&
      qFoldedTokens.every((ft) => {
        const maxDist = ft.length >= 7 ? 2 : ft.length >= 4 ? 1 : 0;
        return tokenMatchesWordsWithTypo(ft, candidateWords, maxDist);
      })
    ) {
      scoredMatches.push({ product: p, score: 320 });
      continue;
    }

    // Candidatos para "Sugestões próximas" caso nenhum resultado direto seja encontrado
    if (qFolded.length >= 3) {
      let bestDist = 99;
      for (let w = 0; w < candidateWords.length; w++) {
        const word = candidateWords[w]!;
        if (word.length < 3) continue;
        const firstToken = qFoldedTokens[0] || qFolded;
        const d = boundedLevenshtein(firstToken, word, 2);
        if (d < bestDist) bestDist = d;
        if (word.startsWith(firstToken.slice(0, 3))) {
          bestDist = Math.min(bestDist, 2);
        }
      }
      if (bestDist <= 2) {
        suggestionCandidates.push({ product: p, score: 200 - bestDist * 40 });
      }
    }
  }

  scoredMatches.sort((a, b) => b.score - a.score);
  const matches = scoredMatches.map((entry) => entry.product);

  let suggestions: Product[] = [];
  if (matches.length === 0 && suggestionCandidates.length > 0) {
    suggestionCandidates.sort((a, b) => b.score - a.score);
    suggestions = suggestionCandidates.slice(0, 3).map((entry) => entry.product);
  }

  return { matches, suggestions, exactCodeMatch };
}

/**
 * Pesquisa inteligente de clientes por nome, localidade, NIF ou telefone
 * (suporta números formatados com espaços, traços ou indicativo +244).
 */
export function filterCustomersSmart(customers: Customer[], rawQuery: string): Customer[] {
  const trimmed = String(rawQuery || '').trim();
  if (!trimmed) return customers;

  const qNorm = normalizeSearchText(trimmed);
  const qFolded = foldOrthographyPt(qNorm);
  const qFoldedTokens = qFolded ? qFolded.split(' ').filter(Boolean) : [];

  const scored: Array<{ customer: Customer; score: number }> = [];

  for (let i = 0; i < customers.length; i++) {
    const c = customers[i]!;

    if (
      matchesFormattedIdentifier(c.nif, trimmed) ||
      matchesFormattedIdentifier(c.phone || '', trimmed)
    ) {
      scored.push({ customer: c, score: 900 });
      continue;
    }

    if (!qNorm) continue;

    const normName = normalizeSearchText(c.name);
    const normLoc = normalizeSearchText(c.locality || '');
    const fullNorm = `${normName} ${normLoc}`.trim();

    if (normName.startsWith(qNorm)) {
      scored.push({ customer: c, score: 750 });
      continue;
    }

    if (fullNorm.includes(qNorm)) {
      scored.push({ customer: c, score: 650 });
      continue;
    }

    const foldedFull = foldOrthographyPt(fullNorm);
    if (qFoldedTokens.length > 0 && qFoldedTokens.every((ft) => foldedFull.includes(ft))) {
      scored.push({ customer: c, score: 500 });
      continue;
    }

    const words = foldedFull.split(' ').filter(Boolean);
    if (
      qFoldedTokens.some((ft) => ft.length >= 4) &&
      qFoldedTokens.every((ft) => {
        const maxDist = ft.length >= 7 ? 2 : ft.length >= 4 ? 1 : 0;
        return tokenMatchesWordsWithTypo(ft, words, maxDist);
      })
    ) {
      scored.push({ customer: c, score: 320 });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.map((entry) => entry.customer);
}

/**
 * Pesquisa inteligente no histórico de faturas por número documental, nome do cliente ou NIF.
 */
export function filterInvoicesSmart(invoices: InvoiceRecord[], rawQuery: string): InvoiceRecord[] {
  const trimmed = String(rawQuery || '').trim();
  if (!trimmed) return invoices;

  const rawLower = trimmed.toLowerCase();
  const qNorm = normalizeSearchText(trimmed);
  const qFolded = foldOrthographyPt(qNorm);
  const qFoldedTokens = qFolded ? qFolded.split(' ').filter(Boolean) : [];

  return invoices.filter((inv) => {
    if (String(inv.number || '').toLowerCase().includes(rawLower)) return true;
    if (matchesFormattedIdentifier(inv.number, trimmed)) return true;
    if (matchesFormattedIdentifier(inv.customerNif || '', trimmed)) return true;

    if (!qNorm) return false;
    const normCust = normalizeSearchText(`${inv.customerName || ''} ${inv.customerLocality || ''}`);
    if (normCust.includes(qNorm)) return true;

    const foldedCust = foldOrthographyPt(normCust);
    if (qFoldedTokens.length > 0 && qFoldedTokens.every((ft) => foldedCust.includes(ft))) {
      return true;
    }

    const words = foldedCust.split(' ').filter(Boolean);
    return (
      qFoldedTokens.some((ft) => ft.length >= 4) &&
      qFoldedTokens.every((ft) => {
        const maxDist = ft.length >= 7 ? 2 : ft.length >= 4 ? 1 : 0;
        return tokenMatchesWordsWithTypo(ft, words, maxDist);
      })
    );
  });
}
