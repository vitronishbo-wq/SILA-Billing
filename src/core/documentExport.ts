import { formatDateTimePt, formatKzNumber, roundKz } from './billingEngine';
import { CompanyProfile, formatDocumentTypeLabelPt, InvoiceRecord } from './types';

export type DocumentControlState =
  | 'PAID'
  | 'PARTIAL'
  | 'PENDING'
  | 'CREDIT_NOTE'
  | 'PROFORMA'
  | 'CANCELLED';

export interface InvoiceControlClassification {
  state: DocumentControlState;
  labelPt: string;
  docTypeLabelPt: string;
  payableAmount: number;
  paidAmount: number;
  dueAmount: number;
}

export function classifyInvoiceControlStatus(inv: InvoiceRecord): InvoiceControlClassification {
  const docTypeLabelPt = formatDocumentTypeLabelPt(inv.docType);

  if (inv.status === 'cancelled') {
    return {
      state: 'CANCELLED',
      labelPt: 'Anulada',
      docTypeLabelPt,
      payableAmount: 0,
      paidAmount: 0,
      dueAmount: 0,
    };
  }

  if (inv.docType === 'NC') {
    return {
      state: 'CREDIT_NOTE',
      labelPt: 'Nota de Crédito',
      docTypeLabelPt,
      payableAmount: roundKz(inv.grandTotal),
      paidAmount: roundKz(inv.amountReceived || 0),
      dueAmount: 0,
    };
  }

  if (inv.docType === 'FP' || inv.docType === 'CS') {
    return {
      state: 'PROFORMA',
      labelPt: inv.docType === 'CS' ? 'Comprovativo de Saída' : 'Proforma',
      docTypeLabelPt,
      payableAmount: roundKz(inv.grandTotal),
      paidAmount: 0,
      dueAmount: 0,
    };
  }

  const returnCred = Math.max(0, roundKz(inv.returnCreditApplied || 0));
  const payable = Math.max(0, roundKz(inv.grandTotal - returnCred));
  const due = Math.max(0, roundKz(inv.amountDue || 0));
  const paid = Math.max(0, roundKz(payable - due));

  if (due <= 0.004) {
    return {
      state: 'PAID',
      labelPt: 'Paga',
      docTypeLabelPt,
      payableAmount: payable,
      paidAmount: payable,
      dueAmount: 0,
    };
  }

  if (paid > 0.004) {
    return {
      state: 'PARTIAL',
      labelPt: 'Parcialmente paga',
      docTypeLabelPt,
      payableAmount: payable,
      paidAmount: paid,
      dueAmount: due,
    };
  }

  return {
    state: 'PENDING',
    labelPt: 'Pendente',
    docTypeLabelPt,
    payableAmount: payable,
    paidAmount: 0,
    dueAmount: due,
  };
}

export interface DocumentControlAggregateSummary {
  totalDocs: number;
  issuedFrCount: number;
  paidCount: number;
  partialCount: number;
  pendingCount: number;
  creditNoteCount: number;
  cancelledCount: number;
  proformaCount: number;
  grossFrTotal: number;
  creditNoteTotal: number;
  netCommercialTotal: number;
  paidTotal: number;
  dueTotal: number;
  cancelledTotal: number;
  taxBase14Total: number;
  taxAmount14Total: number;
  taxBaseIntermediateTotal: number;
  taxAmountIntermediateTotal: number;
  taxBaseReducedTotal: number;
  taxAmountReducedTotal: number;
  taxBase0Total: number;
  taxTotalAllRates: number;
}

export function summarizeDocumentControlList(
  invoices: ReadonlyArray<InvoiceRecord>
): DocumentControlAggregateSummary {
  let issuedFrCount = 0;
  let paidCount = 0;
  let partialCount = 0;
  let pendingCount = 0;
  let creditNoteCount = 0;
  let cancelledCount = 0;
  let proformaCount = 0;
  let grossFrTotal = 0;
  let creditNoteTotal = 0;
  let paidTotal = 0;
  let dueTotal = 0;
  let cancelledTotal = 0;
  let taxBase14Total = 0;
  let taxAmount14Total = 0;
  let taxBaseIntermediateTotal = 0;
  let taxAmountIntermediateTotal = 0;
  let taxBaseReducedTotal = 0;
  let taxAmountReducedTotal = 0;
  let taxBase0Total = 0;
  let taxTotalAllRates = 0;

  for (const inv of invoices) {
    const cls = classifyInvoiceControlStatus(inv);
    if (cls.state === 'CANCELLED') {
      cancelledCount += 1;
      cancelledTotal = roundKz(cancelledTotal + inv.grandTotal);
      continue;
    }
    if (cls.state === 'CREDIT_NOTE') {
      creditNoteCount += 1;
      creditNoteTotal = roundKz(creditNoteTotal + inv.grandTotal);
      taxBase14Total = roundKz(taxBase14Total - inv.taxBase14);
      taxAmount14Total = roundKz(taxAmount14Total - inv.taxAmount14);
      taxBaseIntermediateTotal = roundKz(taxBaseIntermediateTotal - (inv.taxBaseIntermediate || 0));
      taxAmountIntermediateTotal = roundKz(taxAmountIntermediateTotal - (inv.taxAmountIntermediate || 0));
      taxBaseReducedTotal = roundKz(taxBaseReducedTotal - (inv.taxBaseReduced || 0));
      taxAmountReducedTotal = roundKz(taxAmountReducedTotal - (inv.taxAmountReduced || 0));
      taxBase0Total = roundKz(taxBase0Total - inv.taxBase0);
      taxTotalAllRates = roundKz(taxTotalAllRates - (inv.taxTotal || 0));
      continue;
    }
    if (cls.state === 'PROFORMA') {
      proformaCount += 1;
      continue;
    }

    issuedFrCount += 1;
    grossFrTotal = roundKz(grossFrTotal + inv.grandTotal);
    paidTotal = roundKz(paidTotal + cls.paidAmount);
    dueTotal = roundKz(dueTotal + cls.dueAmount);
    taxBase14Total = roundKz(taxBase14Total + inv.taxBase14);
    taxAmount14Total = roundKz(taxAmount14Total + inv.taxAmount14);
    taxBaseIntermediateTotal = roundKz(taxBaseIntermediateTotal + (inv.taxBaseIntermediate || 0));
    taxAmountIntermediateTotal = roundKz(taxAmountIntermediateTotal + (inv.taxAmountIntermediate || 0));
    taxBaseReducedTotal = roundKz(taxBaseReducedTotal + (inv.taxBaseReduced || 0));
    taxAmountReducedTotal = roundKz(taxAmountReducedTotal + (inv.taxAmountReduced || 0));
    taxBase0Total = roundKz(taxBase0Total + inv.taxBase0);
    taxTotalAllRates = roundKz(taxTotalAllRates + (inv.taxTotal || 0));

    if (cls.state === 'PAID') paidCount += 1;
    else if (cls.state === 'PARTIAL') partialCount += 1;
    else pendingCount += 1;
  }

  return {
    totalDocs: invoices.length,
    issuedFrCount,
    paidCount,
    partialCount,
    pendingCount,
    creditNoteCount,
    cancelledCount,
    proformaCount,
    grossFrTotal,
    creditNoteTotal,
    netCommercialTotal: roundKz(grossFrTotal - creditNoteTotal),
    paidTotal,
    dueTotal,
    cancelledTotal,
    taxBase14Total,
    taxAmount14Total,
    taxBaseIntermediateTotal,
    taxAmountIntermediateTotal,
    taxBaseReducedTotal,
    taxAmountReducedTotal,
    taxBase0Total,
    taxTotalAllRates,
  };
}

function escapeCsvCell(raw: string | number): string {
  const str = String(raw ?? '').replace(/\r?\n/g, ' ').trim();
  if (str.includes(';') || str.includes('"')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function escapeXml(raw: string | number): string {
  return String(raw ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function buildInvoicesCsvContent(
  invoices: ReadonlyArray<InvoiceRecord>,
  company: CompanyProfile,
  filterLabel: string
): string {
  const sum = summarizeDocumentControlList(invoices);
  const nowDt = formatDateTimePt(new Date().toISOString());

  const headerMeta = [
    ['Empresa', company.legalName, 'NIF', company.nif],
    ['Filtro / Período', filterLabel, 'Exportado em', `${nowDt.slashDate} ${nowDt.time}`],
    [],
  ];

  const columns = [
    'N.º Documento',
    'Tipo',
    'Data Emissão',
    'Hora',
    'Estado',
    'Cliente',
    'NIF Cliente',
    'Operador',
    'Caixa',
    'Meio Pagamento',
    'Base IVA 14% (Kz)',
    'IVA 14% (Kz)',
    'Base Interm./Red. (Kz)',
    'IVA Interm./Red. (Kz)',
    'Base Isenta 0% (Kz)',
    'Total Impostos (Kz)',
    'Desconto (Kz)',
    'Total Documento (Kz)',
    'Valor Pago (Kz)',
    'Saldo em Dívida (Kz)',
    'Doc. Origem / Retificado',
    'Anulado Por',
    'Data Anulação',
    'Motivo Anulação / Notas',
  ];

  const rows = invoices.map((inv) => {
    const dt = formatDateTimePt(inv.issuedAtIso);
    const cls = classifyInvoiceControlStatus(inv);
    const sign = inv.docType === 'NC' && inv.status !== 'cancelled' ? -1 : 1;
    const cancDt = inv.cancelledAtIso ? formatDateTimePt(inv.cancelledAtIso) : null;
    const reasonOrNote =
      inv.status === 'cancelled'
        ? inv.cancelReason || inv.notes || ''
        : inv.notes || '';
    const baseIntRed = roundKz(((inv.taxBaseIntermediate || 0) + (inv.taxBaseReduced || 0)) * sign);
    const taxIntRed = roundKz(((inv.taxAmountIntermediate || 0) + (inv.taxAmountReduced || 0)) * sign);

    return [
      inv.number,
      inv.docType,
      dt.slashDate,
      dt.time,
      cls.labelPt,
      inv.customerName,
      inv.customerNif || 'Consumidor Final',
      inv.operator,
      inv.cashier,
      inv.paymentMethod,
      formatKzNumber(roundKz(inv.taxBase14 * sign)),
      formatKzNumber(roundKz(inv.taxAmount14 * sign)),
      formatKzNumber(baseIntRed),
      formatKzNumber(taxIntRed),
      formatKzNumber(roundKz(inv.taxBase0 * sign)),
      formatKzNumber(roundKz((inv.taxTotal || 0) * sign)),
      formatKzNumber(inv.discountTotal || 0),
      formatKzNumber(roundKz(inv.grandTotal * sign)),
      formatKzNumber(cls.paidAmount),
      formatKzNumber(cls.dueAmount),
      inv.returnOriginNumber || '',
      inv.cancelledBy || '',
      cancDt ? `${cancDt.slashDate} ${cancDt.time}` : '',
      reasonOrNote,
    ];
  });

  const footerRows = [
    [],
    [
      'RESUMO LÍQUIDO (Docs - NC)',
      `${sum.issuedFrCount} Docs / ${sum.creditNoteCount} NC / ${sum.cancelledCount} Anul.`,
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      formatKzNumber(sum.taxBase14Total),
      formatKzNumber(sum.taxAmount14Total),
      formatKzNumber(roundKz(sum.taxBaseIntermediateTotal + sum.taxBaseReducedTotal)),
      formatKzNumber(roundKz(sum.taxAmountIntermediateTotal + sum.taxAmountReducedTotal)),
      formatKzNumber(sum.taxBase0Total),
      formatKzNumber(sum.taxTotalAllRates),
      '',
      formatKzNumber(sum.netCommercialTotal),
      formatKzNumber(sum.paidTotal),
      formatKzNumber(sum.dueTotal),
      '',
      '',
      '',
      '',
    ],
  ];

  const allLines = [...headerMeta, columns, ...rows, ...footerRows].map((line) =>
    line.map((cell) => escapeCsvCell(cell)).join(';')
  );

  return `\uFEFF${allLines.join('\r\n')}`;
}

export function buildInvoicesExcelXml(
  invoices: ReadonlyArray<InvoiceRecord>,
  company: CompanyProfile,
  filterLabel: string
): string {
  const sum = summarizeDocumentControlList(invoices);
  const nowDt = formatDateTimePt(new Date().toISOString());

  const headers = [
    'N.º Documento',
    'Tipo',
    'Data / Hora',
    'Estado',
    'Cliente',
    'NIF Cliente',
    'Operador',
    'Caixa',
    'Meio Pagamento',
    'Base IVA 14% (Kz)',
    'IVA 14% (Kz)',
    'Base Interm./Red. (Kz)',
    'Total Impostos (Kz)',
    'Base Isenta 0% (Kz)',
    'Desconto (Kz)',
    'Total Documento (Kz)',
    'Valor Pago (Kz)',
    'Saldo Dívida (Kz)',
    'Doc. Origem',
    'Anulado Por',
    'Motivo / Observações',
  ];

  const headerCellsXml = headers
    .map((h) => `<Cell ss:StyleID="sHeader"><Data ss:Type="String">${escapeXml(h)}</Data></Cell>`)
    .join('');

  const dataRowsXml = invoices
    .map((inv) => {
      const dt = formatDateTimePt(inv.issuedAtIso);
      const cls = classifyInvoiceControlStatus(inv);
      const isCancelled = inv.status === 'cancelled';
      const sign = inv.docType === 'NC' && !isCancelled ? -1 : 1;
      const numStyle = isCancelled ? 'sNumMuted' : 'sNum';
      const txtStyle = isCancelled ? 'sTextCancelled' : 'sText';
      const detailText =
        inv.status === 'cancelled'
          ? `ANULADO: ${inv.cancelReason || ''}`
          : inv.notes || '';
      const baseIntRed = roundKz(((inv.taxBaseIntermediate || 0) + (inv.taxBaseReduced || 0)) * sign);

      return `<Row>
        <Cell ss:StyleID="${txtStyle}"><Data ss:Type="String">${escapeXml(inv.number)}</Data></Cell>
        <Cell ss:StyleID="${txtStyle}"><Data ss:Type="String">${escapeXml(inv.docType)}</Data></Cell>
        <Cell ss:StyleID="${txtStyle}"><Data ss:Type="String">${escapeXml(`${dt.slashDate} ${dt.time}`)}</Data></Cell>
        <Cell ss:StyleID="${txtStyle}"><Data ss:Type="String">${escapeXml(cls.labelPt)}</Data></Cell>
        <Cell ss:StyleID="${txtStyle}"><Data ss:Type="String">${escapeXml(inv.customerName)}</Data></Cell>
        <Cell ss:StyleID="${txtStyle}"><Data ss:Type="String">${escapeXml(inv.customerNif || 'Consumidor Final')}</Data></Cell>
        <Cell ss:StyleID="${txtStyle}"><Data ss:Type="String">${escapeXml(inv.operator)}</Data></Cell>
        <Cell ss:StyleID="${txtStyle}"><Data ss:Type="String">${escapeXml(inv.cashier)}</Data></Cell>
        <Cell ss:StyleID="${txtStyle}"><Data ss:Type="String">${escapeXml(inv.paymentMethod)}</Data></Cell>
        <Cell ss:StyleID="${numStyle}"><Data ss:Type="Number">${isCancelled ? 0 : roundKz(inv.taxBase14 * sign)}</Data></Cell>
        <Cell ss:StyleID="${numStyle}"><Data ss:Type="Number">${isCancelled ? 0 : roundKz(inv.taxAmount14 * sign)}</Data></Cell>
        <Cell ss:StyleID="${numStyle}"><Data ss:Type="Number">${isCancelled ? 0 : baseIntRed}</Data></Cell>
        <Cell ss:StyleID="${numStyle}"><Data ss:Type="Number">${isCancelled ? 0 : roundKz((inv.taxTotal || 0) * sign)}</Data></Cell>
        <Cell ss:StyleID="${numStyle}"><Data ss:Type="Number">${isCancelled ? 0 : roundKz(inv.taxBase0 * sign)}</Data></Cell>
        <Cell ss:StyleID="${numStyle}"><Data ss:Type="Number">${isCancelled ? 0 : roundKz(inv.discountTotal || 0)}</Data></Cell>
        <Cell ss:StyleID="${numStyle}"><Data ss:Type="Number">${isCancelled ? 0 : roundKz(inv.grandTotal * sign)}</Data></Cell>
        <Cell ss:StyleID="${numStyle}"><Data ss:Type="Number">${cls.paidAmount}</Data></Cell>
        <Cell ss:StyleID="${numStyle}"><Data ss:Type="Number">${cls.dueAmount}</Data></Cell>
        <Cell ss:StyleID="${txtStyle}"><Data ss:Type="String">${escapeXml(inv.returnOriginNumber || '')}</Data></Cell>
        <Cell ss:StyleID="${txtStyle}"><Data ss:Type="String">${escapeXml(inv.cancelledBy || '')}</Data></Cell>
        <Cell ss:StyleID="${txtStyle}"><Data ss:Type="String">${escapeXml(detailText)}</Data></Cell>
      </Row>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
  <Styles>
    <Style ss:ID="Default" ss:Name="Normal">
      <Font ss:FontName="Calibri" ss:Size="10" ss:Color="#0F172A"/>
    </Style>
    <Style ss:ID="sTitle">
      <Font ss:FontName="Calibri" ss:Size="12" ss:Bold="1" ss:Color="#0F172A"/>
    </Style>
    <Style ss:ID="sSub">
      <Font ss:FontName="Calibri" ss:Size="10" ss:Color="#475569"/>
    </Style>
    <Style ss:ID="sHeader">
      <Font ss:FontName="Calibri" ss:Size="10" ss:Bold="1" ss:Color="#FFFFFF"/>
      <Interior ss:Color="#0F172A" ss:Pattern="Solid"/>
    </Style>
    <Style ss:ID="sText">
      <Font ss:FontName="Calibri" ss:Size="10" ss:Color="#0F172A"/>
    </Style>
    <Style ss:ID="sTextCancelled">
      <Font ss:FontName="Calibri" ss:Size="10" ss:Color="#DC2626"/>
    </Style>
    <Style ss:ID="sNum">
      <Font ss:FontName="Calibri" ss:Size="10" ss:Color="#0F172A"/>
      <NumberFormat ss:Format="#,##0.00"/>
    </Style>
    <Style ss:ID="sNumMuted">
      <Font ss:FontName="Calibri" ss:Size="10" ss:Color="#94A3B8"/>
      <NumberFormat ss:Format="#,##0.00"/>
    </Style>
    <Style ss:ID="sTotalLabel">
      <Font ss:FontName="Calibri" ss:Size="10" ss:Bold="1" ss:Color="#0F172A"/>
      <Interior ss:Color="#F1F5F9" ss:Pattern="Solid"/>
    </Style>
    <Style ss:ID="sTotalNum">
      <Font ss:FontName="Calibri" ss:Size="10" ss:Bold="1" ss:Color="#0F172A"/>
      <Interior ss:Color="#F1F5F9" ss:Pattern="Solid"/>
      <NumberFormat ss:Format="#,##0.00"/>
    </Style>
  </Styles>
  <Worksheet ss:Name="Controlo Documental">
    <Table>
      <Row>
        <Cell ss:StyleID="sTitle"><Data ss:Type="String">${escapeXml(`${company.legalName} (NIF: ${company.nif})`)}</Data></Cell>
      </Row>
      <Row>
        <Cell ss:StyleID="sSub"><Data ss:Type="String">${escapeXml(`Mapa de Histórico e Controlo Documental · ${filterLabel} · Exportado em ${nowDt.slashDate} ${nowDt.time}`)}</Data></Cell>
      </Row>
      <Row/>
      <Row>${headerCellsXml}</Row>
      ${dataRowsXml}
      <Row>
        <Cell ss:StyleID="sTotalLabel"><Data ss:Type="String">TOTAL LÍQUIDO VÁLIDO (Docs - NC)</Data></Cell>
        <Cell ss:StyleID="sTotalLabel"><Data ss:Type="String">${escapeXml(`${sum.issuedFrCount} Docs | ${sum.creditNoteCount} NC | ${sum.cancelledCount} Anul.`)}</Data></Cell>
        <Cell ss:StyleID="sTotalLabel"><Data ss:Type="String"></Data></Cell>
        <Cell ss:StyleID="sTotalLabel"><Data ss:Type="String"></Data></Cell>
        <Cell ss:StyleID="sTotalLabel"><Data ss:Type="String"></Data></Cell>
        <Cell ss:StyleID="sTotalLabel"><Data ss:Type="String"></Data></Cell>
        <Cell ss:StyleID="sTotalLabel"><Data ss:Type="String"></Data></Cell>
        <Cell ss:StyleID="sTotalLabel"><Data ss:Type="String"></Data></Cell>
        <Cell ss:StyleID="sTotalLabel"><Data ss:Type="String"></Data></Cell>
        <Cell ss:StyleID="sTotalNum"><Data ss:Type="Number">${sum.taxBase14Total}</Data></Cell>
        <Cell ss:StyleID="sTotalNum"><Data ss:Type="Number">${sum.taxAmount14Total}</Data></Cell>
        <Cell ss:StyleID="sTotalNum"><Data ss:Type="Number">${roundKz(sum.taxBaseIntermediateTotal + sum.taxBaseReducedTotal)}</Data></Cell>
        <Cell ss:StyleID="sTotalNum"><Data ss:Type="Number">${sum.taxTotalAllRates}</Data></Cell>
        <Cell ss:StyleID="sTotalNum"><Data ss:Type="Number">${sum.taxBase0Total}</Data></Cell>
        <Cell ss:StyleID="sTotalLabel"><Data ss:Type="String"></Data></Cell>
        <Cell ss:StyleID="sTotalNum"><Data ss:Type="Number">${sum.netCommercialTotal}</Data></Cell>
        <Cell ss:StyleID="sTotalNum"><Data ss:Type="Number">${sum.paidTotal}</Data></Cell>
        <Cell ss:StyleID="sTotalNum"><Data ss:Type="Number">${sum.dueTotal}</Data></Cell>
        <Cell ss:StyleID="sTotalLabel"><Data ss:Type="String"></Data></Cell>
        <Cell ss:StyleID="sTotalLabel"><Data ss:Type="String"></Data></Cell>
        <Cell ss:StyleID="sTotalLabel"><Data ss:Type="String"></Data></Cell>
      </Row>
    </Table>
  </Worksheet>
</Workbook>`;
}

export function triggerBrowserDownload(
  content: string,
  filename: string,
  mimeType: string
): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
