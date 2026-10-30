/**
 * Dados da empresa emitente, editáveis em Fiscal → Empresa (só o administrador muda).
 *
 * Ficam em fiscal_config, chave 'empresa' (JSON). O que não foi preenchido usa EMPRESA_PADRAO,
 * que são os dados da 3M — assim a instalação atual continua igual. Outra oficina que use o
 * sistema troca tudo pela tela; o que NÃO fica aqui (por ser segredo ou infraestrutura):
 * certificado digital A1 e CSC (na ponte fiscal), e os endereços da SEFAZ do estado (a ponte
 * hoje fala com a SEFAZ-GO).
 */

export const EMPRESA_PADRAO = {
  razao: 'JCMA CENTRO AUTOMOTIVO LTDA', fantasia: '3M CENTRO AUTOMOTIVO',
  cnpj: '49958723000197', ie: '200201557', im: '6059023',
  crt: '1',                       // 1 Simples Nacional · 2 Simples (excesso de sublimite) · 3 Regime normal
  xLgr: 'AV MADRI', nro: '101', xCpl: 'QD 174 LT 22', xBairro: 'JARDIM EUROPA',
  cMun: '5208707', xMun: 'Goiania', uf: 'GO', cep: '74330550', fone: '6231000115', email: '',
  textoSimples: 'EMPRESA OPTANTE PELO SIMPLES NACIONAL, NÃO GERA DIREITO A CRÉDITO DO ICMS E IPI.',
  // Nota de serviço (NFS-e, padrão nacional)
  cTribNac: '140101', cTribMun: '000', cNBS: '120013110',
  opSimpNac: '3',                 // 1 não optante · 2 MEI · 3 ME/EPP
  regApTribSN: '1',               // 1 federais e municipal pelo SN · 2 ISS por fora · 3 tudo por fora
  regEspTrib: '0',                // 0 nenhum
  municipioWs: 'goiania',         // trecho do endereço do webservice ISS.net/NotaControl do município
};

// Código IBGE de cada UF (início da chave da NF-e).
export const COD_UF = { RO: '11', AC: '12', AM: '13', RR: '14', PA: '15', AP: '16', TO: '17', MA: '21', PI: '22', CE: '23', RN: '24', PB: '25',
  PE: '26', AL: '27', SE: '28', BA: '29', MG: '31', ES: '32', RJ: '33', SP: '35', PR: '41', SC: '42', RS: '43', MS: '50', MT: '51', GO: '52', DF: '53' };

const so = (v) => String(v ?? '').replace(/\D/g, '');
const txt = (v, max) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

export async function carregarEmpresa(DB) {
  let salvo = {};
  try { const r = await DB.prepare("SELECT valor FROM fiscal_config WHERE chave='empresa'").first(); salvo = r ? JSON.parse(r.valor) : {}; } catch (e) { salvo = {}; }
  const emp = { ...EMPRESA_PADRAO };
  for (const k of Object.keys(EMPRESA_PADRAO)) if (salvo[k] != null && salvo[k] !== '') emp[k] = String(salvo[k]);
  emp.codUF = COD_UF[emp.uf] || '';
  return emp;
}

/** Confere e grava. Devolve a configuração completa ou lança erro com o campo errado. */
export async function salvarEmpresa(DB, b) {
  const atual = await carregarEmpresa(DB);
  const n = { ...atual };
  const campos = {
    razao: (v) => txt(v, 60), fantasia: (v) => txt(v, 60), cnpj: so, ie: (v) => so(v) || txt(v, 14).toUpperCase(), im: so, crt: so,
    xLgr: (v) => txt(v, 60), nro: (v) => txt(v, 60), xCpl: (v) => txt(v, 60), xBairro: (v) => txt(v, 60),
    cMun: so, xMun: (v) => txt(v, 60), uf: (v) => txt(v, 2).toUpperCase(), cep: so, fone: so, email: (v) => txt(v, 60),
    textoSimples: (v) => txt(v, 500), cTribNac: so, cTribMun: so, cNBS: so, opSimpNac: so, regApTribSN: so, regEspTrib: so,
    municipioWs: (v) => txt(v, 40).toLowerCase(),
  };
  for (const [k, limpa] of Object.entries(campos)) if (b[k] !== undefined) n[k] = limpa(b[k]);
  const erro = (m) => { throw new Error(m); };
  if (n.cnpj.length !== 14) erro('CNPJ precisa ter 14 números.');
  if (!n.razao) erro('Informe a razão social.');
  if (!COD_UF[n.uf]) erro('UF inválida.');
  if (n.cMun.length !== 7) erro('Código IBGE do município precisa ter 7 números.');
  if (n.cep.length !== 8) erro('CEP precisa ter 8 números.');
  // A nota de peças é montada com CSOSN (Simples Nacional); regime normal (CRT 3) ainda não é suportado.
  if (!['1', '2'].includes(n.crt)) erro('Regime (CRT): a nota de peças hoje funciona só para Simples Nacional (1 ou 2).');
  if (n.cTribNac && n.cTribNac.length !== 6) erro('Código de tributação nacional precisa ter 6 números (ex.: 140101).');
  if (n.cNBS && n.cNBS.length !== 9) erro('Código NBS precisa ter 9 números (ex.: 120013110).');
  if (!['1', '2', '3'].includes(n.opSimpNac)) erro('Situação no Simples inválida.');
  if (n.municipioWs && !/^[a-z]{3,40}$/.test(n.municipioWs)) erro('Município do webservice: só letras minúsculas, sem acento (ex.: goiania).');
  const guardar = {}; for (const k of Object.keys(EMPRESA_PADRAO)) guardar[k] = n[k];
  await DB.prepare("INSERT INTO fiscal_config (chave,valor) VALUES ('empresa',?) ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor")
    .bind(JSON.stringify(guardar)).run();
  return carregarEmpresa(DB);
}

/** Emitente da NF-e no formato que o montarInfNFe usa. */
export const emitenteNFe = (e) => ({
  CNPJ: e.cnpj, xNome: e.razao, xFant: e.fantasia, IE: e.ie, CRT: e.crt, xLgr: e.xLgr, nro: e.nro, xCpl: e.xCpl, xBairro: e.xBairro,
  cMun: e.cMun, xMun: e.xMun, UF: e.uf, CEP: e.cep, fone: e.fone, cUF: e.codUF, textoSimples: e.textoSimples,
});
