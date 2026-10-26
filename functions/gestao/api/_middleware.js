/**
 * Porteiro da API do /gestao: nada passa sem sessão válida (ver functions/_lib/auth-gestao.js).
 *
 * Livres de sessão:
 *   /gestao/api/auth/*            login, cadastro, pedido de senha, sair, quem sou eu
 *   GET /gestao/api/midia/<chave> fotos e vídeos das OS (a página pública /os/<código> usa;
 *                                 chave aleatória, só leitura — enviar e apagar exigem sessão)
 *
 * Rotas de login (POST, salvo "eu"):
 *   login        { login, senha }              → cookie de sessão; pendente/bloqueado não entra
 *   cadastro     { nome, login, email, senha } → pendente (o primeiro usuário vira administrador)
 *   pedir_senha  { login }                     → marca o pedido; o administrador define a nova
 *   senha        { nova, atual? , usuario_id? } (com sessão) — a própria exige a atual;
 *                                               a de outro usuário só o administrador
 *   sair
 *   GET eu                                     → usuário da sessão ou 401
 */
import {
  garantirTabelasAuth, usuarioDaSessao, conferirSenha, hashNovo, criarSessao, cookieSessao, cookieSair,
  bloqueado, registrarFalha, limparFalhas, usuarioPublico,
} from '../../_lib/auth-gestao.js';

const json = (o, s = 200, extra = {}) => new Response(JSON.stringify(o), {
  status: s, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra } });

export async function onRequest(context) {
  const { request, env } = context;
  const DB = env.DB;
  if (!DB) return json({ error: 'Banco D1 não conectado (binding DB ausente).' }, 500);
  const url = new URL(request.url);
  const p = url.pathname;

  if (p.startsWith('/gestao/api/midia/') && request.method === 'GET') return context.next();

  await garantirTabelasAuth(DB);
  if (p.startsWith('/gestao/api/auth/')) return rotasAuth(context, p.slice('/gestao/api/auth/'.length));

  const u = await usuarioDaSessao(DB, request);
  if (!u) return json({ error: 'Faça login para continuar.', login: true }, 401);
  context.data.usuario = u;
  return context.next();
}

async function rotasAuth(context, rota) {
  const { request, env } = context;
  const DB = env.DB;
  const ip = request.headers.get('CF-Connecting-IP') || '';

  if (rota === 'eu' && request.method === 'GET') {
    const u = await usuarioDaSessao(DB, request);
    return u ? json({ ok: true, usuario: usuarioPublico(u) }) : json({ error: 'Sem sessão.', login: true }, 401);
  }
  if (rota === 'sair') return json({ ok: true }, 200, { 'Set-Cookie': cookieSair() });
  if (request.method !== 'POST') return json({ error: 'rota não encontrada' }, 404);
  const b = await request.json().catch(() => ({}));
  const login = String(b.login || '').trim().toLowerCase();

  if (rota === 'login') {
    const chaves = ['login:' + login, 'ip:' + ip];
    if (await bloqueado(DB, chaves)) return json({ error: 'Muitas tentativas erradas. Espere 15 minutos e tente de novo.' }, 429);
    const u = login ? await DB.prepare('SELECT * FROM usuarios WHERE lower(login)=? OR lower(email)=?').bind(login, login).first() : null;
    const c = await conferirSenha(u, b.senha || '');
    if (!c.ok) { await registrarFalha(DB, chaves); return json({ error: 'Usuário ou senha incorretos.' }, 401); }
    await limparFalhas(DB, chaves);
    if (u.status !== 'ativo') return json({ ok: false, espera: true, usuario: usuarioPublico(u) });
    if (c.migrar) { // senha antiga do navegador → formato forte, sem o usuário perceber
      const h = await hashNovo(b.senha); u.senha_hash = h.senha_hash; u.salt = h.salt;
      await DB.prepare('UPDATE usuarios SET senha_hash=?, salt=? WHERE id=?').bind(h.senha_hash, h.salt, u.id).run();
    }
    return json({ ok: true, usuario: usuarioPublico(u) }, 200, { 'Set-Cookie': cookieSessao(await criarSessao(DB, u)) });
  }

  if (rota === 'cadastro') {
    const nome = String(b.nome || '').trim().slice(0, 80);
    if (!nome || !login || String(b.senha || '').length < 4) return json({ error: 'Preencha nome, login e uma senha de pelo menos 4 caracteres.' }, 400);
    if (await bloqueado(DB, ['cad:' + ip])) return json({ error: 'Muitos cadastros seguidos. Tente mais tarde.' }, 429);
    if (await DB.prepare('SELECT id FROM usuarios WHERE lower(login)=?').bind(login).first()) return json({ error: 'Esse login já existe.' }, 409);
    const total = (await DB.prepare('SELECT COUNT(*) AS n FROM usuarios').first()).n;
    const primeiro = total === 0;
    const h = await hashNovo(b.senha);
    const u = { id: crypto.randomUUID(), nome, login, email: String(b.email || '').trim().slice(0, 120), status: primeiro ? 'ativo' : 'pendente', papel: primeiro ? 'admin' : 'operador', ...h };
    await DB.prepare('INSERT INTO usuarios (id,nome,login,email,senha_hash,salt,status,papel,perms,reset,criado,atualizado) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .bind(u.id, u.nome, u.login, u.email, u.senha_hash, u.salt, u.status, u.papel, null, '', Date.now(), Date.now()).run();
    await registrarFalha(DB, ['cad:' + ip]); // conta cadastros por IP (limite anti-robô)
    if (!primeiro) return json({ ok: false, espera: true, usuario: usuarioPublico(u) });
    return json({ ok: true, usuario: usuarioPublico(u) }, 200, { 'Set-Cookie': cookieSessao(await criarSessao(DB, u)) });
  }

  if (rota === 'pedir_senha') {
    // Antes qualquer um trocava a senha de qualquer login aqui. Agora só fica o pedido.
    if (login) await DB.prepare("UPDATE usuarios SET reset=?, atualizado=? WHERE lower(login)=? OR lower(email)=?").bind('pedido ' + new Date().toISOString(), Date.now(), login, login).run();
    return json({ ok: true });
  }

  if (rota === 'senha') {
    const eu = await usuarioDaSessao(DB, request);
    if (!eu) return json({ error: 'Faça login para continuar.', login: true }, 401);
    const nova = String(b.nova || '');
    if (nova.length < 4) return json({ error: 'A senha precisa ter pelo menos 4 caracteres.' }, 400);
    const alvoId = b.usuario_id || eu.id;
    if (alvoId !== eu.id && eu.papel !== 'admin') return json({ error: 'Só o administrador define a senha de outra pessoa.' }, 403);
    const alvo = await DB.prepare('SELECT * FROM usuarios WHERE id=?').bind(alvoId).first();
    if (!alvo) return json({ error: 'Usuário não encontrado.' }, 404);
    if (alvoId === eu.id && !(await conferirSenha(alvo, b.atual || '')).ok) return json({ error: 'Senha atual incorreta.' }, 403);
    const h = await hashNovo(nova);
    await DB.prepare("UPDATE usuarios SET senha_hash=?, salt=?, reset='', atualizado=? WHERE id=?").bind(h.senha_hash, h.salt, Date.now(), alvoId).run();
    // Quem trocou a própria senha continua logado (sessão nova); as outras sessões caem.
    const extra = alvoId === eu.id ? { 'Set-Cookie': cookieSessao(await criarSessao(DB, { id: eu.id, senha_hash: h.senha_hash })) } : {};
    return json({ ok: true }, 200, extra);
  }

  return json({ error: 'rota não encontrada' }, 404);
}
