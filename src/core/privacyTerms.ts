import { VITRONIS_INSTITUTIONAL } from './types.ts';

export const PRIVACY_POLICY_VERSION = '2026.2-VITRONIS';

export interface PrivacyPolicySection {
  id: string;
  title: string;
  summary: string;
  items: string[];
}

export const SILA_PRIVACY_SECTIONS: readonly PrivacyPolicySection[] = [
  {
    id: '01_dados_recolhidos',
    title: '01 — Dados Recolhidos e Finalidade',
    summary:
      'O SILA-Billing recolhe estritamente os dados necessários à faturação eletrónica, cumprimento fiscal em Angola (AGT / SAF-T) e gestão de acessos da equipa.',
    items: [
      'Identificação institucional da empresa (Denominação Social, NIF, Estabelecimentos, Séries AGT e dados bancários de facturação).',
      'Registos comerciais e fiscais emitidos (Faturas, Proformas, Notas de Crédito, Clientes, Artigos, Movimentos de Stock e Caixa).',
      'Identificação de colaboradores autenticados (Nome, E-mail, Telefone, Função, Estabelecimento autorizado e registo de auditoria operacional).',
      'O PIN de terminal é guardado apenas em formato derivado irreversível (PBKDF2-SHA256 com salt individual), nunca em texto limpo.',
    ],
  },
  {
    id: '02_isolamento_acesso',
    title: '02 — Quem Acede aos Dados e Isolamento Multi-Empresa',
    summary:
      'Cada empresa opera num compartimento isolado pelo respectivo identificador empresarial (companyId) e NIF.',
    items: [
      'Nenhuma empresa cliente acede a documentos, clientes, produtos ou saldos de outra empresa registada.',
      'Dentro da mesma empresa, o acesso é limitado pela função atribuída pelo Proprietário (ex.: Caixa acede apenas às vendas e próprio turno; custos, lucros, compras, séries e dados financeiros privados ficam bloqueados na interface, backend e base de dados).',
      'A administração técnica da plataforma VITRONIS atua exclusivamente na manutenção e suporte auditado da infraestrutura, sem interferir na gestão operacional privada de cada empresa.',
    ],
  },
  {
    id: '03_protecao_seguranca',
    title: '03 — Protecção, Terminal Partilhado e Auditoria',
    summary:
      'Controlo em quatro camadas para impedir acessos indevidos tanto em modo online como offline.',
    items: [
      'Autenticação individual obrigatória com conta Google verificada na nuvem e desbloqueio por PIN individual no terminal da loja.',
      'Bloqueio automático por inactividade e arranque sempre trancado em terminais partilhados.',
      'Bloqueio temporário progressivo após tentativas falhadas de PIN e impedimento de escalada de privilégios.',
      'Registo auditável e imutável de emissões, anulações, alterações de preços, trocas de operador, gestão de utilizadores e tentativas negadas.',
    ],
  },
  {
    id: '04_backups_retencao',
    title: '04 — Backups, Sincronização e Retenção Legal',
    summary:
      'Continuidade operacional offline-first e retenção documental alinhada com as obrigações fiscais angolanas.',
    items: [
      'Os documentos locais permanecem em armazenamento local encriptado/isolado do navegador para continuidade sem internet.',
      'Nos planos com sincronização Cloud, os dados são replicados por empresa no Cloud Firestore com controlo estrito de leitura/escrita por permissão.',
      'Documentos fiscais emitidos e séries encerradas são preservados sem eliminação retroactiva e as anulações mantêm rasto de auditoria pelo prazo legal fiscal aplicável (mínimo 5 anos / Código Geral Tributário).',
    ],
  },
  {
    id: '05_direitos_responsabilidades',
    title: '05 — Direitos e Responsabilidades dos Utilizadores',
    summary:
      'Compromissos da empresa titular, operadores e entidade institucional produtora.',
    items: [
      `Software produzido e distribuído institucionalmente por ${VITRONIS_INSTITUTIONAL.legalName} (NIF ${VITRONIS_INSTITUTIONAL.nif} · ${VITRONIS_INSTITUTIONAL.email}).`,
      'O Proprietário da empresa é responsável pela veracidade do NIF, atribuição correcta de funções à sua equipa e guarda dos backups locais.',
      'Cada colaborador é responsável pelo sigilo do seu PIN e da sua conta autenticada, respondendo pelos atos registados sob o seu utilizador.',
      'A empresa pode exportar integralmente os seus dados (SAF-T XML, CSV/Excel e Backup JSON) ou solicitar revisão/remoção de contas de colaboradores suspensos.',
    ],
  },
] as const;
