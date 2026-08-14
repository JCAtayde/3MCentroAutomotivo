// API do Espaço do Cliente — 3M Centro Automotivo
// Bindings: D1 "DB" (oficina-3m)
// Rotas (POST/GET em /cliente/api/...):
//   POST convite       {cliente_id, cpf}          -> gera link de convite (staff, valida CPF do cadastro)
//   GET  convite-info?token=...                    -> {ok, nome} para a tela de ativação
//   POST ativar         {token, cpf, zap, senha}   -> cria acesso e loga
//   POST login          {cpf, senha}               -> loga
//   GET  dados                                      -> ficha + histórico (exige sessão)
//   POST sair                                       -> encerra sessão

const SITE = 'https://3mcentroautomotivo.com.br';
const FASES = { agendamento:'Agendado', aguardando:'Aguardando orçamento', andamento:'Em andamento', liberado:'Carro liberado', executado:'Serviço concluído', rejeitado:'Não aprovado' };

function json(obj, status=200, extraHeaders={}) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store', ...extraHeaders } });
}
const dig = s => String(s==null?'':s).replace(/\D/g,'');
function hex(buf){ return [...new Uint8Array(buf)].map(b=>b.toString(16).padStart(2,'0')).join(''); }
function fromHex(h){ const a=new Uint8Array(h.length/2); for(let i=0;i<a.length;i++) a[i]=parseInt(h.substr(i*2,2),16); return a; }
function randomHex(n){ const a=new Uint8Array(n); crypto.getRandomValues(a); return hex(a.buffer); }

async function pbkdf2(senha, saltHex){
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(senha), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name:'PBKDF2', salt: fromHex(saltHex), iterations:100000, hash:'SHA-256' }, key, 256);
  return hex(bits);
}
async function hmac(msg, secretHex){
  const key = await crypto.subtle.importKey('raw', fromHex(secretHex), { name:'HMAC', hash:'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return hex(sig);
}
function b64url(s){ return btoa(unescape(encodeURIComponent(s))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); }
function unb64url(s){ s=s.replace(/-/g,'+').replace(/_/g,'/'); return decodeURIComponent(escape(atob(s))); }

async function getSecret(env){
  const row = await env.DB.prepare("SELECT valor FROM portal_config WHERE chave='sessao_secret'").first();
  if(row && row.valor) return row.valor;
  const sec = randomHex(32);
  await env.DB.prepare("INSERT OR REPLACE INTO portal_config (chave,valor) VALUES ('sessao_secret',?)").bind(sec).run();
  return sec;
}
async function makeSession(cid, secret){ const payload=b64url(JSON.stringify({ cid, exp: Date.now()+30*24*3600*1000 })); return payload+'.'+await hmac(payload, secret); }
async function readSession(tok, secret){ if(!tok) return null; const p=tok.split('.'); if(p.length!==2) return null; const s2=await hmac(p[0],secret); if(s2!==p[1]) return null; try{ const o=JSON.parse(unb64url(p[0])); if(!o.exp||o.exp<Date.now()) return null; return o.cid; }catch(e){ return null; } }
function cookieVal(req, nome){ const c=req.headers.get('Cookie')||''; const m=c.match(new RegExp('(?:^|; )'+nome+'=([^;]+)')); return m?decodeURIComponent(m[1]):null; }
function setCookie(tok){ return 'cliente_sessao='+tok+'; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age='+(30*24*3600); }
function clearCookie(){ return 'cliente_sessao=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0'; }

async function readBody(request){ try{ return await request.json(); }catch(e){ return {}; } }

export async function onRequest(context){
  const { request, env, params } = context;
  const rota = Array.isArray(params.path) ? params.path[0] : params.path;
  if(!env.DB) return json({ error:'Serviço indisponível' }, 500);
  try{
    const secret = await getSecret(env);

    if(rota==='convite' && request.method==='POST'){
      const b = await readBody(request);
      const cli = await env.DB.prepare('SELECT id, nome, cpf FROM clientes WHERE id=?').bind(b.cliente_id||'').first();
      if(!cli) return json({ error:'Cliente não encontrado' }, 404);
      if(dig(cli.cpf).length!==11) return json({ error:'Cadastre o CPF do cliente antes de enviar o convite.' }, 400);
      if(dig(b.cpf)!==dig(cli.cpf)) return json({ error:'CPF não confere com o cadastro.' }, 403);
      const token = randomHex(20);
      await env.DB.prepare('INSERT INTO portal_convites (token,cliente_id,exp,usado,criado) VALUES (?,?,?,0,?)')
        .bind(token, cli.id, Date.now()+7*24*3600*1000, Date.now()).run();
      return json({ ok:true, token, url: SITE+'/cliente/?c='+token, nome: cli.nome });
    }

    if(rota==='convite-info' && request.method==='GET'){
      const url = new URL(request.url); const token = url.searchParams.get('token')||'';
      const cv = await env.DB.prepare('SELECT cliente_id, exp, usado FROM portal_convites WHERE token=?').bind(token).first();
      if(!cv || cv.usado || cv.exp<Date.now()) return json({ ok:false });
      const cli = await env.DB.prepare('SELECT nome FROM clientes WHERE id=?').bind(cv.cliente_id).first();
      const nome=(cli&&cli.nome)||''; const primeiro=nome.split(' ')[0]||'';
      return json({ ok:true, nome: primeiro });
    }

    if(rota==='ativar' && request.method==='POST'){
      const b = await readBody(request);
      const cv = await env.DB.prepare('SELECT cliente_id, exp, usado FROM portal_convites WHERE token=?').bind(b.token||'').first();
      if(!cv || cv.usado || cv.exp<Date.now()) return json({ error:'Convite inválido ou expirado. Peça um novo à oficina.' }, 400);
      const cli = await env.DB.prepare('SELECT id, nome, cpf, telefone1, telefone2, zap_num FROM clientes WHERE id=?').bind(cv.cliente_id).first();
      if(!cli) return json({ error:'Cliente não encontrado.' }, 404);
      if(dig(b.cpf).length!==11 || dig(b.cpf)!==dig(cli.cpf)) return json({ error:'CPF não confere com o nosso cadastro.' }, 403);
      const zapInf = dig(b.zap);
      const numsCad = [dig(cli.telefone1), dig(cli.telefone2)].filter(n=>n.length>=8);
      const zapOk = numsCad.some(n => n.slice(-8) === zapInf.slice(-8));
      if(zapInf.length<8 || !zapOk) return json({ error:'O WhatsApp não confere com o nosso cadastro.' }, 403);
      if(!b.senha || String(b.senha).length<4) return json({ error:'Crie uma senha de pelo menos 4 dígitos.' }, 400);
      const salt = randomHex(16); const senha_hash = await pbkdf2(String(b.senha), salt);
      const ja = await env.DB.prepare('SELECT id FROM portal_contas WHERE cliente_id=?').bind(cli.id).first();
      if(ja) await env.DB.prepare('UPDATE portal_contas SET cpf=?, zap=?, senha_hash=?, salt=?, ativo=1, atualizado=? WHERE id=?').bind(dig(cli.cpf), zapInf, senha_hash, salt, Date.now(), ja.id).run();
      else await env.DB.prepare('INSERT INTO portal_contas (id,cliente_id,cpf,zap,senha_hash,salt,ativo,criado,atualizado) VALUES (?,?,?,?,?,?,1,?,?)').bind(randomHex(12), cli.id, dig(cli.cpf), zapInf, senha_hash, salt, Date.now(), Date.now()).run();
      await env.DB.prepare('UPDATE portal_convites SET usado=1 WHERE token=?').bind(b.token).run();
      await registrarLogin(env, cli.id);
      const tok = await makeSession(cli.id, secret);
      return json({ ok:true, nome:(cli.nome||'').split(' ')[0] }, 200, { 'Set-Cookie': setCookie(tok) });
    }

    if(rota==='login' && request.method==='POST'){
      const b = await readBody(request);
      const conta = await env.DB.prepare('SELECT * FROM portal_contas WHERE cpf=? AND ativo=1').bind(dig(b.cpf)).first();
      if(!conta) return json({ error:'CPF ou senha incorretos.' }, 401);
      const h = await pbkdf2(String(b.senha||''), conta.salt);
      if(h!==conta.senha_hash) return json({ error:'CPF ou senha incorretos.' }, 401);
      const cli = await env.DB.prepare('SELECT nome FROM clientes WHERE id=?').bind(conta.cliente_id).first();
      await registrarLogin(env, conta.cliente_id);
      const tok = await makeSession(conta.cliente_id, secret);
      return json({ ok:true, nome:((cli&&cli.nome)||'').split(' ')[0] }, 200, { 'Set-Cookie': setCookie(tok) });
    }

    if(rota==='sair'){ return json({ ok:true }, 200, { 'Set-Cookie': clearCookie() }); }

    if(rota==='dados' && request.method==='GET'){
      const cid = await readSession(cookieVal(request,'cliente_sessao'), secret);
      if(!cid) return json({ error:'Sessão expirada. Entre novamente.' }, 401);
      const cli = await env.DB.prepare('SELECT nome, telefone1, endereco, cidade, estado FROM clientes WHERE id=?').bind(cid).first();
      if(!cli) return json({ error:'Cadastro não encontrado.' }, 404);
      const veics = (await env.DB.prepare('SELECT id, modelo, placa, ano, cor FROM veiculos WHERE cliente_id=?').bind(cid).all()).results || [];
      const vids = veics.map(v=>v.id);
      let ordens = [];
      if(vids.length){
        const ph = vids.map(()=>'?').join(',');
        const rows = (await env.DB.prepare('SELECT id, veiculo_id, data, status, itens, maodeobra, obs_mecanico, codigo, km, midias FROM ordens WHERE veiculo_id IN ('+ph+')').bind(...vids).all()).results || [];
        ordens = rows.map(r=>{
          let itens=[], mo=[], mids=[]; try{ itens=JSON.parse(r.itens||'[]'); }catch(e){}; try{ mo=JSON.parse(r.maodeobra||'[]'); }catch(e){}; try{ mids=JSON.parse(r.midias||'[]'); }catch(e){}
          const v = veics.find(x=>x.id===r.veiculo_id) || {};
          const pecas = itens.reduce((s,i)=>s+(Number(i.valor)||0)*(Number(i.qtde)||1),0);
          const mdo = mo.reduce((s,m)=>s+(Number(m.valor)||0),0);
          const st = r.status || 'aguardando';
          return {
            data: r.data, km: r.km||null,
            statusKey: st, status: FASES[st]||st,
            veiculo: [v.modelo, v.placa?('('+v.placa+')'):''].filter(Boolean).join(' '),
            itens: itens.map(i=>({ nome:i.nome, qtde:Number(i.qtde)||1, valor:Number(i.valor)||0 })),
            maodeobra: mdo, pecas, total: pecas+mdo,
            diagnostico: r.obs_mecanico||'',
            temMidia: (mids||[]).length>0,
            link: (mids||[]).length ? (SITE+'/os/'+(r.codigo||r.id)) : ''
          };
        }).sort((a,b)=>String(b.data||'').localeCompare(String(a.data||'')));
      }
      return json({ ok:true,
        cliente:{ nome:cli.nome||'', telefone:cli.telefone1||'', endereco:cli.endereco||'', cidade:[cli.cidade,cli.estado].filter(Boolean).join(' - ') },
        veiculos: veics.map(v=>({ modelo:v.modelo||'', placa:v.placa||'', ano:v.ano||'', cor:v.cor||'' })),
        ordens });
    }

    return json({ error:'Rota não encontrada' }, 404);
  }catch(e){
    return json({ error:'Falha no servidor: '+(e&&e.message||e) }, 500);
  }
}

async function registrarLogin(env, cliente_id){
  try{
    const agora = new Date();
    const iso = agora.toISOString();
    await env.DB.prepare('INSERT INTO portal_logins (id,cliente_id,quando,ts,criado) VALUES (?,?,?,?,?)')
      .bind(randomHex(10), cliente_id, iso, agora.getTime(), agora.getTime()).run();
  }catch(e){}
}
