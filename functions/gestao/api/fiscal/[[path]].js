/**
 * Notas fiscais de compra (Parte A): busca na SEFAZ as NF-e emitidas contra o
 * CNPJ da 3M (Distribuição de DF-e), faz a Ciência da Operação e monta o
 * cadastro de peças e fornecedores a partir dos itens.
 *
 * Rota: /gestao/api/fiscal/*   |   Binding: DB (D1)   |   Só com login (gestao/api/_middleware.js).
 * Quem fala com a SEFAZ é a ponte fiscal (ponte-fiscal/, Fly.io), que guarda o
 * certificado A1. Segredos (Cloudflare): PONTE_FISCAL_URL, PONTE_FISCAL_TOKEN.
 *
 *   GET  notas              lista das notas de compra com os itens (sem o XML)
 *   GET  xml?chave=         baixa o XML da nota
 *   POST sincronizar        uma rodada de busca; o navegador repete até vir fim:true
 *   POST diagnostico        confere ponte, certificado e conexão com a SEFAZ
 *
 * Destino das peças (rastreio e estoque):
 *   POST destinar           { item_id, ordem_id, os_item_id, qtde } → liga parte de um item da nota a uma OS
 *   POST desfazer_destino   { id }
 *   POST historico          { chave, valor } → nota conta (0) ou não (1) no estoque
 *   GET  estoque            saldo por peça: comprado nas notas que contam − destinado às OS
 *
 * Compra sem nota (balcão, peça usada, pessoa física): fica em nfe_entrada com status 'manual'
 * e chave 'MAN…'; destina e conta no estoque igual a uma nota.
 *   POST entrada_manual     { fornecedor_id?, fornecedor_nome, cnpj?, data, obs?, comprovante?, itens:[{peca_id?, descricao, qtde, custo, ncm?, unidade?}] }
 *   POST excluir_manual     { chave } (só sem destinos)
 *
 * Regra fiscal de venda das peças (ver "Regra fiscal de venda das peças" abaixo):
 *   GET  regras             regra sugerida/ajustada/aprovada por peça, com o motivo e os avisos
 *   POST regra              { peca_id, acao: 'aprovar'|'ajustar'|'limpar', base?, regra?, obs, quem }
 *   GET  regra_ncm?ncm=&st=  regra para peça sem nota ligada (NCM e ST informados à mão)
 *
 * Emissão de nota de peça (NF-e 55 / NFC-e 65) na SEFAZ-GO, pela ponte:
 *   GET  emissao_config      ambiente (1 produção / 2 homologação), séries, próximos números
 *   POST emissao_config      { tpAmb?, proximo?: {id, valor}, respTec? }
 *   POST nfe_status          status do serviço da SEFAZ-GO no ambiente atual
 *   POST emitir              { ordem_id, os, modelo, dest, itens[{nome,codigo,ncm,cest,origem,qtde,valorUnit,desconto,regra}], pagamento, quem }
 *   POST cancelar_nota       { id, xJust }
 *   GET  saidas?ordem_id=    notas emitidas (sem o XML)
 *   GET  danfe?id=           DANFE em HTML (imprimir / salvar PDF)
 *   GET  xml_saida?id=       XML autorizado (e o do cancelamento, se houver)
 *
 * Nota de serviço (NFS-e de Goiânia, mão de obra) — functions/_lib/nfse.js:
 *   GET  nfse_config           ambiente (homologação por padrão), alíquota e % do Simples
 *   POST nfse_config           { tpAmb?, aliquota?, pTotTribSN? } — só o administrador
 *   POST nfse_emitir           { ordem_id, os, tomador, descricao, valor, desconto, iss_retido, validar? }
 *   POST nfse_cancelar         { id, cMotivo (1 erro, 2 não prestado, 9 outros), xMotivo }
 *   GET  nfse_saidas?ordem_id= notas de serviço (sem o XML)
 *   GET  nfse_xml?id=          XML da NFS-e (e o do cancelamento: &evento=cancelamento)
 *
 * Dados da empresa emitente (functions/_lib/empresa.js):
 *   GET  empresa / POST empresa { razao, cnpj, ie, im, endereço, regime, códigos da NFS-e… } — POST só o administrador
 *   GET  nfse_danfse?id=       DANFSe em HTML (imprimir / salvar PDF), com o QR Code do link oficial
 *
 * Notas anteriores à ativação do estoque (dfe_controle.estoque_desde) ficam como
 * histórico: dá para ligar as peças às OS (rastreio/garantia), mas não somam no estoque.
 */

import { EMPRESA_PADRAO, COD_UF, carregarEmpresa, salvarEmpresa, emitenteNFe } from '../../../_lib/empresa.js';
import { garantirTabelaNfse, configNfse, salvarConfigNfse, emitirNfse, cancelarNfse, danfseHtml, linksNfse } from '../../../_lib/nfse.js';

// Regra da SEFAZ: sem documentos novos (137) ou já no fim da fila, esperar 1 hora
// antes de consultar de novo — senão ela bloqueia por "consumo indevido" (656).
const ESPERA_MS = 65 * 60 * 1000;
const LOTES_POR_RODADA = 3;     // cada lote traz até 50 documentos
const CIENCIAS_POR_RODADA = 10;
// Prazo da SEFAZ para a Ciência da Operação; com folga para o fuso e a hora da autorização.
const PRAZO_CIENCIA_DIAS = 9.5;
const COMPLETAR_POR_RODADA = 5;
// Depois da ciência a SEFAZ leva alguns minutos para liberar o XML completo.
const ESPERA_COMPLETA_MS = 15 * 60 * 1000;

// Nota de compra "nova" para o alerta: chegou da SEFAZ depois que o alerta foi ligado, conta no
// estoque (não é histórico) e ninguém abriu ainda. Compra sem nota (lançada pela equipe) não entra.
const SQL_NOVA = "conferida IS NULL AND status IN ('completa','resumo') AND COALESCE(historico,0)=0";
const notaNova = (n) => n.conferida == null && ['completa', 'resumo'].includes(n.status) && !Number(n.historico);

const jsonResp = (o, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

const soDigitos = (v) => String(v || '').replace(/\D/g, '');
const fmtCnpj = (c) => c.length === 14 ? c.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5') : c;
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const nomeNorm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
// O D1 recusa undefined: campo que não veio no XML vira null.
const comNulos = (o, campos) => { for (const k of campos) if (o[k] === undefined) o[k] = null; return o; };
const CAMPOS_NOTA = ['chave', 'numero', 'serie', 'dhEmi', 'tpNF', 'cnpjEmit', 'nomeEmit', 'valor', 'situacao', 'tpEvento'];
const CAMPOS_ITEM = ['nItem', 'codigo', 'ean', 'descricao', 'ncm', 'cest', 'cfop', 'unidade', 'qtde', 'valorUnit', 'valorTotal', 'origem'];

async function garantirTabelas(DB) {
  await DB.batch([
    DB.prepare(`CREATE TABLE IF NOT EXISTS nfe_entrada (chave TEXT PRIMARY KEY, nsu TEXT, status TEXT, numero TEXT, serie TEXT,
      cnpj_emit TEXT, nome_emit TEXT, fornecedor_id TEXT, dh_emi TEXT, valor REAL, situacao_sefaz TEXT, tp_nf TEXT,
      manifestado INTEGER, manifesto_msg TEXT, tentou_completar INTEGER, xml TEXT, criado INTEGER, atualizado INTEGER)`),
    DB.prepare(`CREATE TABLE IF NOT EXISTS nfe_entrada_itens (id TEXT PRIMARY KEY, chave TEXT, n_item INTEGER, codigo TEXT, ean TEXT,
      descricao TEXT, ncm TEXT, cest TEXT, cfop TEXT, unidade TEXT, qtde REAL, valor_unit REAL, valor_total REAL, origem TEXT, peca_id TEXT)`),
    DB.prepare('CREATE INDEX IF NOT EXISTS idx_nfe_itens_chave ON nfe_entrada_itens (chave)'),
    DB.prepare(`CREATE TABLE IF NOT EXISTS dfe_controle (id TEXT PRIMARY KEY, ult_nsu TEXT, max_nsu TEXT, espera_ate INTEGER,
      ultima_execucao INTEGER, ultimo_status TEXT)`),
  ]);
  // Dados fiscais da peça (vêm das notas de compra). Ficam fora do SCHEMA da API
  // principal de propósito: o navegador nunca sobrescreve estas colunas.
  for (const col of ['ncm TEXT', 'cest TEXT', 'ean TEXT', 'unidade TEXT', 'custo REAL', 'origem TEXT', 'codigo_forn TEXT', 'fornecedor_id TEXT', 'codigo TEXT']) {
    try { await DB.prepare(`ALTER TABLE pecas ADD COLUMN ${col}`).run(); } catch (e) { /* coluna já existe */ }
  }
  for (const col of ['historico INTEGER', 'comprovante TEXT', 'obs TEXT', 'rateio_un INTEGER', 'conferida INTEGER', 'conferida_por TEXT']) {
    try { await DB.prepare(`ALTER TABLE nfe_entrada ADD COLUMN ${col}`).run(); } catch (e) { /* coluna já existe */ }
  }
  try { await DB.prepare('ALTER TABLE dfe_controle ADD COLUMN estoque_desde INTEGER').run(); } catch (e) { /* coluna já existe */ }
  await DB.prepare(`CREATE TABLE IF NOT EXISTS nfe_destinos (id TEXT PRIMARY KEY, item_id TEXT, chave TEXT, ordem_id TEXT, os_item_id TEXT,
    qtde REAL, quem TEXT, criado INTEGER)`).run();

  // Ativação do estoque: a partir de agora. O que já estava gravado vira histórico.
  const ctl = await DB.prepare("SELECT estoque_desde FROM dfe_controle WHERE id='3m'").first();
  if (!ctl || !ctl.estoque_desde) {
    const agora = Date.now();
    await DB.batch([
      DB.prepare(`INSERT INTO dfe_controle (id,ult_nsu,espera_ate,estoque_desde) VALUES ('3m','0',0,?)
        ON CONFLICT(id) DO UPDATE SET estoque_desde=excluded.estoque_desde`).bind(agora),
      DB.prepare('UPDATE nfe_entrada SET historico=1 WHERE historico IS NULL'),
    ]);
  }

  // Custo real do item: preço + rateio de frete, seguro, outras despesas, IPI e ST − desconto.
  for (const col of ['v_frete REAL', 'v_seg REAL', 'v_desc REAL', 'v_outro REAL', 'v_ipi REAL', 'v_st REAL', 'custo_unit REAL']) {
    try { await DB.prepare(`ALTER TABLE nfe_entrada_itens ADD COLUMN ${col}`).run(); } catch (e) { /* coluna já existe */ }
  }
  await recalcularCustos(DB);
  for (const col of ['icms_cst TEXT', 'pis_cst TEXT']) {
    try { await DB.prepare(`ALTER TABLE nfe_entrada_itens ADD COLUMN ${col}`).run(); } catch (e) { /* coluna já existe */ }
  }
  try { await DB.prepare('ALTER TABLE pecas ADD COLUMN regra_fiscal TEXT').run(); } catch (e) { /* coluna já existe */ }
  await recalcularFiscal(DB);
  await garantirTabelasEmissao(DB);
  await garantirTabelaNfse(DB);
  // Alerta de nota nova: o que já estava gravado quando o alerta nasceu conta como conferido.
  if (!(await DB.prepare("SELECT valor FROM fiscal_config WHERE chave='alerta_desde'").first())) {
    await DB.batch([
      DB.prepare("UPDATE nfe_entrada SET conferida=COALESCE(criado,?), conferida_por='(antes do alerta)' WHERE conferida IS NULL").bind(Date.now()),
      DB.prepare("INSERT OR IGNORE INTO fiscal_config (chave,valor) VALUES ('alerta_desde',?)").bind(String(Date.now())),
    ]);
  }

  // Código próprio (P0001…) para toda peça que já apareceu numa nota.
  const semCodigo = await DB.prepare(`SELECT DISTINCT p.id FROM pecas p JOIN nfe_entrada_itens i ON i.peca_id=p.id
    WHERE p.codigo IS NULL ORDER BY p.criado, p.id`).all();
  if ((semCodigo.results || []).length) {
    let n = await ultimoCodigo(DB);
    await DB.batch(semCodigo.results.map(r => DB.prepare('UPDATE pecas SET codigo=? WHERE id=?').bind(codigoPeca(++n), r.id)));
  }
}

const codigoPeca = (n) => 'P' + String(n).padStart(4, '0');

/**
 * Custo real de cada item a partir do XML da NF-e: preço do produto (vProd ÷ quantidade) + uma
 * parte igual, por unidade comprada, de tudo o que a nota cobra além dos produtos (vFrete + vSeg
 * + vOutro + vIPI + ICMS-ST − vDesc de todos os itens). Os valores por item ficam gravados como a
 * nota trouxe, só para conferência; se só o total vier preenchido, distribui pelo valor do produto.
 * (O vItem da reforma não serve: soma IBS/CBS, que em 2026 não entram no total da nota.)
 */
function custosDoXml(xml) {
  const num = (txt, nome) => { const m = txt.match(new RegExp(`<${nome}>([^<]+)</${nome}>`)); return m ? Number(m[1]) || 0 : 0; };
  const bloco = (txt, nome) => (txt.match(new RegExp(`<${nome}>([\\s\\S]*?)</${nome}>`)) || [, ''])[1];
  const itens = {};
  for (const d of xml.matchAll(/<det\s+nItem="(\d+)"\s*>([\s\S]*?)<\/det>/g)) {
    const prod = bloco(d[2], 'prod'), imp = bloco(d[2], 'imposto');
    const icms = bloco(imp, 'ICMS');
    itens[d[1]] = { qtde: num(prod, 'qCom'), v_prod: num(prod, 'vProd'), v_frete: num(prod, 'vFrete'), v_seg: num(prod, 'vSeg'),
      v_desc: num(prod, 'vDesc'), v_outro: num(prod, 'vOutro'), v_ipi: num(bloco(imp, 'IPITrib'), 'vIPI'),
      v_st: num(icms, 'vICMSST') + num(icms, 'vFCPST') };
  }
  const lista = Object.values(itens);
  const tot = bloco(xml, 'ICMSTot');
  const base = lista.reduce((a, i) => a + i.v_prod, 0);
  for (const [campo, nome] of [['v_frete', 'vFrete'], ['v_seg', 'vSeg'], ['v_desc', 'vDesc'], ['v_outro', 'vOutro']]) {
    const total = num(tot, nome);
    if (total > 0 && base > 0 && lista.reduce((a, i) => a + i[campo], 0) < 0.005) lista.forEach(i => { i[campo] = total * i.v_prod / base; });
  }
  const excedente = lista.reduce((a, i) => a + i.v_frete + i.v_seg + i.v_outro + i.v_ipi + i.v_st - i.v_desc, 0);
  const porUnidade = rateioPorUnidade(excedente, lista.reduce((a, i) => a + i.qtde, 0));
  for (const i of lista) i.custo_unit = i.qtde > 0 ? arred4(i.v_prod / i.qtde + porUnidade) : 0;
  return itens;
}
const arred4 = (v) => Math.round(v * 10000) / 10000;
// Excedente da nota (frete, despesas, impostos) dividido igualmente por unidade comprada.
const rateioPorUnidade = (excedente, unidades) => unidades > 0 ? excedente / unidades : 0;

/** Refaz o custo real das notas gravadas antes da regra atual (rateio_un) — um lote por pedido. */
async function recalcularCustos(DB) {
  await DB.prepare(`UPDATE nfe_entrada_itens SET custo_unit=valor_unit WHERE custo_unit IS NULL
    AND chave IN (SELECT chave FROM nfe_entrada WHERE status='manual')`).run();
  const r = await DB.prepare(`SELECT n.chave, n.xml FROM nfe_entrada n WHERE (n.xml IS NOT NULL OR n.status='manual')
    AND (n.rateio_un IS NULL OR EXISTS (SELECT 1 FROM nfe_entrada_itens i WHERE i.chave=n.chave AND i.custo_unit IS NULL)) LIMIT 40`).all();
  const notas = r.results || [];
  if (!notas.length) return;
  const stmts = [];
  // Compra sem nota: o frete gravado nos itens volta a ser dividido igualmente por unidade.
  const manuais = notas.filter(n => !n.xml);
  if (manuais.length) {
    const its = await DB.prepare(`SELECT id, chave, qtde, valor_unit, v_frete FROM nfe_entrada_itens WHERE chave IN (${manuais.map(() => '?').join(',')})`)
      .bind(...manuais.map(n => n.chave)).all();
    for (const n of manuais) {
      const lista = (its.results || []).filter(i => i.chave === n.chave);
      const porUnidade = rateioPorUnidade(lista.reduce((a, i) => a + (Number(i.v_frete) || 0), 0), lista.reduce((a, i) => a + (Number(i.qtde) || 0), 0));
      for (const i of lista) stmts.push(DB.prepare('UPDATE nfe_entrada_itens SET custo_unit=? WHERE id=?').bind(arred4((Number(i.valor_unit) || 0) + porUnidade), i.id));
    }
  }
  for (const n of notas) {
    stmts.push(DB.prepare('UPDATE nfe_entrada SET rateio_un=1 WHERE chave=?').bind(n.chave));
    if (!n.xml) continue;
    for (const [nItem, c] of Object.entries(custosDoXml(n.xml))) {
      stmts.push(DB.prepare(`UPDATE nfe_entrada_itens SET v_frete=?, v_seg=?, v_desc=?, v_outro=?, v_ipi=?, v_st=?, custo_unit=? WHERE id=?`)
        .bind(c.v_frete, c.v_seg, c.v_desc, c.v_outro, c.v_ipi, c.v_st, c.custo_unit, `${n.chave}-${nItem}`));
    }
    // Item que o XML não explicou fica com o preço da nota (e não volta a ser lido).
    stmts.push(DB.prepare('UPDATE nfe_entrada_itens SET custo_unit=valor_unit WHERE chave=? AND custo_unit IS NULL').bind(n.chave));
  }
  const q = notas.map(() => '?').join(',');
  stmts.push(DB.prepare(`UPDATE pecas SET custo=(SELECT i.custo_unit FROM nfe_entrada_itens i JOIN nfe_entrada e ON e.chave=i.chave
    WHERE i.peca_id=pecas.id AND i.custo_unit IS NOT NULL ORDER BY e.dh_emi DESC LIMIT 1)
    WHERE id IN (SELECT peca_id FROM nfe_entrada_itens WHERE chave IN (${q}))`).bind(...notas.map(n => n.chave)));
  await DB.batch(stmts);
}
async function ultimoCodigo(DB) {
  const r = await DB.prepare("SELECT MAX(CAST(SUBSTR(codigo,2) AS INTEGER)) AS n FROM pecas WHERE codigo LIKE 'P%'").first();
  return (r && r.n) || 0;
}

async function ponte(env, pedido) {
  if (!env.PONTE_FISCAL_URL || !env.PONTE_FISCAL_TOKEN) throw new Error('Ponte fiscal não configurada (PONTE_FISCAL_URL / PONTE_FISCAL_TOKEN).');
  // A ponte dorme sem uso (Fly autostop) e leva ~2 s para acordar: nesse intervalo quem responde
  // 502/503 é o Fly, sem JSON e sem o pedido chegar nela — só esse caso é repetido. O 502 da própria
  // ponte (erro ao falar com a SEFAZ/prefeitura) vem em JSON e não se repete: pode ter havido emissão.
  let r, dados;
  for (let tentativa = 0; ; tentativa++) {
    r = await fetch(env.PONTE_FISCAL_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ponte-token': env.PONTE_FISCAL_TOKEN },
      body: JSON.stringify(pedido),
    });
    dados = await r.json().catch(() => null);
    if (dados || ![502, 503].includes(r.status) || tentativa >= 3) break;
    await new Promise((ok) => setTimeout(ok, 2500));
  }
  if (!dados) dados = { erro: `ponte fiscal fora do ar (${r.status}). Tente de novo em 1 minuto.` };
  if (!r.ok) throw new Error(dados.erro || `ponte respondeu ${r.status}`);
  return dados;
}

/** Contexto de uma rodada: peças e fornecedores carregados uma vez só. */
async function carregarCadastros(DB) {
  const [pec, forn, ctl, ult] = await Promise.all([
    DB.prepare('SELECT id, nome, ean, codigo_forn, fornecedor_id FROM pecas').all(),
    DB.prepare('SELECT id, nome, cnpj FROM fornecedores').all(),
    DB.prepare("SELECT estoque_desde FROM dfe_controle WHERE id='3m'").first(),
    ultimoCodigo(DB),
  ]);
  return { pecas: pec.results || [], fornecedores: forn.results || [], estoqueDesde: (ctl && ctl.estoque_desde) || 0, ultCodigo: ult };
}

function fornecedorPara(ctx, stmts, DB, cnpj, nome, agora) {
  const c = soDigitos(cnpj);
  if (!c) return null;
  let f = ctx.fornecedores.find(x => soDigitos(x.cnpj) === c);
  if (!f) {
    f = { id: uid(), nome: nome || fmtCnpj(c), cnpj: fmtCnpj(c) };
    ctx.fornecedores.push(f);
    stmts.push(DB.prepare('INSERT INTO fornecedores (id,nome,cnpj,obs,criado,atualizado) VALUES (?,?,?,?,?,?)')
      .bind(f.id, f.nome, f.cnpj, 'Cadastrado pela nota fiscal de compra', agora, agora));
  }
  return f.id;
}

function pecaPara(ctx, stmts, DB, item, fornecedorId, agora) {
  const ean = /^\d{8,14}$/.test(item.ean || '') ? item.ean : null;
  let p = (ean && ctx.pecas.find(x => x.ean === ean))
    || (item.codigo && fornecedorId && ctx.pecas.find(x => x.fornecedor_id === fornecedorId && x.codigo_forn === item.codigo))
    || ctx.pecas.find(x => nomeNorm(x.nome) === nomeNorm(item.descricao));
  if (!p) {
    p = { id: uid(), nome: item.descricao, ean, codigo_forn: item.codigo, fornecedor_id: fornecedorId };
    ctx.pecas.push(p);
    // Preço de venda fica em branco: quem define é a oficina. O custo vem da nota.
    stmts.push(DB.prepare(`INSERT INTO pecas (id,nome,preco,ncm,cest,ean,unidade,custo,origem,codigo_forn,fornecedor_id,codigo,criado,atualizado)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(p.id, item.descricao, null, item.ncm, item.cest, ean, item.unidade, item.custoUnit ?? item.valorUnit, item.origem, item.codigo, fornecedorId,
        codigoPeca(++ctx.ultCodigo), agora, agora));
  } else {
    stmts.push(DB.prepare(`UPDATE pecas SET ncm=COALESCE(?,ncm), cest=COALESCE(?,cest), ean=COALESCE(ean,?), unidade=COALESCE(unidade,?),
      custo=COALESCE(?,custo), origem=COALESCE(?,origem), codigo_forn=COALESCE(codigo_forn,?), fornecedor_id=COALESCE(fornecedor_id,?) WHERE id=?`)
      .bind(item.ncm, item.cest, ean, item.unidade, item.custoUnit ?? item.valorUnit, item.origem, item.codigo, fornecedorId, p.id));
  }
  return p.id;
}

/** Grava os documentos de um lote. Devolve contagem por tipo. */
async function gravarDocumentos(DB, ctx, docs, agora) {
  const conta = { resumos: 0, completas: 0, eventos: 0, pecas_novas: 0 };
  const pecasAntes = ctx.pecas.length;
  const stmts = [];
  for (const d of docs) {
    const x = comNulos(d.dados || {}, CAMPOS_NOTA);
    if (!x.chave) continue;
    comNulos(d, ['nsu', 'xml']);
    (x.itens || []).forEach(it => comNulos(it, CAMPOS_ITEM));
    // Nota emitida antes da ativação do estoque = histórico (não soma no estoque).
    const hist = x.dhEmi && Date.parse(x.dhEmi) < ctx.estoqueDesde ? 1 : 0;
    if (d.tipo === 'resumo') {
      conta.resumos++;
      const status = x.situacao === '3' ? 'cancelada' : 'resumo';
      stmts.push(DB.prepare(`INSERT INTO nfe_entrada (chave,nsu,status,cnpj_emit,nome_emit,dh_emi,valor,situacao_sefaz,tp_nf,historico,criado,atualizado)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(chave) DO UPDATE SET situacao_sefaz=excluded.situacao_sefaz, atualizado=excluded.atualizado,
          status=CASE WHEN excluded.status='cancelada' THEN 'cancelada' ELSE nfe_entrada.status END`)
        .bind(x.chave, d.nsu, status, soDigitos(x.cnpjEmit), x.nomeEmit, x.dhEmi, x.valor, x.situacao, x.tpNF, hist, agora, agora));
    } else if (d.tipo === 'completa') {
      conta.completas++;
      const fornecedorId = fornecedorPara(ctx, stmts, DB, x.cnpjEmit, x.nomeEmit, agora);
      stmts.push(DB.prepare(`INSERT INTO nfe_entrada (chave,nsu,status,numero,serie,cnpj_emit,nome_emit,fornecedor_id,dh_emi,valor,tp_nf,xml,historico,criado,atualizado,rateio_un)
        VALUES (?,?,'completa',?,?,?,?,?,?,?,?,?,?,?,?,1)
        ON CONFLICT(chave) DO UPDATE SET numero=excluded.numero, serie=excluded.serie, nome_emit=excluded.nome_emit,
          fornecedor_id=excluded.fornecedor_id, dh_emi=excluded.dh_emi, valor=excluded.valor, tp_nf=excluded.tp_nf, xml=excluded.xml, rateio_un=1,
          atualizado=excluded.atualizado, status=CASE WHEN nfe_entrada.status='cancelada' THEN 'cancelada' ELSE 'completa' END`)
        .bind(x.chave, d.nsu, x.numero, x.serie, soDigitos(x.cnpjEmit), x.nomeEmit, fornecedorId, x.dhEmi, x.valor, x.tpNF, d.xml, hist, agora, agora));
      const custos = d.xml ? custosDoXml(d.xml) : {};
      const fiscal = d.xml ? fiscalDoXml(d.xml) : {};
      for (const it of x.itens || []) {
        const c = custos[it.nItem] || { v_frete: 0, v_seg: 0, v_desc: 0, v_outro: 0, v_ipi: 0, v_st: 0, custo_unit: it.valorUnit };
        it.custoUnit = c.custo_unit;
        const pecaId = pecaPara(ctx, stmts, DB, it, fornecedorId, agora);
        stmts.push(DB.prepare(`INSERT OR REPLACE INTO nfe_entrada_itens (id,chave,n_item,codigo,ean,descricao,ncm,cest,cfop,unidade,qtde,valor_unit,valor_total,origem,peca_id,
            v_frete,v_seg,v_desc,v_outro,v_ipi,v_st,custo_unit,icms_cst,pis_cst)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .bind(`${x.chave}-${it.nItem}`, x.chave, it.nItem, it.codigo, it.ean, it.descricao, it.ncm, it.cest, it.cfop, it.unidade,
            it.qtde, it.valorUnit, it.valorTotal, it.origem, pecaId, c.v_frete, c.v_seg, c.v_desc, c.v_outro, c.v_ipi, c.v_st, c.custo_unit,
            (fiscal[it.nItem] || {}).icms_cst || '-', (fiscal[it.nItem] || {}).pis_cst || null));
      }
    } else if (d.tipo === 'evento') {
      conta.eventos++;
      if (x.tpEvento === '110111') {
        stmts.push(DB.prepare(`INSERT INTO nfe_entrada (chave,status,criado,atualizado) VALUES (?,'cancelada',?,?)
          ON CONFLICT(chave) DO UPDATE SET status='cancelada', atualizado=excluded.atualizado`).bind(x.chave, agora, agora));
      }
    }
  }
  conta.pecas_novas = ctx.pecas.length - pecasAntes;
  if (stmts.length) await DB.batch(stmts);
  return conta;
}

async function sincronizar(DB, env) {
  const agora = Date.now();
  const ctl = (await DB.prepare("SELECT * FROM dfe_controle WHERE id='3m'").first()) || { ult_nsu: '0', espera_ate: 0 };
  const saida = { fim: false, resumos: 0, completas: 0, eventos: 0, pecas_novas: 0, ciencias: 0, avisos: [] };
  const ctx = await carregarCadastros(DB);
  let ult = ctl.ult_nsu || '0', max = ctl.max_nsu || null, espera = ctl.espera_ate || 0, status = ctl.ultimo_status || '';
  const somar = (c) => { for (const k of ['resumos', 'completas', 'eventos', 'pecas_novas']) saida[k] += c[k]; };

  // 1) Novos documentos da fila (respeitando a espera de 1 hora da SEFAZ).
  if (agora < espera) {
    saida.fim = true;
  } else {
    for (let i = 0; i < LOTES_POR_RODADA; i++) {
      const r = await ponte(env, { acao: 'distNSU', ultNSU: ult });
      status = `${r.cStat} ${r.xMotivo}`;
      if (r.cStat === '137') { espera = Date.now() + ESPERA_MS; saida.fim = true; break; }
      if (r.cStat === '656') {
        espera = Date.now() + ESPERA_MS; saida.fim = true;
        if (r.ultNSU && Number(r.ultNSU) > 0) ult = r.ultNSU;
        saida.avisos.push('A SEFAZ pediu para esperar 1 hora antes de consultar de novo (consumo indevido).');
        break;
      }
      if (r.cStat !== '138') throw new Error(`SEFAZ: ${status}`);
      somar(await gravarDocumentos(DB, ctx, r.docs || [], Date.now()));
      ult = r.ultNSU; max = r.maxNSU;
      await DB.prepare(`INSERT INTO dfe_controle (id,ult_nsu,max_nsu,espera_ate,ultima_execucao,ultimo_status) VALUES ('3m',?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET ult_nsu=excluded.ult_nsu, max_nsu=excluded.max_nsu, ultima_execucao=excluded.ultima_execucao, ultimo_status=excluded.ultimo_status`)
        .bind(ult, max, espera, Date.now(), status).run();
      if (Number(ult) >= Number(max)) { espera = Date.now() + ESPERA_MS; saida.fim = true; break; }
    }
  }
  await DB.prepare(`INSERT INTO dfe_controle (id,ult_nsu,max_nsu,espera_ate,ultima_execucao,ultimo_status) VALUES ('3m',?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET ult_nsu=excluded.ult_nsu, max_nsu=excluded.max_nsu, espera_ate=excluded.espera_ate,
      ultima_execucao=excluded.ultima_execucao, ultimo_status=excluded.ultimo_status`)
    .bind(ult, max, espera, Date.now(), status).run();

  // 2) Ciência da Operação nos resumos autorizados — libera o XML completo.
  // A SEFAZ só aceita a ciência até 10 dias depois da autorização (rejeição 596). Nota mais
  // velha fica só como resumo, sem chamar a SEFAZ. Recusa gravada em manifesto_msg não é
  // tentada de novo — senão o mesmo aviso voltaria a cada busca.
  await DB.prepare(`UPDATE nfe_entrada SET manifesto_msg='596 Fora do prazo de 10 dias para a ciência'
    WHERE status='resumo' AND manifestado IS NULL AND manifesto_msg IS NULL AND dh_emi IS NOT NULL
    AND julianday('now') - julianday(dh_emi) > ?`).bind(PRAZO_CIENCIA_DIAS).run();
  const pend = await DB.prepare(`SELECT chave FROM nfe_entrada WHERE status='resumo' AND situacao_sefaz='1' AND manifestado IS NULL
    AND manifesto_msg IS NULL ORDER BY dh_emi DESC LIMIT ?`).bind(CIENCIAS_POR_RODADA).all();
  for (const { chave } of pend.results || []) {
    try {
      const r = await ponte(env, { acao: 'ciencia', chave });
      // 135 = registrado; 573 = já havia ciência (duplicidade).
      const ok = r.cStat === '135' || r.cStat === '573';
      await DB.prepare('UPDATE nfe_entrada SET manifestado=?, manifesto_msg=? WHERE chave=?')
        .bind(ok ? Date.now() : null, `${r.cStat} ${r.xMotivo}`, chave).run();
      if (ok) saida.ciencias++;
      else if (r.cStat !== '596') saida.avisos.push(`Ciência ${chave.slice(25, 34)}: ${r.cStat} ${r.xMotivo}`);
    } catch (e) {
      saida.avisos.push(`Ciência ${chave.slice(25, 34)}: ${e.message}`);
    }
  }
  if ((pend.results || []).length === CIENCIAS_POR_RODADA) saida.fim = false;

  // 3) Notas com ciência há mais de 15 min que ainda não vieram completas: pede pela chave.
  const limite = Date.now() - ESPERA_COMPLETA_MS;
  const falta = await DB.prepare(`SELECT chave FROM nfe_entrada WHERE status='resumo' AND manifestado IS NOT NULL AND manifestado < ?
    AND (tentou_completar IS NULL OR tentou_completar < ?) ORDER BY dh_emi DESC LIMIT ?`)
    .bind(limite, Date.now() - ESPERA_MS, COMPLETAR_POR_RODADA).all();
  for (const { chave } of falta.results || []) {
    await DB.prepare('UPDATE nfe_entrada SET tentou_completar=? WHERE chave=?').bind(Date.now(), chave).run();
    try {
      const r = await ponte(env, { acao: 'consChNFe', chave });
      if (r.cStat === '138') somar(await gravarDocumentos(DB, ctx, r.docs || [], Date.now()));
    } catch (e) {
      saida.avisos.push(`Nota ${chave.slice(25, 34)}: ${e.message}`);
    }
  }

  saida.espera_ate = espera;
  saida.ultimo_status = status;
  return saida;
}

/**
 * Liga parte de um item da nota a um item de OS. Devolve a "origem" que o
 * navegador guarda dentro do item da OS (fornecedor, nota, custo real, NCM, código).
 */
async function destinar(DB, b) {
  const qtde = Number(b.qtde);
  if (!b.item_id || !b.ordem_id || !b.os_item_id || !(qtde > 0)) throw new Error('Informe a OS, o item e a quantidade.');
  const it = await DB.prepare(`SELECT i.*, n.nome_emit, n.cnpj_emit, n.fornecedor_id, n.numero, n.serie, n.dh_emi, n.status,
      p.codigo AS peca_codigo, (SELECT COALESCE(SUM(qtde),0) FROM nfe_destinos d WHERE d.item_id=i.id) AS destinado
    FROM nfe_entrada_itens i JOIN nfe_entrada n ON n.chave=i.chave LEFT JOIN pecas p ON p.id=i.peca_id WHERE i.id=?`).bind(b.item_id).first();
  if (!it) throw new Error('Item da nota não encontrado.');
  if (it.status === 'cancelada') throw new Error('Esta nota foi cancelada pelo fornecedor.');
  const saldo = (Number(it.qtde) || 0) - (Number(it.destinado) || 0);
  if (qtde > saldo + 1e-9) throw new Error(`Só restam ${saldo} deste item na nota.`);
  const id = uid(), agora = Date.now();
  await DB.prepare('INSERT INTO nfe_destinos (id,item_id,chave,ordem_id,os_item_id,qtde,quem,criado) VALUES (?,?,?,?,?,?,?,?)')
    .bind(id, it.id, it.chave, String(b.ordem_id), String(b.os_item_id), qtde, String(b.quem || ''), agora).run();
  return {
    destino_id: id, item_id: it.id, chave: it.chave, qtde,
    fornecedor: it.nome_emit, cnpj: it.cnpj_emit, fornecedor_id: it.fornecedor_id,
    nf: it.numero, serie: it.serie, data: it.dh_emi,
    custo: it.custo_unit ?? it.valor_unit, preco_nota: it.valor_unit, descricao: it.descricao, codigo_forn: it.codigo,
    ncm: it.ncm, cfop: it.cfop, peca_id: it.peca_id, peca_codigo: it.peca_codigo,
  };
}

/** Grava uma compra sem nota como entrada 'manual', com fornecedor e peças como as da SEFAZ. */
async function entradaManual(DB, b) {
  const itens = (b.itens || []).filter(i => String(i.descricao || '').trim() && Number(i.qtde) > 0);
  if (!itens.length) throw new Error('Informe ao menos uma peça com quantidade.');
  const nomeForn = String(b.fornecedor_nome || '').trim();
  if (!b.fornecedor_id && !nomeForn) throw new Error('Informe de quem foi comprado.');
  const agora = Date.now(), chave = 'MAN' + uid();
  const ctx = await carregarCadastros(DB);
  const stmts = [];
  let fornecedorId = b.fornecedor_id && ctx.fornecedores.some(f => f.id === b.fornecedor_id) ? b.fornecedor_id : null;
  if (!fornecedorId && soDigitos(b.cnpj)) fornecedorId = fornecedorPara(ctx, stmts, DB, b.cnpj, nomeForn, agora);
  if (!fornecedorId) {
    const f = ctx.fornecedores.find(x => nomeNorm(x.nome) === nomeNorm(nomeForn));
    if (f) fornecedorId = f.id;
    else {
      fornecedorId = uid();
      stmts.push(DB.prepare('INSERT INTO fornecedores (id,nome,cnpj,obs,criado,atualizado) VALUES (?,?,?,?,?,?)')
        .bind(fornecedorId, nomeForn, soDigitos(b.cnpj) ? fmtCnpj(soDigitos(b.cnpj)) : null, 'Cadastrado por compra sem nota', agora, agora));
    }
  }
  const forn = ctx.fornecedores.find(f => f.id === fornecedorId);
  const nome = (forn && forn.nome) || nomeForn;
  const data = /^\d{4}-\d{2}-\d{2}$/.test(b.data || '') ? b.data + 'T12:00:00-03:00' : new Date(agora).toISOString();
  const total = itens.reduce((s, i) => s + (Number(i.qtde) || 0) * (Number(i.custo) || 0), 0);
  const frete = Math.max(0, Number(b.frete) || 0);
  stmts.push(DB.prepare(`INSERT INTO nfe_entrada (chave,status,cnpj_emit,nome_emit,fornecedor_id,dh_emi,valor,historico,comprovante,obs,criado,atualizado,rateio_un)
    VALUES (?,'manual',?,?,?,?,?,0,?,?,?,?,1)`)
    .bind(chave, soDigitos(b.cnpj) || null, nome, fornecedorId, data, Math.round((total + frete) * 100) / 100, b.comprovante || null, String(b.obs || '').trim() || null, agora, agora));
  const porUnidade = rateioPorUnidade(frete, itens.reduce((s, i) => s + (Number(i.qtde) || 0), 0));
  itens.forEach((i, ix) => {
    const it = comNulos({ nItem: ix + 1, codigo: null, ean: null, descricao: String(i.descricao).trim(), ncm: soDigitos(i.ncm) || null, cest: null,
      cfop: null, unidade: i.unidade || 'UN', qtde: Number(i.qtde), valorUnit: Number(i.custo) || 0, valorTotal: 0, origem: null }, CAMPOS_ITEM);
    it.valorTotal = Math.round(it.qtde * it.valorUnit * 100) / 100;
    const vFrete = porUnidade * it.qtde;
    it.custoUnit = arred4(it.valorUnit + porUnidade);
    // Peça escolhida do cadastro: usa ela; senão procura pelo nome ou cria.
    let pecaId = i.peca_id && ctx.pecas.some(p => p.id === i.peca_id) ? i.peca_id : null;
    if (pecaId) stmts.push(DB.prepare('UPDATE pecas SET ncm=COALESCE(?,ncm), custo=? WHERE id=?').bind(it.ncm, it.custoUnit, pecaId));
    else pecaId = pecaPara(ctx, stmts, DB, it, fornecedorId, agora);
    stmts.push(DB.prepare(`INSERT INTO nfe_entrada_itens (id,chave,n_item,codigo,ean,descricao,ncm,cest,cfop,unidade,qtde,valor_unit,valor_total,origem,peca_id,v_frete,custo_unit,icms_cst)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'-')`)
      .bind(`${chave}-${it.nItem}`, chave, it.nItem, null, null, it.descricao, it.ncm, null, null, it.unidade, it.qtde, it.valorUnit, it.valorTotal, null, pecaId,
        Math.round(vFrete * 100) / 100, it.custoUnit));
  });
  await DB.batch(stmts);
  return { ok: true, chave };
}


// ---------- Regra fiscal de venda das peças ----------
//
// A 3M (Simples Nacional, CRT 1) vende peça sempre a consumidor final, dentro de GO.
// A regra de cada item sai de duas fontes, nesta ordem:
//   1. a nota de compra do fornecedor (vinda da SEFAZ): se o ICMS da substituição
//      tributária já foi pago (CST 10/30/60/70 ou CSOSN 201/202/203/500), a venda é
//      CSOSN 500; se não, CSOSN 102. Lubrificante usa o CFOP próprio (5656).
//   2. a Lei 10.485/2002 (autopeças monofásicas de PIS/Cofins): NCM do Anexo I = CST 04
//      (revenda a alíquota zero, art. 3º §2º); fora dela = CST 49 (Simples, outras saídas).
// O que a fonte não decide sozinha (NCM com "Ex", Anexo II, compra de fora de GO,
// fornecedor que tributou diferente) vira aviso "conferir" — nunca escolha silenciosa.
// Conferido no Planalto e no Normas Legais em 26/10/2026 (texto compilado da Lei 10.485).

const LEI_10485_ANEXO_I = ['4016.10.10', '4016.99.90*', '68.13', '7007.11.00', '7007.21.00', '7009.10.00', '7320.10.00*',
  '8301.20.00', '8302.30.00', '8407.33.90', '8407.34.90', '8408.20', '8409.91', '8409.99', '8413.30', '8413.91.00*',
  '8414.80.21', '8414.80.22', '8415.20', '8421.23.00', '8421.31.00', '8431.41.00', '8431.42.00', '8433.90.90',
  '8481.80.99*', '8483.10', '8483.20.00', '8483.30', '8483.40', '8483.50', '8505.20', '8507.10.00', '85.11', '8512.20',
  '8512.30.00', '8512.40', '8512.90.00', '8527.2', '8536.50.90*', '8539.10', '8544.30.00', '8706.00', '87.07', '87.08',
  '9029.20.10', '9029.90.10', '9030.39.21', '9031.80.40', '9032.89.2', '9104.00.00', '9401.20.00'];
// Anexo II: peças para tratores e máquinas (84.29, 84.32, 84.33, 87.01…). Na oficina de carros raramente vale.
const LEI_10485_ANEXO_II = ['40.09', '8408.90.90', '8412.21.10', '8412.21.90', '8412.31.10', '8413.60.19', '8414.80.19',
  '8414.90.39', '8432.40.00', '8432.80.00', '8432.90.00', '8481.10.00', '8481.20.90', '8481.80.92', '8483.60.1', '8501.10.19'];
// Pneus e câmaras: revenda a alíquota zero (Lei 10.485, art. 5º, parágrafo único).
const LEI_10485_ART5 = ['40.11', '40.13'];

const prefixos = (lista) => lista.map(c => ({ p: c.replace(/[.*]/g, ''), ex: c.endsWith('*'), cod: c.replace('*', '') }));
const ANEXO_I = prefixos(LEI_10485_ANEXO_I), ANEXO_II = prefixos(LEI_10485_ANEXO_II), ART5 = prefixos(LEI_10485_ART5);

// O que cada "Ex" do Anexo I cobre (texto da TIPI a que a lei se refere). Com o texto
// conhecido, o sistema compara com a descrição da peça e decide, mostrando a fonte; sem
// texto de fonte confiável, a peça fica em "Conferir" — nunca se chuta.
const EX_LEI_10485 = {
  '40169990': { ex: 'Ex 03 e Ex 05', texto: 'Ex 03 — tapetes próprios para ônibus ou caminhões; Ex 05 — tapetes próprios para veículos automóveis, exceto ônibus ou caminhões',
    cobre: (d) => /\btapete/i.test(d), fonte: 'TIPI (Decreto 4.542/2002), citada no Anexo I da Lei 10.485' },
  '85365090': { ex: 'Ex 01', texto: 'Ex 01 — interruptor de embutir ou sobrepor (rotativo ou de alavanca) para sistema elétrico de 24 V, próprio para ônibus ou caminhões',
    cobre: (d) => /interrupt|comutador|chave/i.test(d) && /24\s*v|onibus|ônibus|caminh/i.test(d), fonte: 'Decreto 4.542/2002, art. 6º, e Decreto 6.006/2006 (Anexo I da Lei 10.485)' },
  // 7320.10.00 Ex 01, 8413.91.00 Ex 01 e 8481.80.99 Ex 01/02: texto não localizado em fonte oficial (26/10/2026).
};

function monofasico(ncm, descricao) {
  const n = soDigitos(ncm);
  if (!n) return { mono: false, conferir: true, motivo: 'Peça sem NCM: não dá para saber se é monofásica.' };
  const a1 = ANEXO_I.find(x => n.startsWith(x.p));
  if (a1 && a1.ex) {
    const ex = EX_LEI_10485[a1.p];
    if (!ex) return { mono: true, conferir: true, motivo: `NCM ${a1.cod} está no Anexo I da Lei 10.485 só para alguns itens ("Ex"), e o texto desse "Ex" não foi localizado em fonte oficial: confirmar se esta peça é um deles.` };
    const desc = String(descricao || '');
    if (!desc.trim()) return { mono: false, conferir: true, motivo: `NCM ${a1.cod}: a lei só inclui ${ex.ex} (${ex.texto}). Sem a descrição da peça, confirmar se ela é um desses itens.` };
    const cobre = ex.cobre(desc);
    return { mono: cobre, conferir: false, ex,
      motivo: `NCM ${a1.cod}: a Lei 10.485 só inclui o ${ex.ex} (${ex.texto}). "${desc.slice(0, 60)}" ${cobre ? 'é um desses itens → monofásica' : 'não é um desses itens → não é monofásica'}. Fonte: ${ex.fonte}.` };
  }
  if (a1) return { mono: true, conferir: false, motivo: `NCM ${a1.cod} está no Anexo I da Lei 10.485 (autopeça monofásica): revenda a alíquota zero.` };
  // NCM 2022 desdobrou alguns códigos da lei (ex.: 8413.91.00 → 8413.91.10/90): mesmo começo, outro final.
  const a1n = ANEXO_I.find(x => x.p.length === 8 && x.p.endsWith('00') && n.length === 8 && n.slice(0, 6) === x.p.slice(0, 6));
  if (a1n) return { mono: true, conferir: true, motivo: `NCM ${n.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1.$2.$3')} parece um desdobramento do código ${a1n.cod} da Lei 10.485 (a NCM mudou depois da lei): confirmar se continua monofásica.` };
  const p5 = ART5.find(x => n.startsWith(x.p));
  if (p5) return { mono: true, conferir: false, motivo: `NCM ${p5.cod} (pneu/câmara): revenda a alíquota zero pelo art. 5º da Lei 10.485.` };
  const a2 = ANEXO_II.find(x => n.startsWith(x.p));
  if (a2) return { mono: false, conferir: true, motivo: `NCM ${a2.cod} está no Anexo II da Lei 10.485, que vale só para peças de tratores e máquinas: confirmar.` };
  return { mono: false, conferir: false, motivo: 'NCM fora das listas da Lei 10.485: PIS/Cofins normal.' };
}

const CST_ICMS_COM_ST = ['10', '30', '60', '70', '201', '202', '203', '500'];
const LUBRIFICANTE = (ncm, cfop) => /^271019/.test(soDigitos(ncm)) || /^[56]65\d$/.test(String(cfop || ''));

/**
 * Regra de venda de um item comprado. `it` = linha de nfe_entrada_itens (com icms_cst,
 * pis_cst, cfop, cest, origem, ncm) e `nota` = a nota de compra (status, nome_emit, numero).
 */
function regraVenda(it, nota) {
  const motivos = [], avisos = [];
  const fonte = nota.status === 'manual' ? 'compra sem nota' : `nota ${nota.numero || ''} de ${nota.nome_emit || 'fornecedor'}`.trim();
  const lub = LUBRIFICANTE(it.ncm, it.cfop);
  let st = null;
  if (nota.status === 'manual') {
    avisos.push('Compra sem nota: não há como saber se o ICMS da substituição tributária foi pago. Usado o cálculo sem ST (paga ICMS no DAS) até o contador confirmar.');
    st = false;
  } else if (it.icms_cst) {
    st = CST_ICMS_COM_ST.includes(String(it.icms_cst));
    motivos.push(st
      ? `Na ${fonte} o ICMS veio com CST ${it.icms_cst}: a substituição tributária já foi paga pelo fornecedor → CSOSN 500 (não paga ICMS de novo).`
      : `Na ${fonte} o ICMS veio com CST ${it.icms_cst}, sem substituição tributária → CSOSN 102 (o ICMS entra no DAS).`);
    // Em GO a maioria das autopeças vem sem ST mesmo tendo CEST: é nota, não aviso (o
    // contador confirma uma vez na tela, para todas).
    if (!st && it.cest) motivos.push(`Obs.: a peça tem CEST ${it.cest} (lista nacional de ST), mas em GO o fornecedor vendeu sem ST.`);
    if (/^6/.test(String(it.cfop || ''))) avisos.push('Compra de fora de Goiás: a ST pode ter de ser paga por antecipação na entrada. Confirmar com o contador.');
  } else {
    st = false;
    avisos.push(`Não foi possível ler o ICMS da ${fonte}. Usado o cálculo sem ST até conferir.`);
  }
  const cfop = lub ? '5656' : (st ? '5405' : '5102');
  // Cliente de outro estado (raro): sem ST 6102, como o contador orientou; com ST já
  // retida 6404; lubrificante 6656.
  const cfopFora = lub ? '6656' : (st ? '6404' : '6102');
  if (lub) motivos.push('Lubrificante: CFOP 5656 (venda de lubrificante comprado de terceiros a consumidor final).');
  else motivos.push(`CFOP ${cfop}: venda a consumidor final dentro de GO ${st ? 'de mercadoria com ST já paga' : 'de mercadoria sem ST (5102/6102 e CSOSN 102 confirmados pelo contador em 26/10/2026)'}.`);
  motivos.push(`Cliente de outro estado: CFOP ${cfopFora}.`);

  const m = monofasico(it.ncm, it.descricao);
  const pis = m.mono ? '04' : '49';
  motivos.push(m.motivo + ` → PIS/Cofins CST ${pis}.`);
  if (m.conferir) avisos.push(m.motivo);
  const fornMono = String(it.pis_cst || '') === '04';
  if (nota.status !== 'manual' && it.pis_cst && fornMono !== m.mono)
    avisos.push(`O fornecedor usou PIS CST ${it.pis_cst}, e a lei indica ${pis}. O sistema segue a lei; vale o contador confirmar.`);

  return { cfop, cfop_fora: cfopFora, csosn: st ? '500' : '102', pis_cst: pis, cofins_cst: pis, origem: it.origem ?? '0', st, mono: m.mono,
    ncm: soDigitos(it.ncm) || null, cest: soDigitos(it.cest) || null,
    lubrificante: lub, motivos, avisos, conferir: avisos.length > 0, fonte };
}

/** Lê do XML da compra o ICMS (CST ou CSOSN) e o CST de PIS de cada item. */
function fiscalDoXml(xml) {
  const itens = {};
  for (const d of xml.matchAll(/<det\s+nItem="(\d+)"\s*>([\s\S]*?)<\/det>/g)) {
    const icms = (d[2].match(/<ICMS>([\s\S]*?)<\/ICMS>/) || [, ''])[1];
    const pis = (d[2].match(/<PIS>([\s\S]*?)<\/PIS>/) || [, ''])[1];
    itens[d[1]] = { icms_cst: (icms.match(/<(?:CST|CSOSN)>(\d+)<\//) || [])[1] || null, pis_cst: (pis.match(/<CST>(\d+)<\//) || [])[1] || null };
  }
  return itens;
}

/** Preenche ICMS/PIS da compra nos itens gravados antes desta regra (um lote por pedido). */
async function recalcularFiscal(DB) {
  await DB.prepare(`UPDATE nfe_entrada_itens SET icms_cst='-' WHERE icms_cst IS NULL
    AND chave IN (SELECT chave FROM nfe_entrada WHERE status='manual')`).run();
  const r = await DB.prepare(`SELECT n.chave, n.xml FROM nfe_entrada n WHERE n.xml IS NOT NULL
    AND EXISTS (SELECT 1 FROM nfe_entrada_itens i WHERE i.chave=n.chave AND i.icms_cst IS NULL) LIMIT 40`).all();
  const notas = r.results || [];
  if (!notas.length) return;
  const stmts = [];
  for (const n of notas) {
    for (const [nItem, f] of Object.entries(fiscalDoXml(n.xml)))
      stmts.push(DB.prepare('UPDATE nfe_entrada_itens SET icms_cst=?, pis_cst=? WHERE id=?').bind(f.icms_cst || '-', f.pis_cst, `${n.chave}-${nItem}`));
    stmts.push(DB.prepare("UPDATE nfe_entrada_itens SET icms_cst='-' WHERE chave=? AND icms_cst IS NULL").bind(n.chave));
  }
  await DB.batch(stmts);
}
const comRegra = (i, n) => ({ ...i, icms_cst: i.icms_cst === '-' ? null : i.icms_cst });

/**
 * Regras por peça: a de cada compra (a OS usa a da nota ligada) + a regra ajustada ou
 * aprovada pelo contador, guardada em pecas.regra_fiscal.
 */
async function regrasPorPeca(DB) {
  const [pec, its] = await Promise.all([
    DB.prepare('SELECT id, codigo, nome, ncm, regra_fiscal FROM pecas').all(),
    DB.prepare(`SELECT i.id, i.peca_id, i.descricao, i.ncm, i.cfop, i.cest, i.origem, i.icms_cst, i.pis_cst, i.qtde,
        n.chave, n.status, n.nome_emit, n.numero, n.dh_emi FROM nfe_entrada_itens i JOIN nfe_entrada n ON n.chave=i.chave
      WHERE n.status IN ('completa','manual') AND i.peca_id IS NOT NULL ORDER BY n.dh_emi DESC`).all(),
  ]);
  const porPeca = {};
  for (const i of its.results || []) {
    const r = regraVenda(comRegra(i), i);
    (porPeca[i.peca_id] ||= []).push({ item_id: i.id, chave: i.chave, fornecedor: i.nome_emit, nf: i.numero, data: i.dh_emi, regra: r });
  }
  return (pec.results || []).filter(p => porPeca[p.id] || p.regra_fiscal).map(p => {
    const compras = porPeca[p.id] || [];
    const sugerida = compras[0] ? compras[0].regra : null;
    const chaveRegra = (r) => r ? [r.cfop, r.csosn, r.pis_cst].join('/') : '';
    const diferentes = [...new Set(compras.map(c => chaveRegra(c.regra)))];
    let salva = null; try { salva = p.regra_fiscal ? JSON.parse(p.regra_fiscal) : null; } catch (e) { salva = null; }
    const avisos = [...(sugerida ? sugerida.avisos : [])];
    if (diferentes.length > 1) avisos.push(`Compras desta peça com regras diferentes (${diferentes.join(' · ')}). Em cada OS vale a regra da nota ligada à peça.`);
    if (salva && salva.tipo === 'aprovada' && salva.base !== chaveRegra(sugerida)) avisos.push('A regra sugerida mudou desde a aprovação (nova compra). Conferir de novo.');
    const status = salva && salva.tipo === 'ajustada' ? 'ajustada'
      : (salva && salva.tipo === 'aprovada' && salva.base === chaveRegra(sugerida) ? 'aprovada' : (avisos.length ? 'conferir' : 'automatica'));
    return { peca_id: p.id, codigo: p.codigo, nome: p.nome, ncm: p.ncm, sugerida, compras: compras.slice(0, 10), salva, avisos, status,
      efetiva: salva && salva.tipo === 'ajustada' ? salva.regra : sugerida };
  }).sort((a, b) => ({ conferir: 0, automatica: 1, ajustada: 2, aprovada: 3 }[a.status] - { conferir: 0, automatica: 1, ajustada: 2, aprovada: 3 }[b.status]) || String(a.nome).localeCompare(String(b.nome)));
}

async function salvarRegra(DB, b) {
  const p = await DB.prepare('SELECT id FROM pecas WHERE id=?').bind(String(b.peca_id || '')).first();
  if (!p) throw new Error('Peça não encontrada.');
  let valor = null;
  if (b.acao === 'aprovar') valor = { tipo: 'aprovada', base: String(b.base || ''), por: String(b.quem || ''), em: Date.now(), obs: String(b.obs || '') };
  else if (b.acao === 'ajustar') {
    const r = b.regra || {};
    if (!/^\d{4}$/.test(r.cfop || '') || !/^\d{3}$/.test(r.csosn || '') || !/^\d{2}$/.test(r.pis_cst || '')) throw new Error('Informe CFOP (4 dígitos), CSOSN (3) e CST de PIS/Cofins (2).');
    if (!String(b.obs || '').trim()) throw new Error('Escreva o motivo do ajuste (ex.: orientação do contador).');
    valor = { tipo: 'ajustada', regra: { cfop: r.cfop, cfop_fora: r.cfop.replace(/^5/, '6'), csosn: r.csosn, pis_cst: r.pis_cst, cofins_cst: r.pis_cst, st: r.csosn === '500', mono: r.pis_cst === '04',
      lubrificante: /^56/.test(r.cfop), motivos: ['Regra ajustada à mão: ' + String(b.obs).trim()], avisos: [] }, por: String(b.quem || ''), em: Date.now(), obs: String(b.obs).trim() };
  }
  await DB.prepare('UPDATE pecas SET regra_fiscal=? WHERE id=?').bind(valor ? JSON.stringify(valor) : null, p.id).run();
  return { ok: true };
}


// ---------- Emissão de NF-e (55) e NFC-e (65) de peças ----------
//
// O sistema monta o <infNFe> no mesmo formato da NF-e 353 (aceita pela SEFAZ-GO em
// 23/10/2026), já na forma canônica; a ponte assina, põe o QR Code (NFC-e) e envia.
// A numeração só avança quando a SEFAZ autoriza (ou acusa duplicidade).

// Emitente: vem de Fiscal → Empresa (functions/_lib/empresa.js); emitirNota passa em n.emit.
const EMITENTE = emitenteNFe({ ...EMPRESA_PADRAO, codUF: COD_UF[EMPRESA_PADRAO.uf] });
const HOMOLOG_NOME = 'NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL';
const HOMOLOG_ITEM = 'NOTA FISCAL EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL';
// Próximo número de produção sem controle gravado: informado em Fiscal → Nota de peças.
const NUMERO_INICIAL = {};

const xmlTexto = (s, max) => String(s ?? '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim()
  .slice(0, max || 500).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const el = (nome, valor) => `<${nome}>${valor}</${nome}>`;
const dec = (n, c) => (Math.round((Number(n) || 0) * 10 ** c) / 10 ** c).toFixed(c);
const dataHoraGO = (t = Date.now()) => new Date(t - 3 * 3600000).toISOString().slice(0, 19) + '-03:00';

function dvChave(c43) {
  let soma = 0, peso = 2;
  for (let i = c43.length - 1; i >= 0; i--) { soma += Number(c43[i]) * peso; peso = peso === 9 ? 2 : peso + 1; }
  const r = soma % 11; return r < 2 ? 0 : 11 - r;
}

/** Monta o infNFe (forma canônica) a partir da OS conferida na tela. */
function montarInfNFe(n) {
  const mod = String(n.modelo), tpAmb = Number(n.tpAmb), serie = String(n.serie), nNF = String(n.numero);
  const dhEmi = dataHoraGO();
  const aamm = dhEmi.slice(2, 4) + dhEmi.slice(5, 7);
  const cNF = String(n.cNF).padStart(8, '0');
  const E = n.emit || EMITENTE;
  const c43 = E.cUF + aamm + E.CNPJ + mod.padStart(2, '0') + serie.padStart(3, '0') + nNF.padStart(9, '0') + '1' + cNF;
  const cDV = dvChave(c43), chave = c43 + cDV;
  const nfce = mod === '65';
  const d = n.dest || {};
  const foraGO = !nfce && d.UF && d.UF !== E.UF; // cliente de outro estado

  const ide = el('cUF', E.cUF) + el('cNF', cNF) + el('natOp', 'VENDA') + el('mod', mod) + el('serie', serie) + el('nNF', nNF) +
    el('dhEmi', dhEmi) + el('tpNF', '1') + el('idDest', foraGO ? '2' : '1') + el('cMunFG', E.cMun) + el('tpImp', nfce ? '4' : '1') +
    el('tpEmis', '1') + el('cDV', String(cDV)) + el('tpAmb', String(tpAmb)) + el('finNFe', '1') + el('indFinal', '1') + el('indPres', '1') +
    el('procEmi', '0') + el('verProc', '3M-Gestao-1.0');
  const emit = el('CNPJ', E.CNPJ) + el('xNome', xmlTexto(E.xNome, 60)) + el('xFant', xmlTexto(E.xFant, 60)) +
    el('enderEmit', el('xLgr', xmlTexto(E.xLgr, 60)) + el('nro', xmlTexto(E.nro, 60)) + (E.xCpl ? el('xCpl', xmlTexto(E.xCpl, 60)) : '') + el('xBairro', xmlTexto(E.xBairro, 60)) +
      el('cMun', E.cMun) + el('xMun', xmlTexto(E.xMun, 60)) + el('UF', E.UF) + el('CEP', E.CEP) + el('cPais', '1058') + el('xPais', 'BRASIL') + (E.fone ? el('fone', E.fone) : '')) + el('IE', E.IE) + el('CRT', E.CRT);

  let dest = '';
  const doc = soDigitos(d.doc);
  if (doc || !nfce) {
    if (!(doc.length === 11 || doc.length === 14)) throw new Error('Informe o CPF ou CNPJ do cliente.');
    const nome = tpAmb === 2 ? HOMOLOG_NOME : xmlTexto(d.nome, 60);
    dest = el(doc.length === 14 ? 'CNPJ' : 'CPF', doc) + (nome ? el('xNome', nome) : '');
    if (!nfce) {
      for (const [k, rot] of [['xLgr', 'rua'], ['nro', 'número'], ['xBairro', 'bairro'], ['cMun', 'código do município'], ['xMun', 'cidade'], ['UF', 'UF'], ['CEP', 'CEP']])
        if (!String(d[k] || '').trim()) throw new Error(`Endereço do cliente incompleto: falta ${rot}.`);
      dest += el('enderDest', el('xLgr', xmlTexto(d.xLgr, 60)) + el('nro', xmlTexto(d.nro, 60)) + (d.xCpl ? el('xCpl', xmlTexto(d.xCpl, 60)) : '') +
        el('xBairro', xmlTexto(d.xBairro, 60)) + el('cMun', soDigitos(d.cMun)) + el('xMun', xmlTexto(d.xMun, 60)) + el('UF', xmlTexto(d.UF, 2)) +
        el('CEP', soDigitos(d.CEP)) + el('cPais', '1058') + el('xPais', 'BRASIL') + (soDigitos(d.fone).length >= 10 ? el('fone', soDigitos(d.fone)) : ''));
    }
    const ie = soDigitos(d.IE);
    const indIE = !nfce && doc.length === 14 && ie ? '1' : '9';
    dest += el('indIEDest', indIE) + (indIE === '1' ? el('IE', ie) : '') + (!nfce && d.email ? el('email', xmlTexto(d.email, 60)) : '');
    dest = el('dest', dest);
  }

  let vProdT = 0, vDescT = 0, det = '';
  n.itens.forEach((it, ix) => {
    const r = it.regra || {};
    if (!/^\d{8}$/.test(soDigitos(it.ncm))) throw new Error(`Peça "${it.nome}" sem NCM.`);
    if (!/^\d{4}$/.test(r.cfop || '') || !/^(102|500)$/.test(r.csosn || '') || !/^(04|49)$/.test(r.pis_cst || '')) throw new Error(`Peça "${it.nome}" sem regra fiscal completa.`);
    const q = Number(it.qtde), vUn = Number(it.valorUnit);
    if (!(q > 0) || !(vUn > 0)) throw new Error(`Peça "${it.nome}" com quantidade ou valor zerado.`);
    const vProd = Math.round(q * vUn * 100) / 100, vDesc = Math.round((Number(it.desconto) || 0) * 100) / 100;
    vProdT += vProd; vDescT += vDesc;
    const cfop = foraGO ? (r.cfop_fora || r.cfop.replace(/^5/, '6')) : r.cfop;
    const xProd = tpAmb === 2 && nfce && ix === 0 ? HOMOLOG_ITEM : xmlTexto(it.nome, 120);
    const prod = el('cProd', xmlTexto(it.codigo || String(ix + 1).padStart(4, '0'), 60)) + el('cEAN', 'SEM GTIN') + el('xProd', xProd) +
      el('NCM', soDigitos(it.ncm)) + (/^\d{7}$/.test(soDigitos(it.cest)) ? el('CEST', soDigitos(it.cest)) : '') + el('CFOP', cfop) +
      el('uCom', 'UN') + el('qCom', dec(q, 4)) + el('vUnCom', dec(vUn, 10)) + el('vProd', dec(vProd, 2)) + el('cEANTrib', 'SEM GTIN') +
      el('uTrib', 'UN') + el('qTrib', dec(q, 4)) + el('vUnTrib', dec(vUn, 10)) + (vDesc > 0 ? el('vDesc', dec(vDesc, 2)) : '') + el('indTot', '1');
    const orig = /^[0-8]$/.test(String(it.origem ?? '')) ? String(it.origem) : '0';
    const icms = el('ICMS', el(r.csosn === '500' ? 'ICMSSN500' : 'ICMSSN102', el('orig', orig) + el('CSOSN', r.csosn)));
    const pis = r.pis_cst === '04' ? el('PIS', el('PISNT', el('CST', '04')))
      : el('PIS', el('PISOutr', el('CST', '49') + el('vBC', '0.00') + el('pPIS', '0.0000') + el('vPIS', '0.00')));
    const cofins = r.pis_cst === '04' ? el('COFINS', el('COFINSNT', el('CST', '04')))
      : el('COFINS', el('COFINSOutr', el('CST', '49') + el('vBC', '0.00') + el('pCOFINS', '0.0000') + el('vCOFINS', '0.00')));
    det += `<det nItem="${ix + 1}">${el('prod', prod)}${el('imposto', icms + pis + cofins)}</det>`;
  });
  const vNF = Math.round((vProdT - vDescT) * 100) / 100;
  const z = '0.00';
  const total = el('total', el('ICMSTot', el('vBC', z) + el('vICMS', z) + el('vICMSDeson', z) + el('vFCP', z) + el('vBCST', z) + el('vST', z) +
    el('vFCPST', z) + el('vFCPSTRet', z) + el('vProd', dec(vProdT, 2)) + el('vFrete', z) + el('vSeg', z) + el('vDesc', dec(vDescT, 2)) + el('vII', z) +
    el('vIPI', z) + el('vIPIDevol', z) + el('vPIS', z) + el('vCOFINS', z) + el('vOutro', z) + el('vNF', dec(vNF, 2)) + el('vTotTrib', z)));

  const tPag = String(n.pagamento || '01').padStart(2, '0');
  const cartao = ['03', '04'].includes(tPag) ? el('card', el('tpIntegra', '2')) : '';
  const pag = el('pag', el('detPag', el('tPag', tPag) + (tPag === '99' ? el('xPag', 'Outros') : '') + el('vPag', dec(vNF, 2)) + cartao));
  const infCpl = xmlTexto([E.textoSimples, n.os ? 'OS ' + n.os : ''].filter(Boolean).join(' '), 5000);
  const rt = n.respTec && n.respTec.email ? el('infRespTec', el('CNPJ', E.CNPJ) + el('xContato', xmlTexto(n.respTec.contato || 'Suporte', 60)) +
    el('email', xmlTexto(n.respTec.email, 60)) + el('fone', soDigitos(n.respTec.fone || E.fone))) : '';

  const infNFe = `<infNFe Id="NFe${chave}" versao="4.00">${el('ide', ide)}${el('emit', emit)}${dest}${det}${total}${el('transp', el('modFrete', '9'))}${pag}` +
    `${el('infAdic', el('infCpl', infCpl))}${rt}</infNFe>`;
  return { infNFe, chave, dhEmi, vNF, vProd: vProdT, vDesc: vDescT };
}

async function garantirTabelasEmissao(DB) {
  await DB.batch([
    DB.prepare(`CREATE TABLE IF NOT EXISTS nfe_saida (id TEXT PRIMARY KEY, ordem_id TEXT, modelo TEXT, serie TEXT, numero INTEGER, tp_amb INTEGER,
      chave TEXT, status TEXT, cstat TEXT, xmotivo TEXT, nprot TEXT, dh_emi TEXT, valor REAL, dest_doc TEXT, dest_nome TEXT, dados TEXT,
      xml TEXT, qrcode TEXT, url_chave TEXT, cancel_xml TEXT, cancel_prot TEXT, cancel_just TEXT, quem TEXT, criado INTEGER, atualizado INTEGER)`),
    DB.prepare('CREATE INDEX IF NOT EXISTS idx_nfe_saida_os ON nfe_saida (ordem_id)'),
    DB.prepare('CREATE TABLE IF NOT EXISTS nfe_numeracao (id TEXT PRIMARY KEY, proximo INTEGER)'),
    DB.prepare('CREATE TABLE IF NOT EXISTS fiscal_config (chave TEXT PRIMARY KEY, valor TEXT)'),
  ]);
}

async function configEmissao(DB) {
  const [c, nums] = await Promise.all([DB.prepare('SELECT chave, valor FROM fiscal_config').all(), DB.prepare('SELECT * FROM nfe_numeracao').all()]);
  const cfg = {}; (c.results || []).forEach(r => { cfg[r.chave] = r.valor; });
  const proximo = {}; (nums.results || []).forEach(r => { proximo[r.id] = r.proximo; });
  for (const id of ['2-55-1', '2-65-1', '1-55-1', '1-65-1'])
    if (proximo[id] == null) proximo[id] = id.startsWith('2-') ? 1 : (NUMERO_INICIAL[id] ?? null);
  return { tpAmb: cfg.tp_amb === '1' ? 1 : 2, serie: { 55: cfg.serie_55 || '1', 65: cfg.serie_65 || '1' }, proximo,
    respTec: { contato: cfg.resp_contato || '', email: cfg.resp_email || '', fone: cfg.resp_fone || '' } };
}

async function salvarConfigEmissao(DB, b) {
  const stmts = [];
  const put = (k, v) => stmts.push(DB.prepare('INSERT INTO fiscal_config (chave,valor) VALUES (?,?) ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor').bind(k, String(v)));
  if (b.tpAmb === 1 || b.tpAmb === 2) put('tp_amb', b.tpAmb);
  if (b.respTec) { put('resp_contato', b.respTec.contato || ''); put('resp_email', b.respTec.email || ''); put('resp_fone', b.respTec.fone || ''); }
  if (b.proximo && /^[12]-(55|65)-\d{1,3}$/.test(b.proximo.id) && Number(b.proximo.valor) >= 1)
    stmts.push(DB.prepare('INSERT INTO nfe_numeracao (id,proximo) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET proximo=excluded.proximo').bind(b.proximo.id, Math.floor(Number(b.proximo.valor))));
  if (stmts.length) await DB.batch(stmts);
  return configEmissao(DB);
}

/** Emite a nota: numera, monta, manda pela ponte, grava. */
async function emitirNota(DB, env, b) {
  const cfg = await configEmissao(DB);
  const modelo = String(b.modelo) === '55' ? '55' : '65';
  const tpAmb = cfg.tpAmb, serie = cfg.serie[modelo];
  const idNum = `${tpAmb}-${modelo}-${serie}`;
  const numero = cfg.proximo[idNum];
  if (!numero) throw new Error(`Informe em Fiscal → Emissão o próximo número da ${modelo === '65' ? 'NFC-e' : 'NF-e'} de produção (série ${serie}).`);
  if (!Array.isArray(b.itens) || !b.itens.length) throw new Error('Nenhuma peça para a nota.');
  const cNF = String(Math.floor(10000000 + Math.random() * 89999999));
  const emit = emitenteNFe(await carregarEmpresa(DB));
  if (!emit.cUF) throw new Error('UF da empresa inválida (Fiscal → Empresa).');
  const nota = montarInfNFe({ emit, modelo, tpAmb, serie, numero, cNF, dest: b.dest, itens: b.itens, pagamento: b.pagamento, os: b.os, respTec: cfg.respTec });
  const r = await ponte(env, { acao: 'nfe_autorizar', infNFe: nota.infNFe });
  const agora = Date.now(), id = uid();
  const dup = ['204', '539'].includes(String(r.cStat));
  const status = r.autorizada ? 'autorizada' : 'rejeitada';
  await DB.batch([
    DB.prepare(`INSERT INTO nfe_saida (id,ordem_id,modelo,serie,numero,tp_amb,chave,status,cstat,xmotivo,nprot,dh_emi,valor,dest_doc,dest_nome,dados,xml,qrcode,url_chave,quem,criado,atualizado)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(id, String(b.ordem_id || ''), modelo, serie, numero, tpAmb, nota.chave, status, r.cStat || null, r.xMotivo || null, r.nProt || null,
        nota.dhEmi, nota.vNF, soDigitos((b.dest || {}).doc) || null, (b.dest || {}).nome || null,
        JSON.stringify({ dest: b.dest || null, itens: b.itens, pagamento: b.pagamento, os: b.os || null }), r.xml || null, r.qrCode || null, r.urlChave || null,
        String(b.quem || ''), agora, agora),
    ...(r.autorizada || dup ? [DB.prepare('INSERT INTO nfe_numeracao (id,proximo) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET proximo=excluded.proximo').bind(idNum, numero + 1)] : []),
  ]);
  return { id, status, modelo, numero, serie, tpAmb, chave: nota.chave, cStat: r.cStat, xMotivo: r.xMotivo, nProt: r.nProt,
    aviso: dup ? 'A SEFAZ já tinha este número: o sistema pulou para o próximo. Tente emitir de novo.' : null };
}

async function cancelarNota(DB, env, b) {
  const n = await DB.prepare('SELECT * FROM nfe_saida WHERE id=?').bind(String(b.id || '')).first();
  if (!n || n.status !== 'autorizada') throw new Error('Só dá para cancelar nota autorizada.');
  const just = String(b.xJust || '').trim();
  if (just.length < 15) throw new Error('Escreva o motivo do cancelamento (mínimo de 15 letras).');
  const r = await ponte(env, { acao: 'nfe_cancelar', chave: n.chave, nProt: n.nprot, xJust: just, tpAmb: n.tp_amb });
  // 573 = duplicidade de evento: uma tentativa anterior já cancelou na SEFAZ, mas a resposta se perdeu.
  if (!r.cancelada && r.cStat === '573') {
    await DB.prepare("UPDATE nfe_saida SET status='cancelada', cancel_just=?, atualizado=? WHERE id=?")
      .bind(just + ' (cancelamento já estava registrado na SEFAZ)', Date.now(), n.id).run();
    return { ok: true, jaCancelada: true };
  }
  if (!r.cancelada) throw new Error(`SEFAZ: ${r.cStat} ${r.xMotivo}`);
  await DB.prepare("UPDATE nfe_saida SET status='cancelada', cancel_xml=?, cancel_prot=?, cancel_just=?, atualizado=? WHERE id=?")
    .bind(r.xml, r.nProt, just, Date.now(), n.id).run();
  return { ok: true, nProt: r.nProt };
}

/** DANFE em HTML para imprimir/salvar em PDF: A4 (NF-e) ou cupom 80 mm com QR Code (NFC-e). */
function danfeHtml(n) {
  const x = n.xml || '';
  const t = (s, nome) => { const m = s.match(new RegExp(`<${nome}>([\\s\\S]*?)</${nome}>`)); return m ? m[1] : ''; };
  const ide = t(x, 'ide'), emit = t(x, 'emit'), dest = t(x, 'dest'), tot = t(x, 'ICMSTot');
  const itens = [...x.matchAll(/<det nItem="(\d+)">([\s\S]*?)<\/det>/g)].map(d => ({ n: d[1], p: t(d[2], 'prod'), i: d[2] }));
  const brl = v => 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const num = v => Number(v || 0).toLocaleString('pt-BR', { maximumFractionDigits: 4 });
  const chaveF = (n.chave || '').replace(/(\d{4})/g, '$1 ').trim();
  const homolog = Number(n.tp_amb) === 2;
  const cancel = n.status === 'cancelada';
  const marca = (homolog ? '<div class="marca">HOMOLOGAÇÃO — SEM VALOR FISCAL</div>' : '') + (cancel ? '<div class="marca">CANCELADA</div>' : '');
  const destDoc = t(dest, 'CNPJ') || t(dest, 'CPF');
  const dh = (t(ide, 'dhEmi') || '').replace('T', ' ').slice(0, 19);
  const scripts = `<script src="https://cdnjs.cloudflare.com/ajax/libs/jsbarcode/3.11.6/JsBarcode.all.min.js"></script>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>`;
  if (n.modelo === '65') {
    return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>NFC-e ${n.numero}</title><meta name="viewport" content="width=device-width,initial-scale=1">
    <style>body{font:12px/1.35 monospace;margin:0;background:#fff;color:#000}.c{width:76mm;margin:0 auto;padding:4mm 2mm}.ct{text-align:center}hr{border:0;border-top:1px dashed #000}
    table{width:100%;border-collapse:collapse}td{vertical-align:top}.r{text-align:right}.marca{border:2px solid #000;text-align:center;font-weight:bold;margin:4px 0;padding:2px}
    #qr{display:flex;justify-content:center;margin:6px 0}.bt{font:14px sans-serif;margin:10px auto;display:block}@media print{.bt{display:none}@page{size:80mm auto;margin:0}}</style>${scripts}</head>
    <body><div class="c"><div class="ct"><b>${t(emit, 'xNome')}</b><br>CNPJ ${t(emit, 'CNPJ').replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5')} IE ${t(emit, 'IE')}<br>
    AV MADRI, 101, QD 174 LT 22, JARDIM EUROPA, GOIANIA/GO<hr>Documento Auxiliar da Nota Fiscal de Consumidor Eletrônica</div>${marca}<hr>
    <table><tr><td>Item</td><td class="r">Qtd</td><td class="r">Unit.</td><td class="r">Total</td></tr>
    ${itens.map(i => `<tr><td colspan="4">${i.n} ${t(i.p, 'cProd')} ${t(i.p, 'xProd')}</td></tr><tr><td></td><td class="r">${num(t(i.p, 'qCom'))} UN</td><td class="r">${num(t(i.p, 'vUnCom'))}</td><td class="r">${num(t(i.p, 'vProd'))}</td></tr>`).join('')}</table><hr>
    <table><tr><td>Qtde. total de itens</td><td class="r">${itens.length}</td></tr><tr><td>Valor total</td><td class="r">${brl(t(tot, 'vProd'))}</td></tr>
    ${Number(t(tot, 'vDesc')) > 0 ? `<tr><td>Desconto</td><td class="r">${brl(t(tot, 'vDesc'))}</td></tr>` : ''}<tr><td><b>Valor a pagar</b></td><td class="r"><b>${brl(t(tot, 'vNF'))}</b></td></tr></table><hr>
    <div class="ct">Consulte pela chave de acesso em<br>${n.url_chave || ''}<br><b>${chaveF}</b><hr>
    ${destDoc ? `CONSUMIDOR ${destDoc.length === 14 ? 'CNPJ' : 'CPF'} ${destDoc}${t(dest, 'xNome') ? '<br>' + t(dest, 'xNome') : ''}` : 'CONSUMIDOR NÃO IDENTIFICADO'}<hr>
    NFC-e nº ${n.numero} Série ${n.serie} ${dh}<br>Protocolo de autorização ${n.nprot || '—'}<br>Data de autorização ${n.dh_emi ? n.dh_emi.replace('T', ' ').slice(0, 19) : ''}
    <div id="qr"></div>${t(x, 'infCpl')}</div></div>
    <button class="bt" onclick="print()">Imprimir / salvar PDF</button>
    <script>new QRCode(document.getElementById('qr'),{text:${JSON.stringify(n.qrcode || '')},width:150,height:150,correctLevel:QRCode.CorrectLevel.M});</script></body></html>`;
  }
  const dEnd = t(dest, 'enderDest');
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>DANFE NF-e ${n.numero}</title>
  <style>body{font:10px/1.3 Arial,sans-serif;margin:0;background:#fff;color:#000}.p{width:200mm;margin:0 auto;padding:5mm}.b{border:1px solid #000;padding:2px 4px;margin:-1px 0 0 -1px}
  .g{display:flex}.g>.b{flex:1}.l{font-size:7px;text-transform:uppercase;color:#333}h1{font-size:14px;margin:0}table{width:100%;border-collapse:collapse}th,td{border:1px solid #000;padding:2px 3px}
  th{font-size:7px;text-transform:uppercase}.r{text-align:right}.c{text-align:center}.marca{border:2px solid #000;text-align:center;font-weight:bold;font-size:14px;margin:4px 0;padding:3px}
  .bt{font:14px sans-serif;margin:10px auto;display:block}@media print{.bt{display:none}@page{size:A4;margin:5mm}}</style>${scripts}</head>
  <body><div class="p">${marca}
  <div class="g"><div class="b" style="flex:2"><h1>${t(emit, 'xNome')}</h1>AV MADRI, 101 - QD 174 LT 22 - JARDIM EUROPA, Goiânia/GO - CEP 74330-550 - Fone 6231000115</div>
  <div class="b c"><b style="font-size:13px">DANFE</b><br>Documento Auxiliar da Nota Fiscal Eletrônica<br>1 - Saída<br><b>Nº ${String(n.numero).padStart(9, '0').replace(/(\d{3})(\d{3})(\d{3})/, '$1.$2.$3')}<br>SÉRIE ${n.serie}</b></div>
  <div class="b" style="flex:2"><svg id="bc"></svg><div class="l">Chave de acesso</div><b>${chaveF}</b><div>Consulta de autenticidade no portal nacional da NF-e www.nfe.fazenda.gov.br/portal</div></div></div>
  <div class="g"><div class="b" style="flex:2"><div class="l">Natureza da operação</div>${t(ide, 'natOp')}</div><div class="b" style="flex:2"><div class="l">Protocolo de autorização de uso</div>${n.nprot || '—'} - ${(n.dh_emi || '').replace('T', ' ').slice(0, 19)}</div></div>
  <div class="g"><div class="b"><div class="l">Inscrição estadual</div>${t(emit, 'IE')}</div><div class="b"><div class="l">CNPJ</div>${t(emit, 'CNPJ').replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5')}</div></div>
  <b>DESTINATÁRIO/REMETENTE</b>
  <div class="g"><div class="b" style="flex:3"><div class="l">Nome/Razão social</div>${t(dest, 'xNome')}</div><div class="b"><div class="l">CNPJ/CPF</div>${destDoc}</div><div class="b"><div class="l">Data da emissão</div>${dh.slice(0, 10).split('-').reverse().join('/')}</div></div>
  <div class="g"><div class="b" style="flex:3"><div class="l">Endereço</div>${t(dEnd, 'xLgr')}, ${t(dEnd, 'nro')} ${t(dEnd, 'xCpl')}</div><div class="b"><div class="l">Bairro</div>${t(dEnd, 'xBairro')}</div><div class="b"><div class="l">CEP</div>${t(dEnd, 'CEP')}</div></div>
  <div class="g"><div class="b" style="flex:2"><div class="l">Município</div>${t(dEnd, 'xMun')}</div><div class="b"><div class="l">UF</div>${t(dEnd, 'UF')}</div><div class="b"><div class="l">Inscrição estadual</div>${t(dest, 'IE')}</div></div>
  <b>CÁLCULO DO IMPOSTO</b>
  <div class="g">${[['Base de cálculo do ICMS', 'vBC'], ['Valor do ICMS', 'vICMS'], ['Base cálc. ICMS ST', 'vBCST'], ['Valor do ICMS ST', 'vST'], ['Valor total dos produtos', 'vProd']].map(([l, k]) => `<div class="b"><div class="l">${l}</div><div class="r">${num(t(tot, k))}</div></div>`).join('')}</div>
  <div class="g">${[['Valor do frete', 'vFrete'], ['Valor do seguro', 'vSeg'], ['Desconto', 'vDesc'], ['Outras despesas', 'vOutro'], ['Valor do IPI', 'vIPI'], ['Valor total da nota', 'vNF']].map(([l, k]) => `<div class="b"><div class="l">${l}</div><div class="r">${num(t(tot, k))}</div></div>`).join('')}</div>
  <b>TRANSPORTADOR/VOLUMES TRANSPORTADOS</b><div class="b">Frete: 9 - Sem frete</div>
  <b>DADOS DO PRODUTO/SERVIÇO</b>
  <table><tr><th>Código</th><th>Descrição</th><th>NCM</th><th>CSOSN</th><th>CFOP</th><th>Un</th><th>Qtd</th><th>Vlr unit.</th><th>Vlr total</th></tr>
  ${itens.map(i => `<tr><td>${t(i.p, 'cProd')}</td><td>${t(i.p, 'xProd')}</td><td>${t(i.p, 'NCM')}</td><td class="c">${t(i.i, 'orig')}${t(i.i, 'CSOSN')}</td><td>${t(i.p, 'CFOP')}</td><td>${t(i.p, 'uCom')}</td><td class="r">${num(t(i.p, 'qCom'))}</td><td class="r">${num(t(i.p, 'vUnCom'))}</td><td class="r">${num(t(i.p, 'vProd'))}</td></tr>`).join('')}</table>
  <b>DADOS ADICIONAIS</b><div class="b" style="min-height:20mm">${t(x, 'infCpl')}${cancel ? '<br><b>NOTA CANCELADA</b> — ' + (n.cancel_just || '') : ''}</div></div>
  <button class="bt" onclick="print()">Imprimir / salvar PDF</button>
  <script>JsBarcode('#bc',${JSON.stringify(n.chave || '')},{format:'CODE128C',height:40,width:1.1,displayValue:false,margin:0});</script></body></html>`;
}

/** Saldo por peça, só das notas que contam no estoque, com as notas de onde vem. */
async function estoque(DB) {
  const r = await DB.prepare(`SELECT i.id, i.peca_id, i.descricao, i.unidade, i.qtde, COALESCE(i.custo_unit, i.valor_unit) AS valor_unit, i.ncm, n.chave, n.nome_emit, n.numero, n.dh_emi,
      p.codigo, p.nome AS peca_nome, (SELECT COALESCE(SUM(qtde),0) FROM nfe_destinos d WHERE d.item_id=i.id) AS destinado
    FROM nfe_entrada_itens i JOIN nfe_entrada n ON n.chave=i.chave LEFT JOIN pecas p ON p.id=i.peca_id
    WHERE n.status IN ('completa','manual') AND COALESCE(n.historico,0)=0 ORDER BY n.dh_emi`).all();
  const porPeca = {};
  for (const i of r.results || []) {
    const saldo = (Number(i.qtde) || 0) - (Number(i.destinado) || 0);
    if (saldo <= 1e-9) continue;
    const k = i.peca_id || i.id;
    const p = (porPeca[k] ||= { peca_id: i.peca_id, codigo: i.codigo, nome: i.peca_nome || i.descricao, ncm: i.ncm, unidade: i.unidade, saldo: 0, valor: 0, origens: [] });
    p.saldo += saldo; p.valor += saldo * (Number(i.valor_unit) || 0);
    p.origens.push({ item_id: i.id, chave: i.chave, fornecedor: i.nome_emit, nf: i.numero, data: i.dh_emi, saldo, custo: i.valor_unit });
  }
  return Object.values(porPeca).map(p => ({ ...p, custo_medio: p.saldo ? p.valor / p.saldo : 0 }))
    .sort((a, b) => String(a.nome).localeCompare(String(b.nome)));
}

export async function onRequest(context) {
  const { request, env } = context;
  const DB = env.DB;
  if (!DB) return jsonResp({ error: 'Banco D1 não conectado (binding DB ausente).' }, 500);
  const url = new URL(request.url);
  const acao = url.pathname.split('/').filter(Boolean)[3] || ''; // ['gestao','api','fiscal','<acao>']

  try {
    await garantirTabelas(DB);

    if (request.method === 'GET' && acao === 'notas') {
      const [notas, itens, dest, ctl] = await Promise.all([
        DB.prepare(`SELECT chave,nsu,status,numero,serie,cnpj_emit,nome_emit,fornecedor_id,dh_emi,valor,situacao_sefaz,tp_nf,manifestado,manifesto_msg,historico,comprovante,obs,criado,conferida,conferida_por
          FROM nfe_entrada ORDER BY dh_emi DESC LIMIT 500`).all(),
        DB.prepare(`SELECT i.*, p.codigo AS peca_codigo FROM nfe_entrada_itens i
          JOIN (SELECT chave FROM nfe_entrada ORDER BY dh_emi DESC LIMIT 500) n ON n.chave=i.chave
          LEFT JOIN pecas p ON p.id=i.peca_id ORDER BY i.chave, i.n_item`).all(),
        DB.prepare('SELECT id,item_id,ordem_id,os_item_id,qtde,quem,criado FROM nfe_destinos').all(),
        DB.prepare("SELECT * FROM dfe_controle WHERE id='3m'").first(),
      ]);
      const notaPorChave = {}; (notas.results || []).forEach(n => { notaPorChave[n.chave] = n; });
      const destPorItem = {};
      (dest.results || []).forEach(d => { (destPorItem[d.item_id] ||= []).push(d); });
      const porNota = {};
      (itens.results || []).forEach(i => {
        const ds = destPorItem[i.id] || [];
        i.destinos = ds;
        i.saldo = (Number(i.qtde) || 0) - ds.reduce((s, d) => s + (Number(d.qtde) || 0), 0);
        i.regra = notaPorChave[i.chave] ? regraVenda(comRegra(i), notaPorChave[i.chave]) : null;
        (porNota[i.chave] ||= []).push(i);
      });
      return jsonResp({
        notas: (notas.results || []).map(n => ({ ...n, nova: notaNova(n), itens: porNota[n.chave] || [] })),
        controle: ctl || null,
        configurada: !!(env.PONTE_FISCAL_URL && env.PONTE_FISCAL_TOKEN),
      });
    }

    if (request.method === 'GET' && acao === 'xml') {
      const chave = soDigitos(url.searchParams.get('chave'));
      const n = await DB.prepare('SELECT xml FROM nfe_entrada WHERE chave=?').bind(chave).first();
      if (!n || !n.xml) return jsonResp({ error: 'XML ainda não disponível para esta nota' }, 404);
      return new Response(n.xml, { headers: {
        'content-type': 'application/xml; charset=utf-8',
        'content-disposition': `attachment; filename="NFe${chave}.xml"`,
        'cache-control': 'no-store',
      } });
    }

    if (request.method === 'POST' && acao === 'sincronizar') return jsonResp(await sincronizar(DB, env));
    if (request.method === 'POST' && acao === 'diagnostico') {
      const d = await ponte(env, { diagnostico: true });
      // WSDL da NFS-e (público para quem tem certificado): guardado para consulta, fora da resposta.
      const wsdl = d.nfse && d.nfse.homologacao && d.nfse.homologacao.wsdl;
      if (wsdl) {
        await DB.prepare("INSERT INTO fiscal_config (chave,valor) VALUES ('nfse_wsdl',?) ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor").bind(wsdl).run();
        delete d.nfse.homologacao.wsdl;
      }
      return jsonResp(d);
    }

    if (request.method === 'GET' && acao === 'estoque') return jsonResp({ pecas: await estoque(DB) });
    if (request.method === 'GET' && acao === 'alertas') {
      const [lista, n, auto] = await Promise.all([
        DB.prepare(`SELECT chave,numero,nome_emit,valor,dh_emi,status FROM nfe_entrada WHERE ${SQL_NOVA} ORDER BY dh_emi DESC LIMIT 6`).all(),
        DB.prepare(`SELECT COUNT(*) AS n FROM nfe_entrada WHERE ${SQL_NOVA}`).first(),
        DB.prepare("SELECT valor FROM fiscal_config WHERE chave='auto_ultima'").first(),
      ]);
      let ultimaAuto = null; try { ultimaAuto = auto ? JSON.parse(auto.valor) : null; } catch (e) { /* ignora */ }
      return jsonResp({ novas: n ? n.n : 0, lista: lista.results || [], auto: ultimaAuto });
    }
    if (request.method === 'GET' && acao === 'regras') return jsonResp({ pecas: await regrasPorPeca(DB) });
    if (request.method === 'GET' && acao === 'regra_ncm') {
      const st = url.searchParams.get('st') === '1';
      const r = regraVenda({ ncm: url.searchParams.get('ncm'), descricao: url.searchParams.get('desc') || '', icms_cst: st ? '60' : '00', cfop: '' },{ status: 'completa', numero: '', nome_emit: 'informação manual' });
      r.motivos = r.motivos.map(m => m.replace(/^Na nota\s+de informação manual/, 'Informado à mão'));
      return jsonResp({ regra: r });
    }
    if (request.method === 'GET' && acao === 'emissao_config') return jsonResp(await configEmissao(DB));
    if (request.method === 'GET' && acao === 'nfse_config') return jsonResp(await configNfse(DB));
    if (request.method === 'GET' && acao === 'empresa') return jsonResp(await carregarEmpresa(DB));
    if (request.method === 'GET' && acao === 'nfse_saidas') {
      const oid = url.searchParams.get('ordem_id');
      const r = await DB.prepare(`SELECT id,ordem_id,tp_amb,serie,n_dps,chave,numero,status,erros,valor,desconto,iss_retido,tomador_doc,tomador_nome,descricao,cancel_just,quem,criado
        FROM nfse_saida ${oid ? 'WHERE ordem_id=?' : ''} ORDER BY criado DESC LIMIT 300`).bind(...(oid ? [oid] : [])).all();
      return jsonResp({ notas: r.results || [] });
    }
    if (request.method === 'GET' && acao === 'nfse_danfse') {
      const n = await DB.prepare('SELECT * FROM nfse_saida WHERE id=?').bind(String(url.searchParams.get('id') || '')).first();
      if (!n || !n.xml) return new Response('Nota de serviço não encontrada ou não autorizada.', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
      const links = await linksNfse(DB, (p) => ponte(env, p), n);
      return new Response(danfseHtml(n, links, await carregarEmpresa(DB)), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
    }
    if (request.method === 'GET' && acao === 'nfse_xml') {
      const n = await DB.prepare('SELECT * FROM nfse_saida WHERE id=?').bind(String(url.searchParams.get('id') || '')).first();
      const cancel = url.searchParams.get('evento') === 'cancelamento';
      const xml = n && (cancel ? n.cancel_xml : n.xml);
      if (!xml) return new Response('Nota de serviço não encontrada ou sem XML.', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
      return new Response(xml, { headers: { 'content-type': 'application/xml; charset=utf-8',
        'content-disposition': `attachment; filename="NFSe-${n.numero || n.n_dps}${cancel ? '-cancelamento' : ''}.xml"`, 'cache-control': 'no-store' } });
    }
    if (request.method === 'GET' && acao === 'saidas') {
      const oid = url.searchParams.get('ordem_id');
      const r = await DB.prepare(`SELECT id,ordem_id,modelo,serie,numero,tp_amb,chave,status,cstat,xmotivo,nprot,dh_emi,valor,dest_doc,dest_nome,cancel_just,quem,criado
        FROM nfe_saida ${oid ? 'WHERE ordem_id=?' : ''} ORDER BY criado DESC LIMIT 300`).bind(...(oid ? [oid] : [])).all();
      return jsonResp({ notas: r.results || [] });
    }
    if (request.method === 'GET' && (acao === 'danfe' || acao === 'xml_saida')) {
      const n = await DB.prepare('SELECT * FROM nfe_saida WHERE id=?').bind(String(url.searchParams.get('id') || '')).first();
      if (!n || !n.xml) return new Response('Nota não encontrada ou não autorizada.', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
      if (acao === 'danfe') return new Response(danfeHtml(n), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
      const cancel = url.searchParams.get('evento') === 'cancelamento';
      if (cancel && !n.cancel_xml) return new Response('Sem cancelamento.', { status: 404 });
      return new Response(cancel ? n.cancel_xml : n.xml, { headers: { 'content-type': 'application/xml; charset=utf-8',
        'content-disposition': `attachment; filename="${n.chave}${cancel ? '-cancelamento' : ''}-${n.modelo === '65' ? 'nfce' : 'nfe'}.xml"`, 'cache-control': 'no-store' } });
    }

    if (request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      if (acao === 'destinar') return jsonResp(await destinar(DB, body));
      if (acao === 'desfazer_destino') {
        await DB.prepare('DELETE FROM nfe_destinos WHERE id=?').bind(String(body.id || '')).run();
        return jsonResp({ ok: true });
      }
      if (acao === 'entrada_manual') return jsonResp(await entradaManual(DB, body));
      if (acao === 'excluir_manual') {
        const chave = String(body.chave || '');
        const n = await DB.prepare("SELECT status FROM nfe_entrada WHERE chave=?").bind(chave).first();
        if (!n || n.status !== 'manual') throw new Error('Só dá para excluir entrada sem nota.');
        const d = await DB.prepare('SELECT COUNT(*) AS n FROM nfe_destinos WHERE chave=?').bind(chave).first();
        if (d && d.n) throw new Error('Desfaça antes os destinos desta entrada.');
        await DB.batch([DB.prepare('DELETE FROM nfe_entrada_itens WHERE chave=?').bind(chave), DB.prepare('DELETE FROM nfe_entrada WHERE chave=?').bind(chave)]);
        return jsonResp({ ok: true });
      }
      if (acao === 'regra') return jsonResp(await salvarRegra(DB, body));
      if (acao === 'emissao_config') {
        // Trocar para produção ou mexer na numeração: só o administrador.
        if (!(context.data.usuario && context.data.usuario.papel === 'admin')) return jsonResp({ error: 'Só o administrador muda o ambiente e a numeração das notas.' }, 403);
        return jsonResp(await salvarConfigEmissao(DB, body));
      }
      if (acao === 'nfe_status') return jsonResp(await ponte(env, { acao: 'nfe_status', tpAmb: (await configEmissao(DB)).tpAmb }));
      if (acao === 'emitir') return jsonResp(await emitirNota(DB, env, body));
      if (acao === 'empresa') {
        if (!(context.data.usuario && context.data.usuario.papel === 'admin')) return jsonResp({ error: 'Só o administrador muda os dados da empresa.' }, 403);
        return jsonResp(await salvarEmpresa(DB, body));
      }
      if (acao === 'nfse_config') {
        if (!(context.data.usuario && context.data.usuario.papel === 'admin')) return jsonResp({ error: 'Só o administrador muda o ambiente da nota de serviço.' }, 403);
        return jsonResp(await salvarConfigNfse(DB, body));
      }
      if (acao === 'nfse_emitir') return jsonResp(await emitirNfse(DB, (p) => ponte(env, p), body, context.data.usuario && context.data.usuario.nome));
      if (acao === 'nfse_cancelar') return jsonResp(await cancelarNfse(DB, (p) => ponte(env, p), body));
      if (acao === 'cancelar_nota') return jsonResp(await cancelarNota(DB, env, body));
      if (acao === 'conferir') {
        const quem = (context.data.usuario && context.data.usuario.nome) || '';
        if (body.todas) await DB.prepare(`UPDATE nfe_entrada SET conferida=?, conferida_por=? WHERE ${SQL_NOVA}`).bind(Date.now(), quem).run();
        else await DB.prepare('UPDATE nfe_entrada SET conferida=?, conferida_por=? WHERE chave=? AND conferida IS NULL').bind(Date.now(), quem, String(body.chave || '')).run();
        return jsonResp({ ok: true });
      }
      if (acao === 'historico') {
        await DB.prepare('UPDATE nfe_entrada SET historico=? WHERE chave=?').bind(body.valor ? 1 : 0, soDigitos(body.chave)).run();
        return jsonResp({ ok: true });
      }
    }

    return jsonResp({ error: 'rota não encontrada' }, 404);
  } catch (e) {
    return jsonResp({ error: String((e && e.message) || e) }, 500);
  }
}
