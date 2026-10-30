/**
 * NFS-e de Goiânia (mão de obra das OS) — NotaControl / ISS.net, padrão nacional, leiaute 1.00.
 *
 * O sistema monta a <infDPS>; a ponte fiscal (ponte-fiscal/server.mjs) assina com o certificado
 * da 3M e fala com a prefeitura. Os dados fixos vêm da NFS-e nº 25 da 3M (23/10/2026), aceita
 * pela prefeitura: IM 6059023, serviço 14.01.01 / municipal 000, NBS 1.2001.31.10, Simples
 * Nacional ME/EPP com apuração pelo SN, sem o grupo IBS/CBS.
 *
 * O número da DPS é da prefeitura: antes de emitir a ponte consulta os números liberados
 * (ConsultarDpsDisponivel) e usa o menor.
 */

export const PRESTADOR = { CNPJ: '49958723000197', IM: '6059023', cMun: '5208707' };
const SERVICO = { cTribNac: '140101', cTribMun: '000', cNBS: '120013110' };
const VER_APLIC = '3M-Gestao-1.0';

const soDigitos = (v) => String(v ?? '').replace(/\D/g, '');
const texto = (s, max) => String(s ?? '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim()
  .slice(0, max).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const dec2 = (n) => (Math.round((Number(n) || 0) * 100) / 100).toFixed(2);
const dataHoraGO = (t = Date.now()) => new Date(t - 3 * 3600000).toISOString().slice(0, 19) + '-03:00';
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

/** Id da DPS: "DPS" + município (7) + tipo de inscrição (2 = CNPJ) + CNPJ (14) + série (5) + número (15). */
export function idDPS(serie, numero) {
  return 'DPS' + PRESTADOR.cMun + '2' + PRESTADOR.CNPJ + soDigitos(serie).padStart(5, '0') + soDigitos(numero).padStart(15, '0');
}

/**
 * Monta a <infDPS> (forma canônica: sem espaços entre tags).
 * d = { tpAmb, serie, numero, dCompet?, tomador?, descricao, valor, desconto?, issRetido, aliquota, pTotTribSN, infoCompl? }
 */
export function montarInfDPS(d) {
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

  const id = idDPS(d.serie, d.numero);
  const dCompet = d.dCompet || dataHoraGO().slice(0, 10);
  const info = texto(d.infoCompl, 2000);
  const infDPS =
    `<infDPS Id="${id}">` +
    `<tpAmb>${Number(d.tpAmb) === 1 ? 1 : 2}</tpAmb><dhEmi>${dataHoraGO()}</dhEmi><verAplic>${VER_APLIC}</verAplic>` +
    `<serie>${soDigitos(d.serie)}</serie><nDPS>${Number(soDigitos(d.numero))}</nDPS><dCompet>${dCompet}</dCompet>` +
    `<tpEmit>1</tpEmit><cLocEmi>${PRESTADOR.cMun}</cLocEmi>` +
    // Emitente = prestador: nome e endereço vêm do cadastro da prefeitura.
    `<prest><CNPJ>${PRESTADOR.CNPJ}</CNPJ><IM>${PRESTADOR.IM}</IM>` +
    `<regTrib><opSimpNac>3</opSimpNac><regApTribSN>1</regApTribSN><regEspTrib>0</regEspTrib></regTrib></prest>` +
    toma +
    `<serv><locPrest><cLocPrestacao>${PRESTADOR.cMun}</cLocPrestacao></locPrest>` +
    `<cServ><cTribNac>${SERVICO.cTribNac}</cTribNac><cTribMun>${SERVICO.cTribMun}</cTribMun><xDescServ>${descricao}</xDescServ><cNBS>${SERVICO.cNBS}</cNBS></cServ>` +
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
  const tpAmb = cfg.tpAmb;
  const disp = await ponte({ acao: 'nfse_disponivel', tpAmb, im: PRESTADOR.IM });
  const livre = (disp.dps || []).filter((x) => x.numero).sort((a, b2) => Number(a.numero) - Number(b2.numero))[0];
  if (!livre && !b.validar) {
    await guardarResposta(DB, 'disponivel', disp);
    throw new Error('A prefeitura não liberou número de DPS para a 3M' + (disp.erros && disp.erros.length ? ': ' + textoErros(disp.erros) : '.'));
  }
  const dps = montarInfDPS({ ...b, tpAmb, serie: livre ? livre.serie : '1', numero: livre ? livre.numero : '1',
    issRetido: !!b.iss_retido, aliquota: cfg.aliquota, pTotTribSN: cfg.pTotTribSN });
  const r = await ponte({ acao: 'nfse_gerar', tpAmb, infDPS: dps.infDPS, validar: !!b.validar });
  if (b.validar) {
    if (!r.ok) await guardarResposta(DB, 'validar', r);
    return { validacao: true, ok: r.ok, erros: r.erros || [], alertas: r.alertas || [], semNumero: !livre, resposta: r.resposta };
  }
  if (!r.ok) await guardarResposta(DB, 'gerar', r);
  const agora = Date.now(), id = uid(), t = b.tomador || {};
  const status = r.ok ? 'autorizada' : 'rejeitada';
  await DB.prepare(`INSERT INTO nfse_saida (id,ordem_id,tp_amb,serie,n_dps,chave,numero,status,erros,valor,desconto,iss_retido,tomador_doc,tomador_nome,descricao,dados,xml,dps,quem,criado,atualizado)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(id, String(b.ordem_id || ''), tpAmb, String(livre.serie), String(livre.numero), r.chave || null, r.numero || null, status,
      (r.erros || []).length ? JSON.stringify(r.erros) : null, dps.valor, dps.desconto, b.iss_retido ? 1 : 0,
      soDigitos(t.doc) || null, t.nome || null, String(b.descricao || '').slice(0, 2000),
      JSON.stringify({ tomador: t, os: b.os || null, alertas: r.alertas || [] }), r.xml || null, r.dps || null, String(quem || ''), agora, agora)
    .run();
  return { id, status, chave: r.chave, numero: r.numero, tpAmb, erros: r.erros || [], alertas: r.alertas || [], texto: textoErros(r.erros), resposta: r.resposta };
}

export async function cancelarNfse(DB, ponte, b) {
  const n = await DB.prepare('SELECT * FROM nfse_saida WHERE id=?').bind(String(b.id || '')).first();
  if (!n || n.status !== 'autorizada' || !n.chave) throw new Error('Só dá para cancelar nota de serviço autorizada.');
  const xMotivo = String(b.xMotivo || '').trim();
  if (xMotivo.length < 15) throw new Error('Escreva o motivo do cancelamento (mínimo de 15 letras).');
  const cMotivo = ['1', '2', '9'].includes(String(b.cMotivo)) ? String(b.cMotivo) : '9';
  const r = await ponte({ acao: 'nfse_cancelar', tpAmb: n.tp_amb, chave: n.chave, cMotivo, xMotivo });
  if (!r.cancelada) {
    await guardarResposta(DB, 'cancelar', r);
    throw new Error('Prefeitura: ' + (textoErros(r.erros) || 'cancelamento não confirmado.'));
  }
  await DB.prepare("UPDATE nfse_saida SET status='cancelada', cancel_xml=?, cancel_just=?, atualizado=? WHERE id=?")
    .bind(r.xml || null, xMotivo, Date.now(), n.id).run();
  return { ok: true };
}
