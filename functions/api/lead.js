/**
 * Captação pública do site (pré-cadastro de cliente + carros).
 * Rota: /api/lead  (POST)  — NÃO fica atrás do login/Access.
 * Grava direto na base do gestão (clientes + veiculos). Placa é obrigatória.
 */
const CORS = { 'access-control-allow-origin':'*', 'access-control-allow-methods':'POST,OPTIONS', 'access-control-allow-headers':'content-type' };
const json = (o, s=200) => new Response(JSON.stringify(o), { status:s, headers:{ 'content-type':'application/json; charset=utf-8', ...CORS } });
const MIN = ['de','da','do','das','dos','e','com','para','por','em','no','na','ao','a','o','as','os'];
function tc(s){ return String(s||'').trim().replace(/\s+/g,' ').split(' ').map((w,i)=>{ if(!w) return w; const lw=w.toLowerCase(); if(i>0 && MIN.includes(lw)) return lw; return w.charAt(0).toUpperCase()+w.slice(1); }).join(' '); }

export async function onRequestOptions(){ return new Response(null, { headers: CORS }); }

export async function onRequestPost(context){
  const { request, env } = context;
  const DB = env.DB;
  if(!DB) return json({ error:'Banco indisponível no momento.' }, 500);

  let body; try { body = await request.json(); } catch(e){ return json({ error:'Requisição inválida.' }, 400); }

  // Honeypot anti-robô: se veio preenchido, finge sucesso e descarta.
  if((body.website||'').trim()) return json({ ok:true });

  const nome = tc((body.nome||'').trim().slice(0,120));
  const telefone = (body.telefone||'').replace(/[^\d]/g,'').slice(0,13);
  const email = (body.email||'').trim().slice(0,120);
  const problema = (body.problema||'').trim().slice(0,500);
  if(!nome) return json({ error:'Informe seu nome.' }, 400);
  if(telefone.length < 10) return json({ error:'Informe um WhatsApp válido com DDD.' }, 400);

  let carros = Array.isArray(body.carros) ? body.carros : [];
  carros = carros.map(c => ({
    placa:(c.placa||'').trim().toUpperCase().replace(/\s+/g,'').slice(0,10),
    modelo:tc((c.modelo||'').trim().slice(0,60)),
    ano:(c.ano==null?'':String(c.ano)).trim().slice(0,8),
    cambio:(c.cambio||'').trim().slice(0,20),
    km: parseInt(String(c.km==null?'':c.km).replace(/\D/g,'')) || null,
  })).filter(c => c.modelo || c.ano || c.cambio || c.placa);
  if(carros.length > 6) carros = carros.slice(0,6);

  const now = Date.now();
  const cid = crypto.randomUUID();
  const obs = 'Pré-cadastro pelo site' + (problema ? (' · Problema relatado: '+problema) : '') + (email ? (' · e-mail: '+email) : '');
  const stmts = [];
  stmts.push(DB.prepare(
    'INSERT INTO clientes (id,nome,tipo,telefone1,telefone2,endereco,obs,contatos,nascimento,zap_num,lead,criado,atualizado) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).bind(cid, nome, 'Preventiva', telefone, '', '', obs, '[]', '', '1', 'novo', now, now));
  for(const c of carros){
    stmts.push(DB.prepare(
      'INSERT INTO veiculos (id,cliente_id,placa,modelo,ano,cor,km_atual,media_km_mes,entrevista,inspecao,cambio,criado,atualizado) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
    ).bind(crypto.randomUUID(), cid, c.placa, c.modelo, c.ano, '', c.km, null, null, '{}', c.cambio, now, now));
  }
  try { await DB.batch(stmts); }
  catch(e){ return json({ error:'Não foi possível salvar agora. Tente novamente.' }, 500); }
  return json({ ok:true, carros:carros.length });
}
