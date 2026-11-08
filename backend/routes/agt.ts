/**
 * SILA-Billing — Router de Serviços REST AGT (Angola)
 * Em conformidade com o Decreto Executivo n.º 683/25 e Decreto Presidencial n.º 71/25.
 */

import { Router } from 'express';
import type { AgtDocumentPayload } from '../../src/core/fiscalTypes.ts';
import {
  listarSeries,
  solicitarSerie,
  type SolicitarSerieInput,
} from '../../src/core/seriesManager.ts';
import { agtClient, MAX_AGT_BATCH_SIZE } from '../services/agtClient.ts';

export const agtRouter = Router();

/**
 * POST /api/agt/invoices/register-batch
 * Submete um lote de até 30 documentos fiscais à AGT com assinaturas RSA/JWS.
 */
agtRouter.post('/invoices/register-batch', async (req, res) => {
  try {
    const { documents, environment } = req.body as {
      documents: AgtDocumentPayload[];
      environment?: 'HOMOLOGACAO' | 'PRODUCAO';
    };

    if (!Array.isArray(documents) || documents.length === 0) {
      res.status(400).json({
        ok: false,
        error: 'O lote de submissão deve conter entre 1 e 30 documentos fiscais.',
      });
      return;
    }

    if (documents.length > MAX_AGT_BATCH_SIZE) {
      res.status(400).json({
        ok: false,
        error: `O lote excede o limite máximo legal de ${MAX_AGT_BATCH_SIZE} documentos por chamada (especificação AGT).`,
      });
      return;
    }

    const result = await agtClient.registarFactura(documents, environment);
    res.status(result.statusCode === 200 ? 200 : 207).json({
      ok: true,
      result,
    });
  } catch (err: any) {
    res.status(500).json({
      ok: false,
      error: err.message || 'Erro ao processar submissão de lote à AGT.',
    });
  }
});

/**
 * GET /api/agt/invoices/status/:requestId
 * Consulta o estado assíncrono de um lote de faturas junto da AGT (obterEstado).
 */
agtRouter.get('/invoices/status/:requestId', async (req, res) => {
  try {
    const { requestId } = req.params;
    const submissionGUID = String(req.query.submissionGUID || '');

    if (!requestId) {
      res.status(400).json({ ok: false, error: 'Identificador de pedido (requestId) é obrigatório.' });
      return;
    }

    const status = await agtClient.obterEstado(requestId, submissionGUID);
    res.status(200).json({ ok: true, status });
  } catch (err: any) {
    res.status(500).json({
      ok: false,
      error: err.message || 'Erro ao consultar estado na AGT.',
    });
  }
});

/**
 * GET /api/agt/invoices/query/:documentNo
 * Consulta uma fatura específica diretamente no sistema da AGT (consultarFactura).
 */
agtRouter.get('/invoices/query/:documentNo', async (req, res) => {
  try {
    const { documentNo } = req.params;
    const companyTaxID = String(req.query.companyTaxID || '');

    if (!documentNo || !companyTaxID) {
      res.status(400).json({
        ok: false,
        error: 'Número do documento e NIF da empresa (companyTaxID) são obrigatórios.',
      });
      return;
    }

    const queryRes = await agtClient.consultarFactura(documentNo, companyTaxID);
    res.status(200).json({ ok: true, queryRes });
  } catch (err: any) {
    res.status(500).json({
      ok: false,
      error: err.message || 'Erro ao consultar documento na AGT.',
    });
  }
});

/**
 * POST /api/agt/invoices/validate
 * Validador prévio de estrutura e assinaturas JWS (validarDocumento).
 */
agtRouter.post('/invoices/validate', async (req, res) => {
  try {
    const doc = req.body as AgtDocumentPayload;
    if (!doc) {
      res.status(400).json({ ok: false, error: 'Documento ausente no pedido.' });
      return;
    }

    const validation = await agtClient.validarDocumento(doc);
    res.status(validation.valid ? 200 : 422).json({
      ok: validation.valid,
      validation,
    });
  } catch (err: any) {
    res.status(500).json({
      ok: false,
      error: err.message || 'Erro ao validar documento.',
    });
  }
});

/**
 * POST /api/agt/series/request
 * Solicitação formal de série fiscal à AGT (solicitarSerie).
 */
agtRouter.post('/series/request', (req, res) => {
  try {
    const input = req.body as SolicitarSerieInput;
    if (!input || !input.companyId || !input.seriesCode || !input.documentType) {
      res.status(400).json({
        ok: false,
        error: 'companyId, seriesCode e documentType são obrigatórios para solicitar série.',
      });
      return;
    }

    const record = solicitarSerie(input);
    res.status(201).json({ ok: true, series: record });
  } catch (err: any) {
    res.status(400).json({
      ok: false,
      error: err.message || 'Erro ao solicitar série fiscal à AGT.',
    });
  }
});

/**
 * GET /api/agt/series/list
 * Listagem das séries fiscais homologadas da empresa (listarSeries).
 */
agtRouter.get('/series/list', (req, res) => {
  try {
    const companyId = String(req.query.companyId || '');
    if (!companyId) {
      res.status(400).json({ ok: false, error: 'Identificador da empresa (companyId) é obrigatório.' });
      return;
    }

    const seriesYear = req.query.seriesYear ? parseInt(String(req.query.seriesYear), 10) : undefined;
    const documentType = req.query.documentType as any;
    const status = req.query.status as any;

    const list = listarSeries({
      companyId,
      seriesYear,
      documentType,
      status,
    });

    res.status(200).json({ ok: true, series: list });
  } catch (err: any) {
    res.status(500).json({
      ok: false,
      error: err.message || 'Erro ao listar séries fiscais.',
    });
  }
});
