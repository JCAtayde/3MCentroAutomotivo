// Página pública que mostra SOMENTE fotos e vídeos de uma OS.
// Sem valores, sem dados do cliente. Rota: /os/<id>
// Bindings necessários no Pages: D1 "DB" (oficina-3m) e R2 "MEDIA" (oficina-3m-midia)

function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

function pagina(titulo, corpo){
  return `<!doctype html><html lang="pt-BR"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(titulo)}</title>
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
  .empty{color:#9aa3af;text-align:center;padding:40px 10px}
  .foot{color:#6b7280;font-size:12px;text-align:center;padding:22px 10px}
</style></head>
<body><div class="top"><span class="logo">3M CENTRO AUTOMOTIVO</span></div>
<div class="wrap">${corpo}</div>
<div class="foot">3M Centro Automotivo · imagens do seu serviço</div>
</body></html>`;
}

export async function onRequest(context){
  const { env, params } = context;
  const id = Array.isArray(params.id) ? params.id[0] : params.id;
  try{
    if(!env.DB) return new Response(pagina('Indisponível','<div class="empty">Serviço indisponível no momento.</div>'), {status:200, headers:{'Content-Type':'text/html; charset=utf-8'}});
    const row = await env.DB.prepare('SELECT id, veiculo_id, midias FROM ordens WHERE id = ?').bind(id).first();
    if(!row){
      return new Response(pagina('Não encontrado','<div class="empty">Ordem de serviço não encontrada.</div>'), {status:404, headers:{'Content-Type':'text/html; charset=utf-8'}});
    }
    let midias = [];
    try{ midias = JSON.parse(row.midias || '[]'); }catch(e){ midias = []; }

    // nome do veículo (sem dados sensíveis)
    let carro = '';
    try{
      const v = await env.DB.prepare('SELECT modelo, ano FROM veiculos WHERE id = ?').bind(row.veiculo_id).first();
      if(v) carro = [v.modelo, v.ano].filter(Boolean).join(' ');
    }catch(e){}

    const itens = (midias || []).map(m => {
      const src = '/gestao/api/midia/' + m.key;
      return m.tipo === 'video'
        ? `<div class="item"><video src="${esc(src)}" controls preload="metadata"></video></div>`
        : `<div class="item"><a href="${esc(src)}" target="_blank"><img src="${esc(src)}" alt="foto do serviço"></a></div>`;
    }).join('');

    const corpo = `
      <h1>Fotos e vídeos do serviço</h1>
      <p class="sub">${carro ? esc(carro) : 'Seu veículo'}</p>
      ${itens ? `<div class="grid">${itens}</div>` : '<div class="empty">Ainda não há fotos ou vídeos para este serviço.</div>'}`;

    return new Response(pagina('Fotos do serviço — 3M', corpo), {status:200, headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}});
  }catch(e){
    return new Response(pagina('Erro','<div class="empty">Não foi possível carregar as imagens.</div>'), {status:200, headers:{'Content-Type':'text/html; charset=utf-8'}});
  }
}
