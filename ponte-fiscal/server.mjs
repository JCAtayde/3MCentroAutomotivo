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
// Segredos (fly secrets):
//   PONTE_TOKEN        senha compartilhada com o sistema (cabeçalho x-ponte-token);
//   CERT_CADEIA_B64    certificado + cadeia em PEM, em base64 (conexão);
//   CERT_CHAVE_B64     chave privada PKCS#8 em PEM, em base64 (conexão e assinatura).
// Variáveis (fly.toml): CNPJ, UF (código IBGE), AMBIENTE (1 produção, 2 homologação).

import http from "node:http";
import https from "node:https";
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

const agente = TEM_CERTIFICADO
  ? new https.Agent({ cert: CADEIA, key: CHAVE, keepAlive: true, maxSockets: 4 })
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
function chamarSoap(url, envelope, comCertificado = true) {
  return new Promise((resolve, reject) => {
    const opcoes = {
      method: "POST",
      headers: {
        "content-type": "application/soap+xml; charset=utf-8",
        "content-length": Buffer.byteLength(envelope),
      },
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
function assinar(infEvento, id) {
  // Na forma canônica o infEvento herda o xmlns do <evento>.
  const canonico = infEvento.replace("<infEvento ", `<infEvento xmlns="${NS_NFE}" `);
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
      return responder(res, 400, { erro: "ação desconhecida" });
    } catch (e) {
      return responder(res, 502, { erro: e instanceof Error ? e.message : String(e) });
    }
  } catch (e) {
    return responder(res, 500, { erro: e instanceof Error ? e.message : String(e) });
  }
});

// Importado (testes) não sobe o servidor.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) servidor.listen(Number(process.env.PORT ?? 8080), "0.0.0.0", () => {
  console.log(`ponte fiscal da 3M no ar (região ${process.env.FLY_REGION ?? "local"}, ambiente ${AMBIENTE}, certificado: ${TEM_CERTIFICADO})`);
});

export { eventoCiencia, lerDocumento };
