# Certificado A1 da 3M e notas de compra (SEFAZ)

O sistema puxa da SEFAZ as NF-e emitidas **contra o CNPJ da 3M**
(49.958.723/0001-97), ou seja, as compras de peças, usando o serviço
**Distribuição de DF-e** do Ambiente Nacional. Ele faz a **Ciência da
Operação** automaticamente para liberar o XML completo. Com os itens, monta o
cadastro de peças (NCM, custo, EAN, código do fornecedor) e o de fornecedores.

O Ambiente Nacional exige o certificado e-CNPJ A1 **na conexão** (mTLS). Por
isso quem fala com a SEFAZ é a **ponte fiscal** (`ponte-fiscal/`, Node no
Fly.io, app `3m-fiscal-ponte`, região São Paulo). A ponte guarda o
certificado, assina o evento de ciência e só aceita as ações fechadas
`distNSU`, `consChNFe` e `ciencia`. Ela não é um proxy aberto.

O certificado fica **só no Fly.io**: nunca no git, no banco, na Cloudflare ou
no navegador. A Cloudflare guarda apenas o endereço da ponte e a senha de
acesso a ela.

| Onde | Nome | O que é |
| --- | --- | --- |
| Fly.io (secret) | `CERT_CADEIA_B64` | certificado + cadeia (PEM em base64) |
| Fly.io (secret) | `CERT_CHAVE_B64` | chave privada PKCS#8 (PEM em base64) |
| Fly.io (secret) | `PONTE_TOKEN` | senha compartilhada com o sistema |
| Cloudflare Pages (secret) | `PONTE_FISCAL_URL` | `https://3m-fiscal-ponte.fly.dev/` |
| Cloudflare Pages (secret) | `PONTE_FISCAL_TOKEN` | a mesma senha do `PONTE_TOKEN` |

Os comandos usam o Git Bash. O Fly fica em `/c/Users/Usuario/.fly/bin/flyctl.exe`
(chamado de `flyctl` abaixo).

## 1. Criar a ponte (uma vez só — feito em 22/10/2026)

A ponte já existe e está no ar em `https://3m-fiscal-ponte.fly.dev/` (região
gru). Sem os segredos ela recusa todo pedido. Para recriar do zero:

```sh
cd /c/SITES/3MCentroAutomotivo/ponte-fiscal
flyctl apps create 3m-fiscal-ponte
```

Se algum comando do Fly responder `unauthorized`, entre de novo com
`flyctl auth login`.

## 2. Converter o .pfx (em C:\certificado-3m)

Coloque o `.pfx` da 3M em `C:\certificado-3m\certificado.pfx`. Cada comando
pede a senha do certificado. Se der erro de algoritmo, os comandos com
`-legacy` resolvem (certificados antigos exigem).

```sh
cd /c/certificado-3m
openssl pkcs12 -legacy -in certificado.pfx -nokeys | sed -n '/BEGIN CERTIFICATE/,/END CERTIFICATE/p' > cadeia.pem
openssl pkcs12 -legacy -in certificado.pfx -nocerts -nodes -out chave-original.pem
openssl pkcs8 -topk8 -nocrypt -in chave-original.pem -out chave.pem
```

O primeiro certificado de `cadeia.pem` tem que ser o da 3M. Confira com
`openssl x509 -in cadeia.pem -noout -subject -enddate`: deve aparecer
`JCMA CENTRO AUTOMOTIVO LTDA:49958723000197` e a data de validade.

## 3. Gravar o certificado e a senha na ponte

```sh
TOKEN=$(openssl rand -hex 32 | tr -dc '0-9a-f'); printf '%s' "$TOKEN" > /c/certificado-3m/token.txt
{ printf 'CERT_CADEIA_B64=%s\n' "$(base64 -w0 /c/certificado-3m/cadeia.pem)"; printf 'CERT_CHAVE_B64=%s\n' "$(base64 -w0 /c/certificado-3m/chave.pem)"; printf 'PONTE_TOKEN=%s\n' "$TOKEN"; } | flyctl secrets import -a 3m-fiscal-ponte --stage
cd /c/SITES/3MCentroAutomotivo/ponte-fiscal && flyctl deploy -a 3m-fiscal-ponte --remote-only --ha=false
```

O `tr -dc` não é enfeite: no Windows o `openssl` termina a linha com `\r`, e
uma senha com `\r` não passa no cabeçalho (a ponte responde `400` vazio).

Os valores vão pela entrada padrão, não pela linha de comando: no Windows, uma
linha de comando longa (a cadeia tem cerca de 10 mil caracteres) é recusada.

## 4. Ligar o sistema à ponte (Cloudflare)

No painel da Cloudflare: **Workers & Pages → projeto do site → Settings →
Variables and Secrets → Add**, tipo **Secret**, em **Production**:

- `PONTE_FISCAL_URL` = `https://3m-fiscal-ponte.fly.dev/`
- `PONTE_FISCAL_TOKEN` = o conteúdo de `C:\certificado-3m\token.txt`

Depois, faça um novo deploy (qualquer commit, ou **Deployments → Retry
deployment**) para o site ler os segredos.

## 5. Apagar os arquivos convertidos

```sh
rm /c/certificado-3m/cadeia.pem /c/certificado-3m/chave-original.pem /c/certificado-3m/chave.pem /c/certificado-3m/token.txt
```

Guarde só o `.pfx` original, em lugar seguro.

## Conferir

No sistema: **Mais → Notas de compra → Diagnóstico** (só para administrador).
Com tudo certo, aparecem `certificado: true`, o titular, a validade e, em
`sefaz`, uma resposta da SEFAZ com código. Não pode aparecer `ERRO`. O
diagnóstico consulta uma chave inexistente, então não grava nada.

Depois, toque em **Buscar na SEFAZ**:

- A **primeira busca** traz as notas dos **últimos 90 dias**. Esse é o limite
  da SEFAZ; notas mais antigas não vêm por esse serviço.
- Notas que chegam só como **resumo** recebem a ciência na hora. O XML completo,
  com os itens, costuma ser liberado alguns minutos depois. Basta buscar de novo
  mais tarde.
- Regra da SEFAZ: quando não há nada novo, a próxima consulta só pode ser feita
  **1 hora depois**. O sistema respeita isso sozinho e mostra o horário
  liberado. Consultar antes disso faz a SEFAZ bloquear por "consumo indevido"
  (código 656).

## Renovação (o A1 vence em 1 ano)

Repita os passos 2, 3 (sem gerar outro token: grave só as duas linhas
`CERT_...`, sem `--stage`) e 5 com o certificado novo. O Fly reinicia a ponte
sozinho.
