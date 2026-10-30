// Ponte fiscal da 3M (Node.js no Fly.io, região gru / São Paulo).
//
// Guarda o certificado A1 (e-CNPJ) da 3M e fala com o Ambiente Nacional da
// NF-e, que exige o certificado na conexão (mTLS). O sistema da oficina
// (Cloudflare) só chama esta ponte com ações fechadas — não é um proxy aberto:
//
//   { acao: "distNSU",   ultNSU }   próximas NF-e/eventos contra o CNPJ da 3M
//   { acao: "consChNFe", chave }    uma NF-e específica, pela chave de acesso
//   { acao: "ciencia",   chave }    evento 210210 (Ciência da Operação), assinado aqui
//   { diagnostico: true }           confere certificado e conexão (não grava nada)
//
// Emissão na SEFAZ-GO (NF-e modelo 55 e NFC-e modelo 65), sempre do CNPJ da 3M:
//   { acao: "nfe_status", tpAmb }                    status do serviço de autorização
//   { acao: "nfe_autorizar", infNFe }                assina o <infNFe> montado pelo sistema,
//                                                    põe o QR Code (NFC-e, com o CSC) e envia
//   { acao: "nfe_cancelar", chave, nProt, xJust, tpAmb }  evento 110111
//
// NFS-e de Goiânia (NotaControl/ISS.net, padrão nacional, leiaute 1.00 sem IBS/CBS):
//   { acao: "nfse_disponivel", tpAmb, im }           números de DPS liberados pela prefeitura
//   { acao: "nfse_gerar", tpAmb, infDPS, validar }   assina a <infDPS> montada pelo sistema e
//                                                    envia (GerarNfse) ou só confere (ValidarXml)
//   { acao: "nfse_cancelar", tpAmb, chave, cMotivo, xMotivo }  evento 101101
//
// Segredos (fly secrets):
//   PONTE_TOKEN        senha compartilhada com o sistema (cabeçalho x-ponte-token);
//   CERT_CADEIA_B64    certificado + cadeia em PEM, em base64 (conexão);
//   CERT_CHAVE_B64     chave privada PKCS#8 em PEM, em base64 (conexão e assinatura);
//   CSC_ID, CSC        Código de Segurança do Contribuinte da NFC-e (produção);
//   CSC_HOM_ID, CSC_HOM  o de homologação (se não houver, usa o de produção).
// Variáveis (fly.toml): CNPJ, UF (código IBGE), AMBIENTE (1 produção, 2 homologação) —
// AMBIENTE vale só para a Distribuição de DF-e; a emissão usa o tpAmb da própria nota.

import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { createSign, createHash, timingSafeEqual, X509Certificate } from "node:crypto";
import { pathToFileURL } from "node:url";

const LIMITE_CORPO = 256 * 1024;
const NS_NFE = "http://www.portalfiscal.inf.br/nfe";
const NS_DSIG = "http://www.w3.org/2000/09/xmldsig#";
const C14N = "http://www.w3.org/TR/2001/REC-xml-c14n-20010315";

const URLS = {
  1: {
    dist: "https://www1.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx",
    evento: "https://www.nfe.fazenda.gov.br/NFeRecepcaoEvento4/NFeRecepcaoEvento4.asmx",
  },
  2: {
    dist: "https://hom1.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx",
    evento: "https://hom1.nfe.fazenda.gov.br/NFeRecepcaoEvento4/NFeRecepcaoEvento4.asmx",
  },
};

function deBase64(nome) {
  const valor = process.env[nome] ?? "";
  return valor ? Buffer.from(valor, "base64").toString("utf8") : "";
}

const TOKEN = process.env.PONTE_TOKEN ?? "";
const CNPJ = (process.env.CNPJ ?? "").replace(/\D/g, "");
const UF = (process.env.UF ?? "52").replace(/\D/g, "");
const AMBIENTE = process.env.AMBIENTE === "2" ? 2 : 1;
const CADEIA = deBase64("CERT_CADEIA_B64");
const CHAVE = deBase64("CERT_CHAVE_B64");
const TEM_CERTIFICADO = CADEIA.includes("BEGIN CERTIFICATE") && CHAVE.includes("BEGIN PRIVATE KEY");

// O primeiro certificado da cadeia é o da 3M (vai no KeyInfo da assinatura).
const CERT_PEM = (CADEIA.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/) ?? [""])[0];
const CERT_CORPO = CERT_PEM.replace(/-----(BEGIN|END) CERTIFICATE-----|\s/g, "");

// O servidor de produção da SEFAZ-GO usa certificado ICP-Brasil (Raiz v10), que o Node
// não conhece: as autoridades públicas + a cadeia ICP-Brasil (icp-brasil.pem, pública).
let ICP_BRASIL = "";
try { ICP_BRASIL = readFileSync(new URL("./icp-brasil.pem", import.meta.url), "utf8"); } catch { /* sem o arquivo: só as públicas */ }
const agente = TEM_CERTIFICADO
  ? new https.Agent({ cert: CADEIA, key: CHAVE, ca: [...tls.rootCertificates, ICP_BRASIL].filter(Boolean), keepAlive: true, maxSockets: 4 })
  : null;

function autorizado(req) {
  const recebido = Buffer.from(String(req.headers["x-ponte-token"] ?? ""));
  const esperado = Buffer.from(TOKEN);
  return TOKEN.length > 0 && recebido.length === esperado.length && timingSafeEqual(recebido, esperado);
}

function responder(res, status, dados) {
  const corpo = JSON.stringify(dados);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(corpo) });
  res.end(corpo);
}

function lerCorpo(req) {
  return new Promise((resolve, reject) => {
    let tamanho = 0;
    const partes = [];
    req.on("data", (p) => {
      tamanho += p.length;
      if (tamanho > LIMITE_CORPO) {
        reject(new Error("pedido grande demais"));
        req.destroy();
        return;
      }
      partes.push(p);
    });
    req.on("end", () => resolve(Buffer.concat(partes).toString("utf8")));
    req.on("error", reject);
  });
}

/** Faz a chamada SOAP 1.2 com o certificado da 3M e devolve status e corpo. */
function chamarSoap(url, envelope, comCertificado = true, cabecalhos = { "content-type": "application/soap+xml; charset=utf-8" }) {
  return new Promise((resolve, reject) => {
    const opcoes = {
      method: "POST",
      headers: { ...cabecalhos, "content-length": Buffer.byteLength(envelope) },
      timeout: 60_000,
    };
    if (comCertificado) {
      if (!agente) return reject(new Error("Certificado da 3M ausente na ponte (fly secrets)."));
      opcoes.agent = agente;
    }
    const req = https.request(url, opcoes, (res) => {
      const partes = [];
      res.on("data", (p) => partes.push(p));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, corpo: Buffer.concat(partes).toString("utf8") }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("a SEFAZ não respondeu em 60 segundos")));
    req.on("error", reject);
    req.write(envelope);
    req.end();
  });
}

/** GET com o certificado da 3M (só leitura): usado para conferir o WSDL da NFS-e de Goiânia. */
function obterComCertificado(url) {
  return new Promise((resolve) => {
    if (!agente) return resolve({ status: 0, corpo: "" });
    const req = https.request(url, { method: "GET", agent: agente, timeout: 20_000 }, (res) => {
      const partes = [];
      res.on("data", (p) => partes.push(p));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, corpo: Buffer.concat(partes).toString("utf8") }));
    });
    req.on("timeout", () => req.destroy(new Error("sem resposta em 20 s")));
    req.on("error", (e) => resolve({ status: 0, corpo: "", erro: e.message }));
    req.end();
  });
}

// Webservice da NFS-e (padrão nacional) da NotaControl/ISS.net: endereços a confirmar.
const NFSE_WSDL = {
  homologacao: "https://nfse.issnetonline.com.br/wsnfsenacional/homologacao/nfse.asmx?wsdl",
  goiania: "https://nfse.issnetonline.com.br/wsnfsenacional/goiania/nfse.asmx?wsdl",
};

function envelope(wsdl, conteudo) {
  return (
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<soap12:Envelope xmlns:soap12="http://www.w3.org/2003/05/soap-envelope"><soap12:Body>` +
    conteudo.replace("{{WSDL}}", wsdl) +
    `</soap12:Body></soap12:Envelope>`
  );
}

function tag(xml, nome) {
  const m = xml.match(new RegExp(`<(?:\\w+:)?${nome}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${nome}>`));
  return m ? m[1] : null;
}

function erroSoap(r) {
  const motivo = tag(r.corpo, "Text") ?? tag(r.corpo, "faultstring") ?? r.corpo.slice(0, 300);
  return new Error(`SEFAZ respondeu ${r.status}: ${motivo.replace(/\s+/g, " ").trim()}`);
}

// ---------- Distribuição de DF-e ----------

async function distribuicao(consulta) {
  const wsdl = "http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe";
  const xml =
    `<nfeDistDFeInteresse xmlns="{{WSDL}}"><nfeDadosMsg>` +
    `<distDFeInt xmlns="${NS_NFE}" versao="1.01"><tpAmb>${AMBIENTE}</tpAmb><cUFAutor>${UF}</cUFAutor>` +
    `<CNPJ>${CNPJ}</CNPJ>${consulta}</distDFeInt>` +
    `</nfeDadosMsg></nfeDistDFeInteresse>`;
  const r = await chamarSoap(URLS[AMBIENTE].dist, envelope(wsdl, xml));
  if (r.status !== 200) throw erroSoap(r);
  const ret = tag(r.corpo, "retDistDFeInt");
  if (!ret) throw erroSoap(r);
  const docs = [];
  for (const m of ret.matchAll(/<docZip\s+NSU="(\d+)"\s+schema="([^"]+)"\s*>([^<]+)<\/docZip>/g)) {
    const xml = gunzipSync(Buffer.from(m[3], "base64")).toString("utf8");
    docs.push({ nsu: m[1], schema: m[2], ...lerDocumento(m[2], xml), xml });
  }
  return {
    cStat: tag(ret, "cStat"),
    xMotivo: tag(ret, "xMotivo"),
    ultNSU: tag(ret, "ultNSU"),
    maxNSU: tag(ret, "maxNSU"),
    docs,
  };
}

// ---------- Leitura dos documentos (resumo, NF-e completa, eventos) ----------

const desfazer = (s) =>
  s == null
    ? null
    : s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&").trim();
const campo = (xml, nome) => desfazer(tag(xml, nome));
const numero = (xml, nome) => {
  const v = tag(xml, nome);
  return v == null ? null : Number(v);
};

function lerDocumento(schema, xml) {
  if (schema.startsWith("resNFe")) {
    return {
      tipo: "resumo",
      dados: {
        chave: campo(xml, "chNFe"),
        cnpjEmit: campo(xml, "CNPJ") ?? campo(xml, "CPF"),
        nomeEmit: campo(xml, "xNome"),
        dhEmi: campo(xml, "dhEmi"),
        tpNF: campo(xml, "tpNF"),
        valor: numero(xml, "vNF"),
        situacao: campo(xml, "cSitNFe"), // 1 autorizada, 2 denegada, 3 cancelada
      },
    };
  }
  if (schema.startsWith("procNFe")) {
    const inf = tag(xml, "infNFe") ?? "";
    const ide = tag(inf, "ide") ?? "";
    const emit = tag(inf, "emit") ?? "";
    const itens = [];
    for (const d of inf.matchAll(/<det\s+nItem="(\d+)"\s*>([\s\S]*?)<\/det>/g)) {
      const prod = tag(d[2], "prod") ?? "";
      const icms = tag(d[2], "ICMS") ?? "";
      itens.push({
        nItem: Number(d[1]),
        codigo: campo(prod, "cProd"),
        ean: campo(prod, "cEAN"),
        descricao: campo(prod, "xProd"),
        ncm: campo(prod, "NCM"),
        cest: campo(prod, "CEST"),
        cfop: campo(prod, "CFOP"),
        unidade: campo(prod, "uCom"),
        qtde: numero(prod, "qCom"),
        valorUnit: numero(prod, "vUnCom"),
        valorTotal: numero(prod, "vProd"),
        origem: campo(icms, "orig"),
      });
    }
    const chave = (xml.match(/<infNFe[^>]*\sId="NFe(\d{44})"/) ?? [])[1] ?? campo(xml, "chNFe");
    return {
      tipo: "completa",
      dados: {
        chave,
        numero: campo(ide, "nNF"),
        serie: campo(ide, "serie"),
        dhEmi: campo(ide, "dhEmi"),
        tpNF: campo(ide, "tpNF"),
        cnpjEmit: campo(emit, "CNPJ") ?? campo(emit, "CPF"),
        nomeEmit: campo(emit, "xNome"),
        fantasiaEmit: campo(emit, "xFant"),
        valor: numero(tag(inf, "ICMSTot") ?? "", "vNF"),
        itens,
      },
    };
  }
  if (schema.startsWith("resEvento") || schema.startsWith("procEventoNFe")) {
    return {
      tipo: "evento",
      dados: {
        chave: campo(xml, "chNFe"),
        tpEvento: campo(xml, "tpEvento"),
        descricao: campo(xml, "xEvento") ?? campo(xml, "descEvento"),
        dhEvento: campo(xml, "dhEvento"),
      },
    };
  }
  return { tipo: "outro", dados: {} };
}

// ---------- Evento de manifestação (Ciência da Operação) ----------

function dataHoraBrasilia() {
  const d = new Date(Date.now() - 3 * 3600_000);
  return d.toISOString().slice(0, 19) + "-03:00";
}

/**
 * Assinatura XMLDSig (RSA-SHA1, exigida pelo leiaute do evento). O XML é
 * escrito já na forma canônica (C14N): sem espaços entre tags, atributos na
 * ordem certa e elementos vazios abertos e fechados — por isso não há
 * biblioteca de canonicalização.
 */
function assinar(elemento, id, ns = NS_NFE) {
  // Na forma canônica o elemento (infEvento, infNFe, infDPS) herda o xmlns do pai (<evento>, <NFe>, <DPS>).
  const canonico = elemento.replace(/^<(\w+) /, `<$1 xmlns="${ns}" `);
  const digest = createHash("sha1").update(canonico, "utf8").digest("base64");
  const signedInfo =
    `<SignedInfo>` +
    `<CanonicalizationMethod Algorithm="${C14N}"></CanonicalizationMethod>` +
    `<SignatureMethod Algorithm="${NS_DSIG}rsa-sha1"></SignatureMethod>` +
    `<Reference URI="#${id}"><Transforms>` +
    `<Transform Algorithm="${NS_DSIG}enveloped-signature"></Transform>` +
    `<Transform Algorithm="${C14N}"></Transform>` +
    `</Transforms><DigestMethod Algorithm="${NS_DSIG}sha1"></DigestMethod>` +
    `<DigestValue>${digest}</DigestValue></Reference>` +
    `</SignedInfo>`;
  const assinatura = createSign("RSA-SHA1")
    .update(signedInfo.replace("<SignedInfo>", `<SignedInfo xmlns="${NS_DSIG}">`), "utf8")
    .sign(CHAVE, "base64");
  return (
    `<Signature xmlns="${NS_DSIG}">${signedInfo}<SignatureValue>${assinatura}</SignatureValue>` +
    `<KeyInfo><X509Data><X509Certificate>${CERT_CORPO}</X509Certificate></X509Data></KeyInfo></Signature>`
  );
}

function eventoCiencia(chave) {
  const id = `ID210210${chave}01`;
  const infEvento =
    `<infEvento Id="${id}"><cOrgao>91</cOrgao><tpAmb>${AMBIENTE}</tpAmb><CNPJ>${CNPJ}</CNPJ>` +
    `<chNFe>${chave}</chNFe><dhEvento>${dataHoraBrasilia()}</dhEvento><tpEvento>210210</tpEvento>` +
    `<nSeqEvento>1</nSeqEvento><verEvento>1.00</verEvento>` +
    `<detEvento versao="1.00"><descEvento>Ciencia da Operacao</descEvento></detEvento></infEvento>`;
  return `<evento xmlns="${NS_NFE}" versao="1.00">${infEvento}${assinar(infEvento, id)}</evento>`;
}

async function ciencia(chave) {
  const evento = eventoCiencia(chave);
  const wsdl = "http://www.portalfiscal.inf.br/nfe/wsdl/NFeRecepcaoEvento4";
  const xml =
    `<nfeDadosMsg xmlns="{{WSDL}}"><envEvento xmlns="${NS_NFE}" versao="1.00">` +
    `<idLote>${Date.now()}</idLote>${evento}</envEvento></nfeDadosMsg>`;
  const r = await chamarSoap(URLS[AMBIENTE].evento, envelope(wsdl, xml));
  if (r.status !== 200) throw erroSoap(r);
  const ret = tag(r.corpo, "retEvento") ?? tag(r.corpo, "retEnvEvento");
  if (!ret) throw erroSoap(r);
  // cStat do lote fica fora do retEvento; o que importa é o do evento.
  return { cStat: tag(ret, "cStat"), xMotivo: tag(ret, "xMotivo"), nProt: tag(ret, "nProt") };
}

// ---------- Emissão na SEFAZ-GO (NF-e 55 e NFC-e 65) ----------

const SEFAZ_GO = { 1: "https://nfe.sefaz.go.gov.br/nfe/services/", 2: "https://homolog.sefaz.go.gov.br/nfe/services/" };
// QR Code da NFC-e: endereços do Informe Técnico SEFAZ-GO 2025.003 (HTTPS desde 16/06/2025).
const QR_GO = { 1: "https://nfeweb.sefaz.go.gov.br/nfeweb/sites/nfce/danfeNFCe", 2: "https://nfewebhomolog.sefaz.go.gov.br/nfeweb/sites/nfce/danfeNFCe" };
const URL_CHAVE_GO = { 1: "www.sefaz.go.gov.br/nfce/consulta", 2: "www.sefaz.go.gov.br/nfce/consulta" };

// trim: espaço ou quebra de linha colados junto com o código mudam o hash (rejeição 464).
function csc(tpAmb) {
  const prod = { id: (process.env.CSC_ID ?? "").trim(), csc: (process.env.CSC ?? "").trim() };
  const hom = { id: (process.env.CSC_HOM_ID ?? "").trim(), csc: (process.env.CSC_HOM ?? "").trim() };
  return tpAmb === 2 && hom.id && hom.csc ? hom : prod;
}

/** QR Code da NFC-e, versão 2, emissão on-line (NT 2015.002): p=chave|2|tpAmb|idCSC|hash. */
function infNFeSupl(chave, tpAmb) {
  const c = csc(tpAmb);
  if (!c.id || !c.csc) throw new Error("CSC da NFC-e não configurado na ponte (CSC_ID / CSC).");
  const id = String(Number(c.id)); // sem zeros à esquerda
  const base = `${chave}|2|${tpAmb}|${id}`;
  const hash = createHash("sha1").update(base + c.csc, "utf8").digest("hex").toUpperCase();
  const qr = `${QR_GO[tpAmb]}?p=${base}|${hash}`;
  return { xml: `<infNFeSupl><qrCode>${qr}</qrCode><urlChave>${URL_CHAVE_GO[tpAmb]}</urlChave></infNFeSupl>`, qrCode: qr, urlChave: URL_CHAVE_GO[tpAmb] };
}

async function soapGo(tpAmb, servico, conteudo) {
  const wsdl = `http://www.portalfiscal.inf.br/nfe/wsdl/${servico}`;
  const r = await chamarSoap(SEFAZ_GO[tpAmb] + servico, envelope(wsdl, `<nfeDadosMsg xmlns="{{WSDL}}">${conteudo}</nfeDadosMsg>`));
  if (r.status !== 200) throw erroSoap(r);
  return r.corpo;
}

async function statusGo(tpAmb) {
  const corpo = await soapGo(tpAmb, "NFeStatusServico4",
    `<consStatServ xmlns="${NS_NFE}" versao="4.00"><tpAmb>${tpAmb}</tpAmb><cUF>${UF}</cUF><xServ>STATUS</xServ></consStatServ>`);
  return { cStat: tag(corpo, "cStat"), xMotivo: tag(corpo, "xMotivo"), tMed: tag(corpo, "tMed") };
}

/**
 * Recebe o <infNFe> já montado pelo sistema (forma canônica), confere que é da 3M, assina,
 * põe o QR Code (NFC-e) e envia em modo síncrono. Devolve o protocolo e o nfeProc.
 */
async function autorizarGo(infNFe) {
  const m = infNFe.match(/^<infNFe Id="NFe(\d{44})" versao="4\.00">/);
  if (!m) throw new Error("infNFe inválido.");
  const chave = m[1];
  const emit = tag(infNFe, "emit") ?? "";
  if ((tag(emit, "CNPJ") ?? "") !== CNPJ) throw new Error("A nota não é do CNPJ da 3M.");
  const mod = tag(infNFe, "mod"), tpAmb = Number(tag(infNFe, "tpAmb"));
  if (!["55", "65"].includes(mod) || ![1, 2].includes(tpAmb)) throw new Error("Modelo ou ambiente inválido.");
  if (chave.slice(0, 2) !== UF || chave.slice(6, 20) !== CNPJ) throw new Error("Chave de acesso não confere com a 3M.");

  const supl = mod === "65" ? infNFeSupl(chave, tpAmb) : null;
  const nfe = `<NFe xmlns="${NS_NFE}">${infNFe}${supl ? supl.xml : ""}${assinar(infNFe, "NFe" + chave)}</NFe>`;
  const corpo = await soapGo(tpAmb, "NFeAutorizacao4",
    `<enviNFe xmlns="${NS_NFE}" versao="4.00"><idLote>${Date.now()}</idLote><indSinc>1</indSinc>${nfe}</enviNFe>`);
  const ret = tag(corpo, "retEnviNFe") ?? corpo;
  let lote = { cStat: tag(ret, "cStat"), xMotivo: tag(ret, "xMotivo") };
  let protXml = (corpo.match(/<protNFe[\s\S]*?<\/protNFe>/) ?? [])[0] ?? null;

  // Lote assíncrono (103): consulta o recibo algumas vezes.
  if (!protXml && lote.cStat === "103") {
    const nRec = tag(ret, "nRec");
    for (let i = 0; i < 6 && !protXml; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const c = await soapGo(tpAmb, "NFeRetAutorizacao4",
        `<consReciNFe xmlns="${NS_NFE}" versao="4.00"><tpAmb>${tpAmb}</tpAmb><nRec>${nRec}</nRec></consReciNFe>`);
      protXml = (c.match(/<protNFe[\s\S]*?<\/protNFe>/) ?? [])[0] ?? null;
      if (!protXml) lote = { cStat: tag(c, "cStat"), xMotivo: tag(c, "xMotivo") };
    }
  }
  if (!protXml) return { chave, cStat: lote.cStat, xMotivo: lote.xMotivo, autorizada: false };

  const inf = tag(protXml, "infProt") ?? "";
  const cStat = tag(inf, "cStat");
  const autorizada = cStat === "100" || cStat === "150";
  // nfeProc: o arquivo que vale como nota (XML assinado + protocolo da SEFAZ).
  const prot = protXml.includes("xmlns=") ? protXml : protXml.replace("<protNFe ", `<protNFe xmlns="${NS_NFE}" `);
  return {
    chave, cStat, xMotivo: tag(inf, "xMotivo"), nProt: tag(inf, "nProt"), dhRecbto: tag(inf, "dhRecbto"), autorizada,
    qrCode: supl ? supl.qrCode : null, urlChave: supl ? supl.urlChave : null,
    xml: autorizada ? `<?xml version="1.0" encoding="UTF-8"?><nfeProc xmlns="${NS_NFE}" versao="4.00">${nfe}${prot}</nfeProc>` : null,
  };
}

/** Cancelamento (evento 110111) na SEFAZ-GO. */
async function cancelarGo(chave, nProt, xJust, tpAmb) {
  const id = `ID110111${chave}01`;
  const just = String(xJust).normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[<>&"']/g, " ").trim();
  const infEvento =
    `<infEvento Id="${id}"><cOrgao>${UF}</cOrgao><tpAmb>${tpAmb}</tpAmb><CNPJ>${CNPJ}</CNPJ>` +
    `<chNFe>${chave}</chNFe><dhEvento>${dataHoraBrasilia()}</dhEvento><tpEvento>110111</tpEvento>` +
    `<nSeqEvento>1</nSeqEvento><verEvento>1.00</verEvento>` +
    `<detEvento versao="1.00"><descEvento>Cancelamento</descEvento><nProt>${nProt}</nProt><xJust>${just}</xJust></detEvento></infEvento>`;
  const evento = `<evento xmlns="${NS_NFE}" versao="1.00">${infEvento}${assinar(infEvento, id)}</evento>`;
  const corpo = await soapGo(tpAmb, "NFeRecepcaoEvento4",
    `<envEvento xmlns="${NS_NFE}" versao="1.00"><idLote>${Date.now()}</idLote>${evento}</envEvento>`);
  const ret = tag(corpo, "retEvento") ?? tag(corpo, "retEnvEvento") ?? corpo;
  const cStat = tag(ret, "cStat");
  const ok = ["135", "155"].includes(cStat);
  const retXml = (corpo.match(/<retEvento[\s\S]*?<\/retEvento>/) ?? [])[0] ?? "";
  return { cStat, xMotivo: tag(ret, "xMotivo"), nProt: tag(ret, "nProt"), cancelada: ok,
    xml: ok ? `<?xml version="1.0" encoding="UTF-8"?><procEventoNFe xmlns="${NS_NFE}" versao="1.00">${evento}${retXml}</procEventoNFe>` : null };
}

// ---------- NFS-e de Goiânia (NotaControl / ISS.net) ----------

const NS_NFSE = "http://www.sped.fazenda.gov.br/nfse";
// Endereços conferidos com o certificado da 3M em 30/10/2026 (WSDL com todas as operações).
const NFSE_URL = {
  1: "https://nfse.issnetonline.com.br/wsnfsenacional/goiania/nfse.asmx",
  2: "https://nfse.issnetonline.com.br/wsnfsenacional/homologacao/nfse.asmx",
};
const VERSAO_NFSE = "1.00"; // 1.00 = sem o grupo IBS/CBS, como a NFS-e nº 25 da 3M (23/10/2026)
const VER_APLIC = "3M-Gestao-1.0";
const escXml = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const desescXml = (t) => String(t).replace(/^\s*<!\[CDATA\[([\s\S]*)\]\]>\s*$/, "$1")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&amp;/g, "&");

/** Chama uma operação do webservice: cabeçalho e dados vão como texto (nfseCabecMsg / nfseDadosMsg). */
async function soapNfse(tpAmb, operacao, dados) {
  const cabec = `<cabecalho xmlns="${NS_NFSE}" versao="${VERSAO_NFSE}"><versaoDados>${VERSAO_NFSE}</versaoDados></cabecalho>`;
  const env =
    `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>` +
    // No WSDL, nfseCabecMsg/nfseDadosMsg são elementos locais sem namespace (elementFormDefault padrão =
    // unqualified): com o xmlns padrão no pai eles herdavam o namespace e a prefeitura não os achava (E160/E232).
    `<ws:${operacao} xmlns:ws="${NS_NFSE}"><nfseCabecMsg>${escXml(cabec)}</nfseCabecMsg><nfseDadosMsg>${escXml(dados)}</nfseDadosMsg></ws:${operacao}>` +
    `</soap:Body></soap:Envelope>`;
  const r = await chamarSoap(NFSE_URL[tpAmb], env, true, { "content-type": "text/xml; charset=utf-8", SOAPAction: `"${NS_NFSE}/${operacao}"` });
  // O WSDL fala em <outputXML> (texto), mas Goiânia devolve o XML direto dentro de <{operação}Response>.
  let saida = tag(r.corpo, "outputXML");
  if (saida == null) saida = tag(r.corpo, `${operacao}Response`);
  else saida = desescXml(saida);
  if (r.status !== 200 || saida == null) {
    const motivo = tag(r.corpo, "faultstring") ?? tag(r.corpo, "Text") ?? r.corpo.slice(0, 1500);
    throw new Error(`prefeitura respondeu ${r.status}: ${String(motivo).replace(/\s+/g, " ").trim()}`);
  }
  // Se ainda vier como texto escapado (&lt;...), desfaz o escape.
  const xml = /^\s*&lt;/.test(saida) ? desescXml(saida) : saida;
  console.log(`[nfse ${operacao}] ${xml.replace(/\s+/g, " ").slice(0, 1500)}`); // enquanto a integração é nova
  return xml;
}

/** Mensagens de retorno (erros e alertas) da prefeitura. */
function mensagensNfse(xml, grupo) {
  const bloco = tag(xml, grupo);
  if (!bloco) return [];
  return [...bloco.matchAll(/<(?:\w+:)?MensagemRetorno>([\s\S]*?)<\/(?:\w+:)?MensagemRetorno>/g)].map((m) => ({
    codigo: tag(m[1], "Codigo"), mensagem: tag(m[1], "Mensagem"), correcao: tag(m[1], "Correcao") ?? undefined,
  }));
}

async function nfseDisponivel(tpAmb, im) {
  const dados = `<ConsultarDpsDisponivelEnvio xmlns="${NS_NFSE}"><Prestador><CNPJ>${CNPJ}</CNPJ><IM>${im}</IM></Prestador><Pagina>1</Pagina></ConsultarDpsDisponivelEnvio>`;
  const xml = await soapNfse(tpAmb, "ConsultarDpsDisponivel", dados);
  const dps = [...xml.matchAll(/<(?:\w+:)?DpsDisponivel>([\s\S]*?)<\/(?:\w+:)?DpsDisponivel>/g)]
    .map((m) => ({ numero: tag(m[1], "NumDPS"), serie: tag(m[1], "SerieDPS") }));
  return { dps, erros: mensagensNfse(xml, "ListaMensagemRetorno"), resposta: dps.length ? undefined : xml.slice(0, 2000) };
}

/** Assina a <infDPS> montada pelo sistema e envia (ou só valida). */
async function nfseGerar(tpAmb, infDPS, validar) {
  const id = (infDPS.match(/^<infDPS Id="(DPS[0-9A-Z]{42})">/) ?? [])[1];
  if (!id) throw new Error("infDPS sem Id válido");
  const dps = `<DPS versao="${VERSAO_NFSE}">${infDPS}${assinar(infDPS, id, NS_NFSE)}</DPS>`;
  const envio = `<GerarNfseEnvio xmlns="${NS_NFSE}">${dps}</GerarNfseEnvio>`;
  const xml = await soapNfse(tpAmb, validar ? "ValidarXml" : "GerarNfse", envio);
  const erros = mensagensNfse(xml, "ListaMensagemRetorno");
  const alertas = mensagensNfse(xml, "ListaMensagemAlertaRetorno");
  const nfse = (xml.match(/<(?:\w+:)?NFSe[\s>][\s\S]*<\/(?:\w+:)?NFSe>/) ?? [])[0] ?? null;
  const chave = nfse ? ((nfse.match(/<(?:\w+:)?infNFSe[^>]*\sId="NFS([0-9A-Z]{50})"/) ?? [])[1] ?? null) : null;
  return {
    ok: validar ? erros.length === 0 : !!chave,
    validacao: !!validar, chave, numero: nfse ? tag(nfse, "nNFSe") : null, cStat: nfse ? tag(nfse, "cStat") : null,
    dhProc: nfse ? tag(nfse, "dhProc") : null, erros, alertas,
    xml: nfse ? `<?xml version="1.0" encoding="UTF-8"?>${nfse}` : null, dps,
    resposta: !nfse && !erros.length ? xml.slice(0, 2000) : undefined,
  };
}

function pedidoCancelamentoNfse(tpAmb, chave, cMotivo, xMotivo) {
  const id = `PRE${chave}101101`;
  const inf =
    `<infPedReg Id="${id}"><tpAmb>${tpAmb}</tpAmb><verAplic>${VER_APLIC}</verAplic><dhEvento>${dataHoraBrasilia()}</dhEvento>` +
    `<CNPJAutor>${CNPJ}</CNPJAutor><chNFSe>${chave}</chNFSe>` +
    `<e101101><xDesc>Cancelamento de NFS-e</xDesc><cMotivo>${cMotivo}</cMotivo><xMotivo>${escXml(xMotivo)}</xMotivo></e101101></infPedReg>`;
  return `<CancelarNfseEnvio xmlns="${NS_NFSE}"><pedRegEvento versao="${VERSAO_NFSE}">${inf}${assinar(inf, id, NS_NFSE)}</pedRegEvento></CancelarNfseEnvio>`;
}

async function nfseCancelar(tpAmb, chave, cMotivo, xMotivo) {
  const xml = await soapNfse(tpAmb, "CancelarNfse", pedidoCancelamentoNfse(tpAmb, chave, cMotivo, xMotivo));
  const erros = mensagensNfse(xml, "ListaMensagemRetorno");
  const evento = tag(xml, "ListaEvento");
  return { cancelada: !!evento && !erros.length, erros, xml: evento ? `<?xml version="1.0" encoding="UTF-8"?>${xml}` : null,
    resposta: !evento && !erros.length ? xml.slice(0, 2000) : undefined };
}

// ---------- Servidor ----------

const CHAVE_NFE = /^\d{44}$/;

const servidor = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/saude") return responder(res, 200, { ok: true });
    if (!autorizado(req)) return responder(res, 401, { erro: "não autorizado" });
    if (req.method !== "POST") return responder(res, 405, { erro: "use POST" });
    if (CNPJ.length !== 14) return responder(res, 500, { erro: "CNPJ não configurado na ponte" });

    let pedido;
    try {
      pedido = JSON.parse(await lerCorpo(req));
    } catch {
      return responder(res, 400, { erro: "JSON inválido" });
    }

    try {
      if (pedido.diagnostico) {
        const saida = { regiao: process.env.FLY_REGION ?? null, node: process.version, ambiente: AMBIENTE, certificado: TEM_CERTIFICADO };
        if (CERT_PEM) {
          const c = new X509Certificate(CERT_PEM);
          saida.titular = c.subject.split("\n").find((l) => l.startsWith("CN=")) ?? c.subject;
          saida.validoAte = c.validTo;
        }
        // CSC sem revelar o código: só o ID, o tamanho e se ficou o texto de exemplo.
        const resumoCsc = (c) => (c.csc ? { id: c.id, tamanho: c.csc.length, exemplo: /COLE_AQUI/i.test(c.csc) } : null);
        saida.csc = { producao: resumoCsc(csc(1)), homologacao: process.env.CSC_HOM ? resumoCsc(csc(2)) : "não gravado (usa o de produção)" };
        // NFS-e de Goiânia: confere se o WSDL abre com o certificado e quais operações ele tem.
        saida.nfse = {};
        for (const [nome, url] of Object.entries(NFSE_WSDL)) {
          const r = await obterComCertificado(url);
          saida.nfse[nome] = {
            status: r.status, erro: r.erro,
            enderecos: [...new Set([...r.corpo.matchAll(/address\s+location=["']([^"']+)/g)].map((m) => m[1]))],
            operacoes: [...new Set([...r.corpo.matchAll(/<(?:\w+:)?operation\s+name=["']([^"']+)/g)].map((m) => m[1]))],
            tamanho: r.corpo.length,
            wsdl: nome === "homologacao" && r.status === 200 ? r.corpo : undefined, // a API guarda e tira da resposta
            inicio: r.corpo && !/definitions/.test(r.corpo) ? r.corpo.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 160) : undefined,
          };
        }
        // Consulta de uma chave inexistente: só confere conexão e certificado.
        try {
          const r = await distribuicao(`<consChNFe><chNFe>${"0".repeat(44)}</chNFe></consChNFe>`);
          saida.sefaz = `${r.cStat} ${r.xMotivo}`;
        } catch (e) {
          saida.sefaz = `ERRO ${e instanceof Error ? e.message : e}`;
        }
        return responder(res, 200, saida);
      }

      if (pedido.acao === "distNSU") {
        const ult = String(pedido.ultNSU ?? "0").replace(/\D/g, "").padStart(15, "0").slice(-15);
        return responder(res, 200, await distribuicao(`<distNSU><ultNSU>${ult}</ultNSU></distNSU>`));
      }
      if (pedido.acao === "consChNFe" || pedido.acao === "ciencia") {
        const chave = String(pedido.chave ?? "");
        if (!CHAVE_NFE.test(chave)) return responder(res, 400, { erro: "chave de acesso inválida" });
        if (pedido.acao === "ciencia") return responder(res, 200, await ciencia(chave));
        return responder(res, 200, await distribuicao(`<consChNFe><chNFe>${chave}</chNFe></consChNFe>`));
      }
      if (pedido.acao === "nfe_status") return responder(res, 200, await statusGo(Number(pedido.tpAmb) === 1 ? 1 : 2));
      if (pedido.acao === "nfe_autorizar") return responder(res, 200, await autorizarGo(String(pedido.infNFe ?? "")));
      if (String(pedido.acao ?? "").startsWith("nfse_")) {
        const tpAmb = Number(pedido.tpAmb) === 1 ? 1 : 2;
        if (pedido.acao === "nfse_disponivel") {
          const im = String(pedido.im ?? "").replace(/\D/g, "");
          if (!im || im.length > 15) return responder(res, 400, { erro: "inscrição municipal inválida" });
          return responder(res, 200, await nfseDisponivel(tpAmb, im));
        }
        if (pedido.acao === "nfse_gerar") {
          const infDPS = String(pedido.infDPS ?? "");
          // Só DPS do próprio CNPJ da 3M (Id = DPS + município + tipo 2 + CNPJ + série + número).
          if (!infDPS.startsWith(`<infDPS Id="DPS52087072${CNPJ}`) ||!infDPS.endsWith("</infDPS>") || infDPS.length > 60_000)
            return responder(res, 400, { erro: "DPS inválida" });
          return responder(res, 200, await nfseGerar(tpAmb, infDPS, !!pedido.validar));
        }
        if (pedido.acao === "nfse_cancelar") {
          const chave = String(pedido.chave ?? "");
          if (!/^[0-9]{9}[0-9A-Z]{12}[0-9]{29}$/.test(chave) || !chave.includes(CNPJ)) return responder(res, 400, { erro: "chave da NFS-e inválida" });
          if (!["1", "2", "9"].includes(String(pedido.cMotivo))) return responder(res, 400, { erro: "motivo inválido" });
          if (String(pedido.xMotivo ?? "").trim().length < 15) return responder(res, 400, { erro: "motivo com menos de 15 letras" });
          return responder(res, 200, await nfseCancelar(tpAmb, chave, String(pedido.cMotivo), String(pedido.xMotivo).trim().slice(0, 255)));
        }
        return responder(res, 400, { erro: "ação desconhecida" });
      }
      if (pedido.acao === "nfe_cancelar") {
        const chave = String(pedido.chave ?? "");
        if (!CHAVE_NFE.test(chave) || chave.slice(6, 20) !== CNPJ) return responder(res, 400, { erro: "chave de acesso inválida" });
        if (!/^\d{15}$/.test(String(pedido.nProt ?? ""))) return responder(res, 400, { erro: "protocolo inválido" });
        if (String(pedido.xJust ?? "").trim().length < 15) return responder(res, 400, { erro: "justificativa com menos de 15 letras" });
        return responder(res, 200, await cancelarGo(chave, String(pedido.nProt), String(pedido.xJust), Number(pedido.tpAmb) === 1 ? 1 : 2));
      }
      return responder(res, 400, { erro: "ação desconhecida" });
    } catch (e) {
      const erro = (e instanceof Error ? e.message : String(e)) || "erro sem mensagem";
      console.error(`[${pedido.acao ?? (pedido.diagnostico ? "diagnostico" : "?")}] ${erro}`); // aparece em flyctl logs
      // 422, não 502: o proxy do Fly troca a resposta 502 do app pela página dele e o motivo se perdia.
      return responder(res, 422, { erro });
    }
  } catch (e) {
    return responder(res, 500, { erro: e instanceof Error ? e.message : String(e) });
  }
});

// Importado (testes) não sobe o servidor.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) servidor.listen(Number(process.env.PORT ?? 8080), "0.0.0.0", () => {
  console.log(`ponte fiscal da 3M no ar (região ${process.env.FLY_REGION ?? "local"}, ambiente ${AMBIENTE}, certificado: ${TEM_CERTIFICADO})`);
});

export { eventoCiencia, lerDocumento, assinar, infNFeSupl, NS_NFSE, VERSAO_NFSE, pedidoCancelamentoNfse };
