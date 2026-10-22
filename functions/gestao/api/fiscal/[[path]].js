/**
 * Notas fiscais de compra (Parte A): busca na SEFAZ as NF-e emitidas contra o
 * CNPJ da 3M (Distribuição de DF-e), faz a Ciência da Operação e monta o
 * cadastro de peças e fornecedores a partir dos itens.
 *
 * Rota: /gestao/api/fiscal/*   |   Binding: DB (D1)   |   Protegida pelo Cloudflare Access.
 * Quem fala com a SEFAZ é a ponte fiscal (ponte-fiscal/, Fly.io), que guarda o
 * certificado A1. Segredos (Cloudflare): PONTE_FISCAL_URL, PONTE_FISCAL_TOKEN.
 *
 *   GET  notas              lista das notas de compra com os itens (sem o XML)
 *   GET  xml?chave=         baixa o XML da nota
 *   POST sincronizar        uma rodada de busca; o navegador repete até vir fim:true
 *   POST diagnostico        confere ponte, certificado e conexão com a SEFAZ
 */

// Regra da SEFAZ: sem documentos novos (137) ou já no fim da fila, esperar 1 hora
// antes de consultar de novo — senão ela bloqueia por "consumo indevido" (656).
const ESPERA_MS = 65 * 60 * 1000;
const LOTES_POR_RODADA = 3;     // cada lote traz até 50 documentos
const CIENCIAS_POR_RODADA = 10;
const COMPLETAR_POR_RODADA = 5;
// Depois da ciência a SEFAZ leva alguns minutos para liberar o XML completo.
const ESPERA_COMPLETA_MS = 15 * 60 * 1000;

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
  for (const col of ['ncm TEXT', 'cest TEXT', 'ean TEXT', 'unidade TEXT', 'custo REAL', 'origem TEXT', 'codigo_forn TEXT', 'fornecedor_id TEXT']) {
    try { await DB.prepare(`ALTER TABLE pecas ADD COLUMN ${col}`).run(); } catch (e) { /* coluna já existe */ }
  }
}

async function ponte(env, pedido) {
  if (!env.PONTE_FISCAL_URL || !env.PONTE_FISCAL_TOKEN) throw new Error('Ponte fiscal não configurada (PONTE_FISCAL_URL / PONTE_FISCAL_TOKEN).');
  const r = await fetch(env.PONTE_FISCAL_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ponte-token': env.PONTE_FISCAL_TOKEN },
    body: JSON.stringify(pedido),
  });
  const dados = await r.json().catch(() => ({ erro: `ponte respondeu ${r.status}` }));
  if (!r.ok) throw new Error(dados.erro || `ponte respondeu ${r.status}`);
  return dados;
}

/** Contexto de uma rodada: peças e fornecedores carregados uma vez só. */
async function carregarCadastros(DB) {
  const [pec, forn] = await Promise.all([
    DB.prepare('SELECT id, nome, ean, codigo_forn, fornecedor_id FROM pecas').all(),
    DB.prepare('SELECT id, nome, cnpj FROM fornecedores').all(),
  ]);
  return { pecas: pec.results || [], fornecedores: forn.results || [] };
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
    stmts.push(DB.prepare(`INSERT INTO pecas (id,nome,preco,ncm,cest,ean,unidade,custo,origem,codigo_forn,fornecedor_id,criado,atualizado)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(p.id, item.descricao, null, item.ncm, item.cest, ean, item.unidade, item.valorUnit, item.origem, item.codigo, fornecedorId, agora, agora));
  } else {
    stmts.push(DB.prepare(`UPDATE pecas SET ncm=COALESCE(?,ncm), cest=COALESCE(?,cest), ean=COALESCE(ean,?), unidade=COALESCE(unidade,?),
      custo=COALESCE(?,custo), origem=COALESCE(?,origem), codigo_forn=COALESCE(codigo_forn,?), fornecedor_id=COALESCE(fornecedor_id,?) WHERE id=?`)
      .bind(item.ncm, item.cest, ean, item.unidade, item.valorUnit, item.origem, item.codigo, fornecedorId, p.id));
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
    if (d.tipo === 'resumo') {
      conta.resumos++;
      const status = x.situacao === '3' ? 'cancelada' : 'resumo';
      stmts.push(DB.prepare(`INSERT INTO nfe_entrada (chave,nsu,status,cnpj_emit,nome_emit,dh_emi,valor,situacao_sefaz,tp_nf,criado,atualizado)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(chave) DO UPDATE SET situacao_sefaz=excluded.situacao_sefaz, atualizado=excluded.atualizado,
          status=CASE WHEN excluded.status='cancelada' THEN 'cancelada' ELSE nfe_entrada.status END`)
        .bind(x.chave, d.nsu, status, soDigitos(x.cnpjEmit), x.nomeEmit, x.dhEmi, x.valor, x.situacao, x.tpNF, agora, agora));
    } else if (d.tipo === 'completa') {
      conta.completas++;
      const fornecedorId = fornecedorPara(ctx, stmts, DB, x.cnpjEmit, x.nomeEmit, agora);
      stmts.push(DB.prepare(`INSERT INTO nfe_entrada (chave,nsu,status,numero,serie,cnpj_emit,nome_emit,fornecedor_id,dh_emi,valor,tp_nf,xml,criado,atualizado)
        VALUES (?,?,'completa',?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(chave) DO UPDATE SET numero=excluded.numero, serie=excluded.serie, nome_emit=excluded.nome_emit,
          fornecedor_id=excluded.fornecedor_id, dh_emi=excluded.dh_emi, valor=excluded.valor, tp_nf=excluded.tp_nf, xml=excluded.xml,
          atualizado=excluded.atualizado, status=CASE WHEN nfe_entrada.status='cancelada' THEN 'cancelada' ELSE 'completa' END`)
        .bind(x.chave, d.nsu, x.numero, x.serie, soDigitos(x.cnpjEmit), x.nomeEmit, fornecedorId, x.dhEmi, x.valor, x.tpNF, d.xml, agora, agora));
      for (const it of x.itens || []) {
        const pecaId = pecaPara(ctx, stmts, DB, it, fornecedorId, agora);
        stmts.push(DB.prepare(`INSERT OR REPLACE INTO nfe_entrada_itens (id,chave,n_item,codigo,ean,descricao,ncm,cest,cfop,unidade,qtde,valor_unit,valor_total,origem,peca_id)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .bind(`${x.chave}-${it.nItem}`, x.chave, it.nItem, it.codigo, it.ean, it.descricao, it.ncm, it.cest, it.cfop, it.unidade,
            it.qtde, it.valorUnit, it.valorTotal, it.origem, pecaId));
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
  const pend = await DB.prepare(`SELECT chave FROM nfe_entrada WHERE status='resumo' AND situacao_sefaz='1' AND manifestado IS NULL
    ORDER BY dh_emi DESC LIMIT ?`).bind(CIENCIAS_POR_RODADA).all();
  for (const { chave } of pend.results || []) {
    try {
      const r = await ponte(env, { acao: 'ciencia', chave });
      // 135 = registrado; 573 = já havia ciência (duplicidade).
      const ok = r.cStat === '135' || r.cStat === '573';
      await DB.prepare('UPDATE nfe_entrada SET manifestado=?, manifesto_msg=? WHERE chave=?')
        .bind(ok ? Date.now() : null, `${r.cStat} ${r.xMotivo}`, chave).run();
      if (ok) saida.ciencias++; else saida.avisos.push(`Ciência ${chave.slice(25, 34)}: ${r.cStat} ${r.xMotivo}`);
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

export async function onRequest(context) {
  const { request, env } = context;
  const DB = env.DB;
  if (!DB) return jsonResp({ error: 'Banco D1 não conectado (binding DB ausente).' }, 500);
  const url = new URL(request.url);
  const acao = url.pathname.split('/').filter(Boolean)[3] || ''; // ['gestao','api','fiscal','<acao>']

  try {
    await garantirTabelas(DB);

    if (request.method === 'GET' && acao === 'notas') {
      const [notas, itens, ctl] = await Promise.all([
        DB.prepare(`SELECT chave,nsu,status,numero,serie,cnpj_emit,nome_emit,fornecedor_id,dh_emi,valor,situacao_sefaz,tp_nf,manifestado,manifesto_msg,criado
          FROM nfe_entrada ORDER BY dh_emi DESC LIMIT 500`).all(),
        DB.prepare(`SELECT i.* FROM nfe_entrada_itens i JOIN (SELECT chave FROM nfe_entrada ORDER BY dh_emi DESC LIMIT 500) n ON n.chave=i.chave
          ORDER BY i.chave, i.n_item`).all(),
        DB.prepare("SELECT * FROM dfe_controle WHERE id='3m'").first(),
      ]);
      const porNota = {};
      (itens.results || []).forEach(i => { (porNota[i.chave] ||= []).push(i); });
      return jsonResp({
        notas: (notas.results || []).map(n => ({ ...n, itens: porNota[n.chave] || [] })),
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
    if (request.method === 'POST' && acao === 'diagnostico') return jsonResp(await ponte(env, { diagnostico: true }));

    return jsonResp({ error: 'rota não encontrada' }, 404);
  } catch (e) {
    return jsonResp({ error: String((e && e.message) || e) }, 500);
  }
}
