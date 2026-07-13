# 3M Centro Automotivo — site

**A gente não chuta. A gente analisa.**

---

## O que tem nesta pasta

```
index.html      → o site inteiro (dê dois cliques para ver)
midia/          → fachada, foto da descarbonização, 9 vídeos e as capas
marca/          → logo em vetor (todas as versões) + manual da marca
_headers        → configuração do Cloudflare (não mexa)
_redirects      → configuração do Cloudflare (não mexa)
robots.txt      → para o Google (não mexa)
sitemap.xml     → para o Google (não mexa)
LEIA-ME.md      → este guia
```

---

## COMO COLOCAR NO AR — GitHub + Cloudflare

### PARTE 1 — GitHub (guardar os arquivos)

1. Entre em **github.com** e faça login.
2. Clique no **+** no canto superior direito → **New repository**.
3. Preencha:
   - Repository name: `3m-centro-automotivo`
   - Marque **Public**
   - **NÃO** marque "Add a README file"
   - Clique em **Create repository**
4. Na tela seguinte, clique no link **"uploading an existing file"**.
5. Abra a pasta do site no seu computador. **Selecione tudo o que está DENTRO dela**
   (index.html, as pastas midia e marca, e os outros arquivos) e arraste para o GitHub.
   ⚠️ Arraste o CONTEÚDO da pasta, não a pasta em si.
6. Espere subir (são 56 MB, pode demorar alguns minutos).
7. Clique em **Commit changes**.

### PARTE 2 — Cloudflare Pages (publicar o site)

8. Entre em **dash.cloudflare.com**.
9. No menu à esquerda: **Compute (Workers & Pages)** → **Create** → aba **Pages**
   → **Connect to Git**.
10. Autorize o Cloudflare a acessar seu GitHub e escolha o repositório `3m-centro-automotivo`.
11. Na tela de configuração:
    - Framework preset: **None**
    - Build command: **deixe em branco**
    - Build output directory: **/** (só a barra)
12. Clique em **Save and Deploy**.
13. Em 1 ou 2 minutos ele publica e te dá um endereço tipo
    `3m-centro-automotivo.pages.dev`. **Abra e confira o site.**

### PARTE 3 — Trazer o domínio para o Cloudflare

14. No painel do Cloudflare: **Add a domain** (ou "+ Add site").
15. Digite `3mcentroautomotivo.com.br` → escolha o plano **Free** → Continue.
16. O Cloudflare vai te mostrar **dois servidores DNS** (nameservers), com nomes parecidos
    com `xxx.ns.cloudflare.com`. **Copie os dois.**

### PARTE 4 — Registro.br (apontar o domínio)

17. Entre em **registro.br** → clique no domínio `3mcentroautomotivo.com.br`.
18. Vá em **DNS** → **Alterar servidores DNS** (ou "Usar outros servidores DNS").
19. Apague o que estiver lá e cole os **dois servidores do Cloudflare**.
20. Salve.
21. Agora espere. Pode levar **até 24 horas**, mas normalmente resolve em poucas horas.
    O Cloudflare te manda um e-mail quando o domínio for ativado.

### PARTE 5 — Ligar o domínio no site

22. Quando o Cloudflare avisar que o domínio está ativo, volte em
    **Workers & Pages** → seu projeto → aba **Custom domains** → **Set up a custom domain**.
23. Adicione: `www.3mcentroautomotivo.com.br`
24. Adicione também: `3mcentroautomotivo.com.br`
25. Pronto. O cadeado (HTTPS) é automático e de graça.

---

## COMO ATUALIZAR O SITE DEPOIS

Toda vez que você quiser mudar alguma coisa:

1. Vá no seu repositório no GitHub.
2. Suba o arquivo novo (ou edite direto lá pelo lápis ✏️).
3. Clique em **Commit changes**.
4. **O Cloudflare publica sozinho em 1 minuto.** Você não precisa fazer mais nada.

É por isso que o GitHub vale a pena: você mexe num lugar só e o site se atualiza.

---

## COMO MEXER NOS TEXTOS DOS CASOS

Abra o `index.html` num editor de texto e procure por:

```
CASOS — edite os textos entre aspas
```

Ali estão os 6 casos. Troque o texto entre aspas de `titulo`, `relato` e da lista de efeitos.
Não mexa no campo `arq` — é ele que aponta para o arquivo de vídeo.

Para adicionar um caso novo: copie um bloco inteiro (do `{` até o `},`), cole abaixo,
troque os textos, e coloque o vídeo novo em `midia/` com o nome `diag-10.mp4`
(e a capa como `midia/poster-10.jpg`).

---

## AINDA FALTA (e vale dinheiro)

1. **Colar o endereço do site no seu Google Meu Negócio.** É o passo mais importante
   de todos. Você tem 4,9 com 138 avaliações — quem pesquisar "mecânica em Goiânia"
   vai ver seu perfil, e agora com um botão levando pro site.
2. **Avaliações do Google automáticas** no site (hoje as 3 são fixas).
3. **CNPJ no rodapé** — está escrito `[preencher]`.
4. **A parede cinza da fachada.** Cabe ali, em dourado:
   *"A GENTE NÃO CHUTA. A GENTE ANALISA."*
5. **O banner da placa**, quando trocar: use o dourado da marca (#D9A83E), que é mais
   sóbrio que o amarelo atual. Os arquivos estão em `marca/`.

---

## A MARCA

- Dourado 3M: **#D9A83E**
- Preto 3M: **#0C0E10**

Abra `marca/manual-da-marca-3m.html` para ver todas as versões da logo, onde usar
cada uma e o que não pode ser feito.
