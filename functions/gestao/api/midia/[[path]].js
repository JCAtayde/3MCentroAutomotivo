// Upload / servir / excluir fotos e vídeos das OS, no R2.
// Binding necessário no Pages: R2 bucket binding "MEDIA" -> oficina-3m-midia
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Tipo, X-Nome',
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...CORS } });
}
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

export async function onRequest(context) {
  const { request, env, params } = context;
  if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

  const MEDIA = env.MEDIA;
  if (!MEDIA) return json({ error: 'R2 não configurado. Faça o binding "MEDIA" no Pages.' }, 500);

  // params.path é um array com os segmentos após /gestao/api/midia/
  const seg = Array.isArray(params.path) ? params.path : (params.path ? [params.path] : []);
  const key = seg.join('/');

  try {
    // POST /gestao/api/midia  -> envia arquivo (body = bytes), retorna { key }
    if (request.method === 'POST') {
      const tipo = request.headers.get('X-Tipo') || 'image';
      const ct = request.headers.get('Content-Type') || (tipo === 'video' ? 'video/mp4' : 'image/jpeg');
      let ext = 'bin';
      if (ct.includes('video')) ext = ct.includes('webm') ? 'webm' : (ct.includes('quicktime') ? 'mov' : 'mp4');
      else if (ct.includes('image')) ext = ct.includes('png') ? 'png' : (ct.includes('webp') ? 'webp' : 'jpg');
      const novaKey = 'os/' + uid() + '.' + ext;
      const buf = await request.arrayBuffer();
      if (!buf || buf.byteLength === 0) return json({ error: 'arquivo vazio' }, 400);
      await MEDIA.put(novaKey, buf, { httpMetadata: { contentType: ct } });
      return json({ key: novaKey, tipo: ct.includes('video') ? 'video' : 'image', ct });
    }

    // GET /gestao/api/midia/<key> -> devolve o arquivo
    if (request.method === 'GET') {
      if (!key) return json({ error: 'sem chave' }, 400);
      const obj = await MEDIA.get(key);
      if (!obj) return new Response('não encontrado', { status: 404, headers: CORS });
      const headers = new Headers(CORS);
      headers.set('Content-Type', (obj.httpMetadata && obj.httpMetadata.contentType) || 'application/octet-stream');
      headers.set('Cache-Control', 'public, max-age=31536000');
      return new Response(obj.body, { headers });
    }

    // DELETE /gestao/api/midia/<key>
    if (request.method === 'DELETE') {
      if (!key) return json({ error: 'sem chave' }, 400);
      await MEDIA.delete(key);
      return json({ ok: true });
    }

    return json({ error: 'método não suportado' }, 405);
  } catch (e) {
    return json({ error: String(e && e.message || e) }, 500);
  }
}
