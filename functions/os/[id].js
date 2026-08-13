// Página pública que mostra SOMENTE fotos e vídeos de uma OS.
// Sem valores, sem dados do cliente. Rota: /os/<id>
// Bindings necessários no Pages: D1 "DB" (oficina-3m) e R2 "MEDIA" (oficina-3m-midia)

function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

function pagina(titulo, corpo, meta){
  meta = meta || {};
  const og = `
    <meta property="og:type" content="website">
    <meta property="og:site_name" content="3M Centro Automotivo">
    <meta property="og:title" content="${esc(meta.title||titulo)}">
    <meta property="og:description" content="${esc(meta.desc||'Imagens e vídeos do serviço do seu veículo.')}">
    ${meta.image ? `<meta property="og:image" content="${esc(meta.image)}">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:image" content="${esc(meta.image)}">` : ''}
    ${meta.url ? `<meta property="og:url" content="${esc(meta.url)}">` : ''}`;
  return `<!doctype html><html lang="pt-BR"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(titulo)}</title>${og}
<style>
  :root{--gold:#E8B23A}
  *{box-sizing:border-box}
  body{margin:0;background:#0d0f12;color:#e9edf2;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif}
  .top{padding:18px 16px;border-bottom:1px solid #22262c;display:flex;align-items:center;gap:10px}
  .logo{font-weight:800;color:var(--gold);letter-spacing:.5px}
  .wrap{max-width:900px;margin:0 auto;padding:16px}
  h1{font-size:18px;margin:6px 0 2px}
  .sub{color:#9aa3af;font-size:13px;margin:0 0 16px}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px}
  .item{background:#000;border:1px solid #22262c;border-radius:12px;overflow:hidden;aspect-ratio:1/1}
  .item img,.item video{width:100%;height:100%;object-fit:cover;display:block}
  .item.vid{aspect-ratio:auto;background:#111}
  .item.vid video{height:auto;max-height:70vh;object-fit:contain}
  .vopen{display:block;text-align:center;padding:9px;background:var(--gold);color:#1a1206;font-weight:800;text-decoration:none;font-size:13px}
  .dica{color:#c9d0d8;background:#1a1f26;border:1px solid #22262c;border-radius:10px;padding:10px 12px;font-size:13px;margin:0 0 14px}
  .sec{font-size:15px;margin:20px 0 8px;color:var(--gold)}
  .empty{color:#9aa3af;text-align:center;padding:40px 10px}
  .foot{color:#6b7280;font-size:12px;text-align:center;padding:22px 10px}
</style></head>
<body><div class="top"><span class="logo">3M CENTRO AUTOMOTIVO</span></div>
<div class="wrap">${corpo}</div>
<div class="foot">3M Centro Automotivo · imagens do seu serviço</div>
</body></html>`;
}

export async function onRequest(context){
  const { env, params, request } = context;
  const cod = Array.isArray(params.id) ? params.id[0] : params.id;
  try{
    if(!env.DB) return new Response(pagina('Indisponível','<div class="empty">Serviço indisponível no momento.</div>'), {status:200, headers:{'Content-Type':'text/html; charset=utf-8'}});
    let row = await env.DB.prepare('SELECT id, veiculo_id, midias FROM ordens WHERE codigo = ?').bind(cod).first();
    if(!row) row = await env.DB.prepare('SELECT id, veiculo_id, midias FROM ordens WHERE id = ?').bind(cod).first();
    if(!row){
      return new Response(pagina('Não encontrado','<div class="empty">Ordem de serviço não encontrada.</div>'), {status:404, headers:{'Content-Type':'text/html; charset=utf-8'}});
    }
    let midias = [];
    try{ midias = JSON.parse(row.midias || '[]'); }catch(e){ midias = []; }

    let carro = '';
    try{
      const v = await env.DB.prepare('SELECT modelo, ano FROM veiculos WHERE id = ?').bind(row.veiculo_id).first();
      if(v) carro = [v.modelo, v.ano].filter(Boolean).join(' ');
    }catch(e){}

    function cardMidia(m){
      const src = '/gestao/api/midia/' + m.key;
      return m.tipo === 'video'
        ? `<div class="item vid"><video src="${esc(src)}#t=0.1" controls playsinline preload="metadata"></video><a class="vopen" href="${esc(src)}" target="_blank">▶ Abrir vídeo</a></div>`
        : `<div class="item"><a href="${esc(src)}" target="_blank"><img src="${esc(src)}" alt="foto do serviço"></a></div>`;
    }
    const entrada = (midias || []).filter(m => (m.cat || 'defeito') === 'entrada');
    const defeito = (midias || []).filter(m => (m.cat || 'defeito') === 'defeito');
    const itensEntrada = entrada.map(cardMidia).join('');
    const itensDefeito = defeito.map(cardMidia).join('');
    const temVideo = [...entrada, ...defeito].some(m => m.tipo === 'video');

    const primeiraFoto = [...defeito, ...entrada].find(m => (m.tipo||'image') !== 'video');
    const ogImage = primeiraFoto ? ('https://3mcentroautomotivo.com.br/gestao/api/midia/' + primeiraFoto.key) : '';

    const secEntrada = itensEntrada ? `<h2 class="sec">🚗 Imagens da Entrada do seu Veículo em Nossa Oficina</h2><div class="grid">${itensEntrada}</div>` : '';
    const secDefeito = itensDefeito ? `<h2 class="sec">🔧 Fotos e Vídeos do Diagnóstico Feito do seu Veículo</h2><div class="grid">${itensDefeito}</div>` : '';
    const corpo = `
      <h1>Imagens e Vídeos do seu Serviço</h1>
      <p class="sub">${carro ? esc(carro) : 'Seu veículo'}</p>
      ${temVideo ? '<p class="dica">Se algum vídeo não abrir direto, toque em <b>“▶ Abrir vídeo”</b>.</p>' : ''}
      ${(secEntrada||secDefeito) ? (secEntrada+secDefeito) : '<div class="empty">Ainda não há imagens ou vídeos para este serviço.</div>'}`;

    const meta = {
      title: 'Imagens e Vídeos dos Problemas Encontrados',
      desc: (carro ? carro + ' · ' : '') + '3M Centro Automotivo',
      image: ogImage,
      url: request.url,
    };
    return new Response(pagina('Imagens e Vídeos dos Problemas Encontrados', corpo, meta), {status:200, headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}});
  }catch(e){
    return new Response(pagina('Erro','<div class="empty">Não foi possível carregar as imagens.</div>'), {status:200, headers:{'Content-Type':'text/html; charset=utf-8'}});
  }
}
