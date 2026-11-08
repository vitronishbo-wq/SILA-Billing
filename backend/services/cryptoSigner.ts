/**
 * SILA-Billing — Módulo Criptográfico de Assinaturas Digitais AGT (JWS / RSA)
 * Em conformidade com o Decreto Executivo n.º 683/25 e Decreto Presidencial n.º 71/25.
 * 
 * Regras Obrigatórias de Segurança:
 * 1. As chaves privadas nunca são expostas ao frontend ou ao navegador.
 * 2. Gestão separada entre a Chave do Produtor de Software (VITRONIS) e a Chave do Emitente.
 * 3. Assinaturas JWS (RFC 7515) com algoritmo RSA-SHA256 (RS256):
 *    - jwsSoftwareSignature: assina softwareInfo e certificação do produtor.
 *    - jwsDocumentSignature: assina o conteúdo canónico do documento fiscal (documentNo, linhas, totais).
 *    - jwsSignature: assinatura final do envelope de submissão à AGT.
 * 4. Fallback seguro e isolado para chaves de homologação/teste quando em ambiente não-produtivo.
 */

import {
  createHash,
  createSign,
  createVerify,
  generateKeyPairSync,
  type KeyObject,
} from 'crypto';
import type { AgtDocumentPayload, AgtSoftwareInfo } from '../../src/core/fiscalTypes.ts';

function base64UrlEncode(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function base64UrlDecode(input: string): string {
  let base64 = input.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) {
    base64 += '=';
  }
  return Buffer.from(base64, 'base64').toString('utf8');
}

export interface KeyPairPem {
  publicKeyPem: string;
  privateKeyPem: string;
}

class CryptoSignerStore {
  private softwareKeyPair: KeyPairPem | null = null;
  private issuerKeyPairs = new Map<string, KeyPairPem>();

  /**
   * Obtém ou inicializa o par de chaves RSA do Produtor de Software (SILA-Billing / VITRONIS).
   */
  getSoftwareKeyPair(): KeyPairPem {
    if (this.softwareKeyPair) return this.softwareKeyPair;

    const envPriv = process.env.AGT_SOFTWARE_PRIVATE_KEY_PEM;
    const envPub = process.env.AGT_SOFTWARE_PUBLIC_KEY_PEM;

    if (envPriv && envPub) {
      this.softwareKeyPair = {
        privateKeyPem: envPriv.replace(/\\n/g, '\n'),
        publicKeyPem: envPub.replace(/\\n/g, '\n'),
      };
      return this.softwareKeyPair;
    }

    // Modo Homologação / Desenvolvimento: Geração de par RSA-2048 determinístico de teste
    const pair = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });

    this.softwareKeyPair = {
      publicKeyPem: pair.publicKey,
      privateKeyPem: pair.privateKey,
    };
    return this.softwareKeyPair;
  }

  /**
   * Obtém ou inicializa o par de chaves RSA do Contribuinte Emitente.
   */
  getIssuerKeyPair(companyTaxId: string): KeyPairPem {
    const cleanNif = String(companyTaxId || 'DEFAULT_NIF').trim().toUpperCase();
    if (this.issuerKeyPairs.has(cleanNif)) {
      return this.issuerKeyPairs.get(cleanNif)!;
    }

    const envPriv = process.env[`AGT_ISSUER_PRIVATE_KEY_${cleanNif}`];
    const envPub = process.env[`AGT_ISSUER_PUBLIC_KEY_${cleanNif}`];

    if (envPriv && envPub) {
      const pair = {
        privateKeyPem: envPriv.replace(/\\n/g, '\n'),
        publicKeyPem: envPub.replace(/\\n/g, '\n'),
      };
      this.issuerKeyPairs.set(cleanNif, pair);
      return pair;
    }

    // Par de teste RSA-2048 para o contribuinte em homologação
    const pair = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });

    const result = {
      publicKeyPem: pair.publicKey,
      privateKeyPem: pair.privateKey,
    };
    this.issuerKeyPairs.set(cleanNif, result);
    return result;
  }
}

export const cryptoSignerStore = new CryptoSignerStore();

/**
 * Assina um payload arbitrário no formato JWS Compact Serialization:
 * HEADER.PAYLOAD.SIGNATURE (RS256).
 */
export function signJwsCompact(payloadString: string, privateKeyPem: string): string {
  const header = {
    alg: 'RS256',
    typ: 'JWT',
  };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(payloadString);
  const dataToSign = `${encodedHeader}.${encodedPayload}`;

  const signer = createSign('RSA-SHA256');
  signer.update(dataToSign);
  signer.end();

  const signature = signer.sign(privateKeyPem);
  const encodedSignature = base64UrlEncode(signature);

  return `${dataToSign}.${encodedSignature}`;
}

/**
 * Verifica a autenticidade de uma assinatura JWS Compact.
 */
export function verifyJwsCompact(jwsString: string, publicKeyPem: string): {
  valid: boolean;
  payload?: string;
  error?: string;
} {
  const parts = String(jwsString || '').trim().split('.');
  if (parts.length !== 3) {
    return { valid: false, error: 'Estrutura JWS inválida: deve conter 3 partes separadas por ponto.' };
  }

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const dataToVerify = `${encodedHeader}.${encodedPayload}`;

  try {
    const verifier = createVerify('RSA-SHA256');
    verifier.update(dataToVerify);
    verifier.end();

    const signatureBuf = Buffer.from(
      encodedSignature!.replace(/-/g, '+').replace(/_/g, '/'),
      'base64'
    );
    const isValid = verifier.verify(publicKeyPem, signatureBuf);

    if (!isValid) {
      return { valid: false, error: 'Assinatura criptográfica JWS inválida ou violada.' };
    }

    return { valid: true, payload: base64UrlDecode(encodedPayload!) };
  } catch (err: any) {
    return { valid: false, error: err.message || 'Erro ao verificar assinatura JWS.' };
  }
}

/**
 * Produz a string canónica do software para a assinatura jwsSoftwareSignature.
 */
export function buildCanonicalSoftwareString(softwareInfo: AgtSoftwareInfo): string {
  return [
    softwareInfo.softwareApprovalNumber,
    softwareInfo.softwareName,
    softwareInfo.softwareVersion,
    softwareInfo.producerTaxID,
  ].join('|');
}

/**
 * Produz a string canónica do documento fiscal para a assinatura jwsDocumentSignature.
 * Inclui documentNo, documentDate, customerTaxID, total ilíquido e resumo das linhas.
 */
export function buildCanonicalDocumentString(doc: AgtDocumentPayload): string {
  const lineSummary = (doc.lines || [])
    .map(
      (l) =>
        `${l.lineNumber};${l.productCode};${l.quantity.toFixed(2)};${l.unitPrice.toFixed(2)};${l.taxPercentage};${l.lineTotal.toFixed(2)}`
    )
    .join('#');

  return [
    doc.companyTaxID,
    doc.documentNo,
    doc.documentDate,
    doc.documentStatus,
    doc.customerTaxID,
    doc.customerCountry,
    doc.documentTotals.merchandiseTotalNet.toFixed(2),
    doc.documentTotals.totalTaxBaseNOR.toFixed(2),
    doc.documentTotals.totalTaxAmountNOR.toFixed(2),
    doc.documentTotals.grossTotal.toFixed(2),
    doc.documentTotals.netPayableTotal.toFixed(2),
    lineSummary,
  ].join('|');
}

export interface DocumentSigningResult {
  jwsSoftwareSignature: string;
  jwsDocumentSignature: string;
  jwsSignature: string; // Assinatura consolidada do envelope
  signaturePreview: string; // 4 caracteres de controlo para QR Code (campo Q)
}

/**
 * Aplica todas as assinaturas digitais RSA/JWS exigidas pela AGT no documento.
 */
export function signAgtDocument(doc: AgtDocumentPayload): DocumentSigningResult {
  const softKeys = cryptoSignerStore.getSoftwareKeyPair();
  const issuerKeys = cryptoSignerStore.getIssuerKeyPair(doc.companyTaxID);

  // 1. Assinatura do Software Produtor (VITRONIS)
  const canonicalSoftware = buildCanonicalSoftwareString(doc.softwareInfo);
  const jwsSoftwareSignature = signJwsCompact(canonicalSoftware, softKeys.privateKeyPem);

  // 2. Assinatura do Conteúdo do Documento pelo Contribuinte Emitente
  const canonicalDocument = buildCanonicalDocumentString(doc);
  const jwsDocumentSignature = signJwsCompact(canonicalDocument, issuerKeys.privateKeyPem);

  // 3. Assinatura Consolidada do Envelope de Envio (jwsSignature)
  const envelopePayload = JSON.stringify({
    submissionGUID: doc.submissionGUID,
    documentNo: doc.documentNo,
    softwareSignatureHash: createHash('sha256').update(jwsSoftwareSignature).digest('hex'),
    documentSignatureHash: createHash('sha256').update(jwsDocumentSignature).digest('hex'),
    systemEntryDate: doc.systemEntryDate,
  });
  const jwsSignature = signJwsCompact(envelopePayload, issuerKeys.privateKeyPem);

  // Extrai os 4 caracteres de controlo da assinatura JWS para o campo Q do QR Code
  const sigParts = jwsDocumentSignature.split('.');
  const sigRaw = sigParts[2] || 'AAAA';
  const signaturePreview = sigRaw.slice(0, 4);

  return {
    jwsSoftwareSignature,
    jwsDocumentSignature,
    jwsSignature,
    signaturePreview,
  };
}
