/**
 * NFS-e (mão de obra das OS) — NotaControl / ISS.net, padrão nacional, leiaute 1.00 (feita e testada em Goiânia).
 *
 * O sistema monta a <infDPS>; a ponte fiscal (ponte-fiscal/server.mjs) assina com o certificado
 * da 3M e fala com a prefeitura. Os dados fixos vêm da NFS-e nº 25 da 3M (23/10/2026), aceita
 * pela prefeitura: IM 6059023, serviço 14.01.01 / municipal 000, NBS 1.2001.31.10, Simples
 * Nacional ME/EPP com apuração pelo SN, sem o grupo IBS/CBS.
 *
 * O número da DPS é da prefeitura: antes de emitir a ponte consulta os números liberados
 * (ConsultarDpsDisponivel) e usa o menor.
 */

import { EMPRESA_PADRAO, carregarEmpresa } from './empresa.js';
// Prestador e códigos do serviço vêm de Fiscal → Empresa (empresa.js); o padrão são os dados da 3M.
const VER_APLIC = '3M-Gestao-1.0';

const soDigitos = (v) => String(v ?? '').replace(/\D/g, '');
const texto = (s, max) => String(s ?? '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim()
  .slice(0, max).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const dec2 = (n) => (Math.round((Number(n) || 0) * 100) / 100).toFixed(2);
const dataHoraGO = (t = Date.now()) => new Date(t - 3 * 3600000).toISOString().slice(0, 19) + '-03:00';
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

/** Id da DPS: "DPS" + município (7) + tipo de inscrição (2 = CNPJ) + CNPJ (14) + série (5) + número (15). */
export function idDPS(serie, numero, emp = EMPRESA_PADRAO) {
  return 'DPS' + emp.cMun + '2' + emp.cnpj + soDigitos(serie).padStart(5, '0') + soDigitos(numero).padStart(15, '0');
}

/**
 * Monta a <infDPS> (forma canônica: sem espaços entre tags).
 * d = { tpAmb, serie, numero, dCompet?, tomador?, descricao, valor, desconto?, issRetido, aliquota, pTotTribSN, infoCompl? }
 */
export function montarInfDPS(d) {
  const emp = d.emp || EMPRESA_PADRAO;
  const valor = Math.round((Number(d.valor) || 0) * 100) / 100;
  const desconto = Math.round((Number(d.desconto) || 0) * 100) / 100;
  if (!(valor > 0)) throw new Error('Informe o valor da mão de obra.');
  if (desconto < 0 || desconto >= valor) throw new Error('Desconto inválido.');
  const descricao = texto(d.descricao, 2000);
  if (!descricao) throw new Error('Descreva o serviço.');
  const t = d.tomador || {};
  const doc = soDigitos(t.doc);
  if (d.issRetido && doc.length !== 14) throw new Error('ISS retido só para cliente com CNPJ (é a empresa que retém).');
  if (doc && doc.length !== 11 && doc.length !== 14) throw new Error('CPF/CNPJ do cliente inválido.');
  if (doc && !texto(t.nome, 300)) throw new Error('Informe o nome do cliente.');

  let toma = '';
  if (doc) {
    const cep = soDigitos(t.cep), cMun = soDigitos(t.cMun);
    const temEnd = cep.length === 8 && cMun.length === 7 && texto(t.xLgr, 255) && texto(t.xBairro, 60);
    toma = '<toma>' + (doc.length === 14 ? `<CNPJ>${doc}</CNPJ>` : `<CPF>${doc}</CPF>`) + `<xNome>${texto(t.nome, 300)}</xNome>` +
      (temEnd ? `<end><endNac><cMun>${cMun}</cMun><CEP>${cep}</CEP></endNac><xLgr>${texto(t.xLgr, 255)}</xLgr><nro>${texto(t.nro, 60) || 'SN'}</nro>` +
        (texto(t.xCpl, 156) ? `<xCpl>${texto(t.xCpl, 156)}</xCpl>` : '') + `<xBairro>${texto(t.xBairro, 60)}</xBairro></end>` : '') +
      (soDigitos(t.fone).length >= 6 ? `<fone>${soDigitos(t.fone).slice(0, 20)}</fone>` : '') +
      (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(t.email || '').trim()) ? `<email>${texto(t.email, 80)}</email>` : '') +
      '</toma>';
  }

  const id = idDPS(d.serie, d.numero, emp);
  const dCompet = d.dCompet || dataHoraGO().slice(0, 10);
  const info = texto(d.infoCompl, 2000);
  const infDPS =
    `<infDPS Id="${id}">` +
    `<tpAmb>${Number(d.tpAmb) === 1 ? 1 : 2}</tpAmb><dhEmi>${dataHoraGO()}</dhEmi><verAplic>${VER_APLIC}</verAplic>` +
    `<serie>${soDigitos(d.serie)}</serie><nDPS>${Number(soDigitos(d.numero))}</nDPS><dCompet>${dCompet}</dCompet>` +
    `<tpEmit>1</tpEmit><cLocEmi>${emp.cMun}</cLocEmi>` +
    // Emitente = prestador: nome e endereço vêm do cadastro da prefeitura.
    `<prest><CNPJ>${emp.cnpj}</CNPJ><IM>${emp.im}</IM>` +
    `<regTrib><opSimpNac>${emp.opSimpNac}</opSimpNac>${emp.opSimpNac === '3' ? `<regApTribSN>${emp.regApTribSN}</regApTribSN>` : ''}<regEspTrib>${emp.regEspTrib || '0'}</regEspTrib></regTrib></prest>` +
    toma +
    `<serv><locPrest><cLocPrestacao>${emp.cMun}</cLocPrestacao></locPrest>` +
    `<cServ><cTribNac>${emp.cTribNac}</cTribNac><cTribMun>${emp.cTribMun || '0'}</cTribMun><xDescServ>${descricao}</xDescServ>${emp.cNBS ? `<cNBS>${emp.cNBS}</cNBS>` : ''}</cServ>` +
    (info ? `<infoCompl><xInfComp>${info}</xInfComp></infoCompl>` : '') + `</serv>` +
    `<valores><vServPrest><vServ>${dec2(valor)}</vServ></vServPrest>` +
    (desconto > 0 ? `<vDescCondIncond><vDescIncond>${dec2(desconto)}</vDescIncond></vDescCondIncond>` : '') +
    // Alíquota: a prefeitura define; o emitente do Simples só informa quando o ISS é retido.
    `<trib><tribMun><tribISSQN>1</tribISSQN><tpRetISSQN>${d.issRetido ? 2 : 1}</tpRetISSQN>` +
    (d.issRetido ? `<pAliq>${dec2(d.aliquota)}</pAliq>` : '') + `</tribMun>` +
    `<totTrib><pTotTribSN>${dec2(d.pTotTribSN)}</pTotTribSN></totTrib></trib></valores>` +
    `</infDPS>`;
  return { id, infDPS, valor, desconto, dCompet };
}

export async function garantirTabelaNfse(DB) {
  await DB.batch([
    DB.prepare(`CREATE TABLE IF NOT EXISTS nfse_saida (id TEXT PRIMARY KEY, ordem_id TEXT, tp_amb INTEGER, serie TEXT, n_dps TEXT,
      chave TEXT, numero TEXT, status TEXT, erros TEXT, valor REAL, desconto REAL, iss_retido INTEGER, tomador_doc TEXT, tomador_nome TEXT,
      descricao TEXT, dados TEXT, xml TEXT, dps TEXT, cancel_xml TEXT, cancel_just TEXT, quem TEXT, criado INTEGER, atualizado INTEGER)`),
    DB.prepare('CREATE INDEX IF NOT EXISTS idx_nfse_saida_os ON nfse_saida (ordem_id)'),
    DB.prepare('CREATE TABLE IF NOT EXISTS fiscal_config (chave TEXT PRIMARY KEY, valor TEXT)'),
  ]);
}

export async function configNfse(DB) {
  const r = await DB.prepare("SELECT chave, valor FROM fiscal_config WHERE chave LIKE 'nfse_%' AND chave <> 'nfse_wsdl'").all();
  const c = {}; (r.results || []).forEach((x) => { c[x.chave] = x.valor; });
  return {
    tpAmb: c.nfse_tp_amb === '1' ? 1 : 2,
    aliquota: Number(c.nfse_aliquota || 2.01),     // ISS do Simples (contador, 26/10/2026)
    pTotTribSN: Number(c.nfse_ptottrib || 6),       // "Alíquota do Simples Nacional: 6%" da NFS-e nº 25
  };
}

export async function salvarConfigNfse(DB, b) {
  const put = (k, v) => DB.prepare('INSERT INTO fiscal_config (chave,valor) VALUES (?,?) ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor').bind(k, String(v));
  const stmts = [];
  if (b.tpAmb === 1 || b.tpAmb === 2) stmts.push(put('nfse_tp_amb', b.tpAmb));
  if (Number(b.aliquota) > 0 && Number(b.aliquota) < 10) stmts.push(put('nfse_aliquota', Number(b.aliquota)));
  if (Number(b.pTotTribSN) > 0 && Number(b.pTotTribSN) < 40) stmts.push(put('nfse_ptottrib', Number(b.pTotTribSN)));
  if (stmts.length) await DB.batch(stmts);
  return configNfse(DB);
}

const guardarResposta = (DB, oque, r) => DB.prepare("INSERT INTO fiscal_config (chave,valor) VALUES ('nfse_ultima_resposta',?) ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor")
  .bind(JSON.stringify({ quando: Date.now(), oque, r })).run();
const textoErros = (erros) => (erros || []).map((e) => `${e.codigo || ''} ${e.mensagem || ''}${e.correcao ? ' (' + e.correcao + ')' : ''}`.trim()).join(' · ');

/** Emite (ou só confere, com b.validar) a NFS-e da mão de obra de uma OS. */
export async function emitirNfse(DB, ponte, b, quem) {
  const cfg = await configNfse(DB);
  const emp = await carregarEmpresa(DB);
  // Conferir (ValidarXml, não emite) pode usar a produção: o ambiente de teste da prefeitura não tem a 3M
  // cadastrada (E043/E259 em 30/10/2026).
  const tpAmb = b.validar && b.validarProducao ? 1 : cfg.tpAmb;
  const disp = await ponte({ acao: 'nfse_disponivel', tpAmb, im: emp.im, municipio: emp.municipioWs });
  const livre = (disp.dps || []).filter((x) => x.numero).sort((a, b2) => Number(a.numero) - Number(b2.numero))[0];
  if (!livre && !b.validar) {
    await guardarResposta(DB, 'disponivel', disp);
    throw new Error('A prefeitura não liberou número de DPS para a 3M' + (disp.erros && disp.erros.length ? ': ' + textoErros(disp.erros) : '.'));
  }
  const dps = montarInfDPS({ ...b, emp, tpAmb, serie: livre ? livre.serie : '1', numero: livre ? livre.numero : '1',
    issRetido: !!b.iss_retido, aliquota: cfg.aliquota, pTotTribSN: cfg.pTotTribSN });
  const r = await ponte({ acao: 'nfse_gerar', tpAmb, infDPS: dps.infDPS, validar: !!b.validar, municipio: emp.municipioWs });
  if (b.validar) {
    if (!r.ok) await guardarResposta(DB, 'validar', r);
    return { validacao: true, ok: r.ok, erros: r.erros || [], alertas: r.alertas || [], sucesso: r.sucesso || [], semNumero: !livre, tpAmb, resposta: r.resposta };
  }
  if (!r.ok) await guardarResposta(DB, 'gerar', r);
  // Links oficiais (QR Code do DANFSe). Se falhar, o DANFSe busca de novo quando for aberto.
  let links = null;
  if (r.ok && r.numero) { try { links = await ponte({ acao: 'nfse_links', tpAmb, im: emp.im, numero: r.numero, municipio: emp.municipioWs }); } catch (e) { links = null; } }
  const agora = Date.now(), id = uid(), t = b.tomador || {};
  const status = r.ok ? 'autorizada' : 'rejeitada';
  await DB.prepare(`INSERT INTO nfse_saida (id,ordem_id,tp_amb,serie,n_dps,chave,numero,status,erros,valor,desconto,iss_retido,tomador_doc,tomador_nome,descricao,dados,xml,dps,quem,criado,atualizado)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(id, String(b.ordem_id || ''), tpAmb, String(livre.serie), String(livre.numero), r.chave || null, r.numero || null, status,
      (r.erros || []).length ? JSON.stringify(r.erros) : null, dps.valor, dps.desconto, b.iss_retido ? 1 : 0,
      soDigitos(t.doc) || null, t.nome || null, String(b.descricao || '').slice(0, 2000),
      JSON.stringify({ tomador: t, os: b.os || null, alertas: r.alertas || [], links: linksValidos(links) }), r.xml || null, r.dps || null, String(quem || ''), agora, agora)
    .run();
  return { id, status, chave: r.chave, numero: r.numero, tpAmb, erros: r.erros || [], alertas: r.alertas || [], texto: textoErros(r.erros), resposta: r.resposta };
}

export async function cancelarNfse(DB, ponte, b) {
  const n = await DB.prepare('SELECT * FROM nfse_saida WHERE id=?').bind(String(b.id || '')).first();
  if (!n || n.status !== 'autorizada' || !n.chave) throw new Error('Só dá para cancelar nota de serviço autorizada.');
  const xMotivo = String(b.xMotivo || '').trim();
  if (xMotivo.length < 15) throw new Error('Escreva o motivo do cancelamento (mínimo de 15 letras).');
  const cMotivo = ['1', '2', '9'].includes(String(b.cMotivo)) ? String(b.cMotivo) : '9';
  const emp = await carregarEmpresa(DB);
  const r = await ponte({ acao: 'nfse_cancelar', tpAmb: n.tp_amb, chave: n.chave, cMotivo, xMotivo, municipio: emp.municipioWs });
  if (!r.cancelada) {
    await guardarResposta(DB, 'cancelar', r);
    throw new Error('Prefeitura: ' + (textoErros(r.erros) || 'cancelamento não confirmado.'));
  }
  await DB.prepare("UPDATE nfse_saida SET status='cancelada', cancel_xml=?, cancel_just=?, atualizado=? WHERE id=?")
    .bind(r.xml || null, xMotivo, Date.now(), n.id).run();
  return { ok: true };
}

// ---------- Links oficiais e DANFSe ----------

const linksValidos = (l) => (l && (l.autenticidade || l.visualizar || l.nacional)
  ? { autenticidade: l.autenticidade || null, visualizar: l.visualizar || null, nacional: l.nacional || null } : null);

/** Links da nota (QR Code): usa os guardados; se não houver, pergunta à prefeitura e guarda. */
export async function linksNfse(DB, ponte, n) {
  let dados = {}; try { dados = JSON.parse(n.dados || '{}'); } catch (e) { dados = {}; }
  if (dados.links || !n.numero || n.status === 'rejeitada') return dados.links || null;
  try {
    const emp = await carregarEmpresa(DB);
    const l = linksValidos(await ponte({ acao: 'nfse_links', tpAmb: n.tp_amb, im: emp.im, numero: n.numero, municipio: emp.municipioWs }));
    if (l) { dados.links = l; await DB.prepare('UPDATE nfse_saida SET dados=? WHERE id=?').bind(JSON.stringify(dados), n.id).run(); }
    return l;
  } catch (e) { return null; }
}

const TRIB_ISSQN = { 1: 'Operação tributável', 2: 'Imunidade', 3: 'Exportação de serviço', 4: 'Não incidência' };
const RET_ISSQN = { 1: 'Não retido', 2: 'Retido pelo tomador', 3: 'Retido pelo intermediário' };
const OP_SN = { 1: 'Não optante', 2: 'Optante — Microempreendedor Individual (MEI)', 3: 'Optante — Microempresa ou Empresa de Pequeno Porte (ME/EPP)' };
const AP_SN = { 1: 'Regime de apuração dos tributos federais e municipal pelo SN', 2: 'Tributos federais pelo SN e ISSQN por fora do SN', 3: 'Tributos federais e municipal por fora do SN' };

/** DANFSe (Documento Auxiliar da NFS-e) em HTML para imprimir ou salvar em PDF, a partir do XML autorizado. */
export function danfseHtml(n, links, emp = EMPRESA_PADRAO) {
  const x = n.xml || '';
  const t = (s, nome) => { const m = String(s || '').match(new RegExp(`<(?:\\w+:)?${nome}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${nome}>`)); return m ? m[1] : ''; };
  // O XML já vem escapado (&amp; &lt;): escapa o resto sem escapar de novo as entidades.
  const e = (s) => String(s ?? '').replace(/&(?!(amp|lt|gt|quot|apos|#\d+);)/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const brl = (v) => (v === '' || v == null) ? '—' : 'R$ ' + Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pct = (v) => (v === '' || v == null) ? '—' : Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2 }) + '%';
  const doc = (v) => { const d = soDigitos(v); return d.length === 14 ? d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5') : d.length === 11 ? d.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4') : (v || '—'); };
  const cep = (v) => { const d = soDigitos(v); return d.length === 8 ? d.replace(/^(\d{2})(\d{3})(\d{3})$/, '$1.$2-$3') : (v || ''); };
  const data = (v) => v ? v.slice(0, 10).split('-').reverse().join('/') : '—';
  const dataHora = (v) => v ? data(v) + ' ' + v.slice(11, 19) : '—';
  const cod = (v, fmt) => { const d = soDigitos(v); return fmt === 'trib' && d.length === 6 ? d.replace(/^(\d{2})(\d{2})(\d{2})$/, '$1.$2.$3') : fmt === 'nbs' && d.length === 9 ? d.replace(/^(\d)(\d{4})(\d{2})(\d{2})$/, '$1.$2.$3.$4') : (v || '—'); };

  const inf = t(x, 'infNFSe'), emit = t(inf, 'emit'), endE = t(emit, 'enderNac'), val = t(inf, 'valores');
  const dps = t(inf, 'infDPS'), toma = t(dps, 'toma'), endT = t(toma, 'end'), serv = t(dps, 'serv'), cServ = t(serv, 'cServ');
  const vDps = t(dps, 'valores'), tribMun = t(vDps, 'tribMun'), regTrib = t(t(dps, 'prest'), 'regTrib');
  const chave = n.chave || (x.match(/infNFSe[^>]*Id="NFS([0-9A-Z]{50})"/) || [])[1] || '';
  const homolog = Number(n.tp_amb) === 2 || t(dps, 'tpAmb') === '2';
  const cancel = n.status === 'cancelada';
  const vServ = t(t(vDps, 'vServPrest'), 'vServ'), vDesc = t(t(vDps, 'vDescCondIncond'), 'vDescIncond');
  const retido = t(tribMun, 'tpRetISSQN') === '2';
  const qr = (links && (links.autenticidade || links.nacional || links.visualizar)) || '';
  const campo = (rot, v, cls = '') => `<div class="c ${cls}"><div class="r">${rot}</div><div class="v">${v || '—'}</div></div>`;
  const marca = (homolog ? '<div class="marca">HOMOLOGAÇÃO — SEM VALOR FISCAL</div>' : '') + (cancel ? '<div class="marca">CANCELADA</div>' : '');
  const infoCompl = [t(inf, 'xOutInf') || 'DOCUMENTO EMITIDO POR ME OU EPP OPTANTE PELO SIMPLES NACIONAL. NÃO GERA DIREITO A CRÉDITO FISCAL DE IPI.',
    t(t(serv, 'infoCompl'), 'xInfComp')].filter(Boolean).map(e).join('<br>');
  const pTot = t(t(vDps, 'totTrib'), 'pTotTribSN');

  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>NFS-e ${e(n.numero || '')} · 3M</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
<style>
  *{box-sizing:border-box} body{font:11px/1.35 Arial,Helvetica,sans-serif;margin:0;background:#fff;color:#000}
  .pg{width:200mm;max-width:100%;margin:0 auto;padding:6mm 5mm;position:relative}
  .top{display:flex;gap:10px;align-items:stretch;border:1px solid #000;padding:6px}
  .top .t{flex:1} .top h1{font-size:15px;margin:0} .top .s{font-size:11px;color:#333}
  #qr{width:96px;height:96px;flex:none} .qrbox{display:flex;gap:8px;align-items:center;max-width:300px;font-size:9px;color:#333}
  .sec{border:1px solid #000;border-top:0;padding:4px 6px} .sec h2{font-size:10px;margin:0 0 3px;letter-spacing:.3px;background:#eee;padding:2px 4px}
  .g{display:grid;grid-template-columns:repeat(4,1fr);gap:3px 8px} .c .r{font-size:8.5px;color:#444;text-transform:uppercase} .c .v{font-size:11px;font-weight:bold;word-break:break-word}
  .s2{grid-column:span 2} .s4{grid-column:span 4}
  .chave{font:bold 12px monospace;letter-spacing:.5px}
  .desc{white-space:pre-wrap;font-size:11px}
  .tot{display:flex;justify-content:space-between;font-size:13px;font-weight:bold;border:1px solid #000;border-top:0;padding:6px}
  .marca{position:absolute;top:40%;left:0;right:0;text-align:center;font-size:34px;color:rgba(200,0,0,.18);transform:rotate(-20deg);pointer-events:none;font-weight:bold}
  .bar{max-width:200mm;margin:8px auto;text-align:right;padding:0 5mm} .bar button{font-size:14px;padding:8px 14px}
  @media print{.bar{display:none} .pg{padding:0}} @page{size:A4;margin:8mm}
</style></head><body>
<div class="bar"><button onclick="window.print()">Imprimir / salvar PDF</button></div>
<div class="pg">${marca}
  <div class="top">
    <div class="t"><h1>DANFSe — Documento Auxiliar da NFS-e</h1>
      <div class="s">Município: ${e(t(inf, 'xLocEmi') || emp.xMun)} - ${e(t(endE, 'UF') || emp.uf)} · ${homolog ? 'Homologação' : 'Produção'}${cancel ? ' · <b>NFS-e CANCELADA</b>' : ''}</div>
      <div style="font-size:8.5px;margin-top:6px;color:#444">CHAVE DE ACESSO DA NFS-e</div><div class="chave">${e(chave.replace(/(.{5})/g, '$1 ').trim())}</div></div>
    <div class="qrbox">${qr ? '<div id="qr"></div>' : ''}<div>A autenticidade desta NFS-e pode ser verificada ${qr ? 'pela leitura deste código QR ou ' : ''}pela consulta da chave de acesso no portal nacional da NFS-e.</div></div>
  </div>
  <div class="sec"><div class="g">
    ${campo('Número da NFS-e', e(t(inf, 'nNFSe') || n.numero))}${campo('Competência', data(t(dps, 'dCompet')))}${campo('Emissão da NFS-e', dataHora(t(inf, 'dhProc')))}${campo('Situação', cancel ? 'Cancelada' : 'NFS-e gerada')}
    ${campo('Número da DPS', e(t(dps, 'nDPS') || n.n_dps))}${campo('Série da DPS', e(t(dps, 'serie') || n.serie))}${campo('Emissão da DPS', dataHora(t(dps, 'dhEmi')))}${campo('Emitente', 'Prestador')}
  </div></div>
  <div class="sec"><h2>PRESTADOR / FORNECEDOR</h2><div class="g">
    ${campo('Nome / Nome empresarial', e(t(emit, 'xNome') || emp.razao), 's2')}${campo('CNPJ', doc(t(emit, 'CNPJ') || emp.cnpj))}${campo('Inscrição municipal', e(t(emit, 'IM') || emp.im))}
    ${campo('Endereço', e([t(endE, 'xLgr'), t(endE, 'nro'), t(endE, 'xCpl'), t(endE, 'xBairro')].filter(Boolean).join(', ')), 's2')}${campo('Município / UF', e((t(inf, 'xLocEmi') || emp.xMun) + ' / ' + (t(endE, 'UF') || emp.uf)))}${campo('CEP', cep(t(endE, 'CEP')))}
    ${campo('Telefone', e(t(emit, 'fone')))}${campo('E-mail', e(t(emit, 'email')))}${campo('Simples Nacional', e(OP_SN[t(regTrib, 'opSimpNac')] || ''), 's2')}
    ${campo('Regime de apuração tributária pelo SN', e(AP_SN[t(regTrib, 'regApTribSN')] || ''), 's4')}
  </div></div>
  <div class="sec"><h2>TOMADOR / ADQUIRENTE</h2><div class="g">
    ${toma ? `${campo('Nome / Nome empresarial', e(t(toma, 'xNome')), 's2')}${campo('CNPJ / CPF', doc(t(toma, 'CNPJ') || t(toma, 'CPF')))}${campo('Inscrição municipal', e(t(toma, 'IM')))}
    ${campo('Endereço', e([t(endT, 'xLgr'), t(endT, 'nro'), t(endT, 'xCpl'), t(endT, 'xBairro')].filter(Boolean).join(', ')), 's2')}${campo('CEP', cep(t(t(endT, 'endNac'), 'CEP')))}${campo('Telefone / e-mail', e([t(toma, 'fone'), t(toma, 'email')].filter(Boolean).join(' · ')))}`
      : campo('Tomador', 'Não identificado na NFS-e', 's4')}
  </div></div>
  <div class="sec"><h2>SERVIÇO PRESTADO</h2><div class="g">
    ${campo('Código de tributação nacional / municipal', cod(t(cServ, 'cTribNac'), 'trib') + ' / ' + e(t(cServ, 'cTribMun') || '—'), 's2')}${campo('Código da NBS', cod(t(cServ, 'cNBS'), 'nbs'))}${campo('Local da prestação', e(t(inf, 'xLocPrestacao') || emp.xMun))}
    ${campo('Descrição do código de tributação nacional', e(t(inf, 'xTribNac')), 's4')}
    <div class="c s4"><div class="r">Descrição do serviço</div><div class="v desc">${e(t(cServ, 'xDescServ'))}</div></div>
  </div></div>
  <div class="sec"><h2>TRIBUTAÇÃO MUNICIPAL (ISSQN)</h2><div class="g">
    ${campo('Tipo de tributação do ISSQN', e(TRIB_ISSQN[t(tribMun, 'tribISSQN')] || ''))}${campo('Município de incidência', e(t(inf, 'xLocIncid') || emp.xMun))}${campo('Retenção do ISSQN', e(RET_ISSQN[t(tribMun, 'tpRetISSQN')] || ''))}${campo('Regime especial', 'Nenhum')}
    ${campo('Base de cálculo do ISSQN', brl(t(val, 'vBC')))}${campo('Alíquota aplicada', pct(t(val, 'pAliqAplic')))}${campo('ISSQN apurado', brl(t(val, 'vISSQN')))}${campo('Total das retenções', brl(t(val, 'vTotalRet') || (retido ? t(val, 'vISSQN') : '')))}
  </div></div>
  <div class="sec"><h2>VALOR TOTAL DA NFS-e</h2><div class="g">
    ${campo('Valor do serviço', brl(vServ))}${campo('Desconto incondicionado', brl(vDesc))}${campo('ISSQN retido', retido ? brl(t(val, 'vISSQN')) : '—')}${campo('Valor líquido da NFS-e', brl(t(val, 'vLiq')))}
  </div></div>
  <div class="tot"><span>VALOR LÍQUIDO DA NFS-e</span><span>${brl(t(val, 'vLiq') || (Number(vServ || 0) - Number(vDesc || 0)))}</span></div>
  <div class="sec"><h2>INFORMAÇÕES COMPLEMENTARES</h2><div class="desc">${infoCompl || 'DOCUMENTO EMITIDO POR ME OU EPP OPTANTE PELO SIMPLES NACIONAL. NÃO GERA DIREITO A CRÉDITO FISCAL DE IPI.'}</div>
    ${pTot ? `<div style="margin-top:3px">Totais aproximados dos tributos cfe. Lei nº 12.741/2012: alíquota do Simples Nacional ${pct(pTot)}.</div>` : ''}</div>
</div>
${qr ? `<script>try{new QRCode(document.getElementById('qr'),{text:${JSON.stringify(qr).replace(/</g, '\\u003c')},width:96,height:96,correctLevel:QRCode.CorrectLevel.M});}catch(e){}</script>` : ''}
</body></html>`;
}
