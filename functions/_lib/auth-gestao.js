/**
 * Login da gestão no servidor (sessão em cookie assinado).
 *
 * A API do /gestao respondia a qualquer um: o login era só no navegador. Agora o
 * servidor confere usuário e senha, dá um cookie HttpOnly assinado (HMAC) e o
 * _middleware.js recusa toda chamada sem sessão válida.
 *
 * Senha: PBKDF2-SHA256 (100 mil rodadas), guardada como "pbkdf2$<hex>" em
 * usuarios.senha_hash. As senhas antigas (SHA-256 de "salt::senha", feitas no
 * navegador) continuam valendo e são convertidas no primeiro login.
 * A sessão carrega um pedaço do hash da senha: trocar a senha derruba as sessões antigas.
 *
 * Este arquivo não exporta onRequest, então não vira rota.
 */

const DIAS_SESSAO = 30;
const LIMITE_FALHAS = 8;            // por login e por IP…
const JANELA_FALHAS = 15 * 60 * 1000; // …em 15 minutos

const hex = (buf) => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const deHex = (h) => { const a = new Uint8Array(h.length / 2); for (let i = 0; i < a.length; i++) a[i] = parseInt(h.substr(i * 2, 2), 16); return a; };
export const aleatorio = (n) => { const a = new Uint8Array(n); crypto.getRandomValues(a); return hex(a.buffer); };
const b64url = (s) => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const deB64url = (s) => decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/'))));

export function iguais(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function sha256hex(s) { return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))); }
// Rodadas do PBKDF2 ficam gravadas no próprio hash ("pbkdf2$<rodadas>$<hex>"): dá para
// mudar o valor (ex.: limite de CPU do plano Cloudflare) sem invalidar as senhas já gravadas.
const RODADAS = 100000;
async function pbkdf2(senha, saltHex, rodadas = RODADAS) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(senha), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: deHex(saltHex), iterations: rodadas, hash: 'SHA-256' }, k, 256));
}
async function hmac(msg, segredoHex) {
  const k = await crypto.subtle.importKey('raw', deHex(segredoHex), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(msg)));
}

export async function garantirTabelasAuth(DB) {
  await DB.batch([
    DB.prepare('CREATE TABLE IF NOT EXISTS auth_gestao (chave TEXT PRIMARY KEY, valor TEXT)'),
    DB.prepare('CREATE TABLE IF NOT EXISTS auth_tentativas (chave TEXT PRIMARY KEY, falhas INTEGER, desde INTEGER)'),
  ]);
}

async function segredo(DB) {
  const r = await DB.prepare("SELECT valor FROM auth_gestao WHERE chave='sessao'").first();
  if (r && r.valor) return r.valor;
  const s = aleatorio(32);
  await DB.prepare("INSERT OR IGNORE INTO auth_gestao (chave,valor) VALUES ('sessao',?)").bind(s).run();
  return (await DB.prepare("SELECT valor FROM auth_gestao WHERE chave='sessao'").first()).valor;
}

/** Gera o hash novo de uma senha. */
export async function hashNovo(senha) { const salt = aleatorio(16); return { salt, senha_hash: `pbkdf2$${RODADAS}$` + await pbkdf2(String(senha), salt) }; }

/** Confere a senha (formato novo ou antigo). Devolve { ok, migrar }. */
export async function conferirSenha(u, senha) {
  if (!u || !u.senha_hash || !u.salt) return { ok: false };
  const m = u.senha_hash.match(/^pbkdf2\$(\d+)\$([0-9a-f]+)$/);
  if (m) return { ok: iguais(m[2], await pbkdf2(String(senha), u.salt, Number(m[1]))) };
  return { ok: iguais(u.senha_hash, await sha256hex(u.salt + '::' + String(senha))), migrar: true };
}

const impressao = (u) => String(u.senha_hash || '').slice(-12);

export async function criarSessao(DB, u) {
  const payload = b64url(JSON.stringify({ u: u.id, e: Date.now() + DIAS_SESSAO * 864e5, f: impressao(u) }));
  return payload + '.' + await hmac(payload, await segredo(DB));
}
export const cookieSessao = (tok) => `gestao_sessao=${tok}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${DIAS_SESSAO * 86400}`;
export const cookieSair = () => 'gestao_sessao=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0';

/** Usuário ativo da sessão do pedido, ou null. */
export async function usuarioDaSessao(DB, request) {
  const c = (request.headers.get('Cookie') || '').match(/(?:^|;\s*)gestao_sessao=([^;]+)/);
  if (!c) return null;
  const [payload, assinatura] = decodeURIComponent(c[1]).split('.');
  if (!payload || !assinatura || !iguais(assinatura, await hmac(payload, await segredo(DB)))) return null;
  let s; try { s = JSON.parse(deB64url(payload)); } catch (e) { return null; }
  if (!s || !s.u || !(s.e > Date.now())) return null;
  const u = await DB.prepare('SELECT id, nome, login, status, papel, perfil, perms, senha_hash FROM usuarios WHERE id=?').bind(s.u).first();
  if (!u || u.status !== 'ativo' || impressao(u) !== s.f) return null;
  return u;
}

/** Limite de tentativas erradas (por login e por IP). */
export async function bloqueado(DB, chaves) {
  const agora = Date.now();
  for (const k of chaves) {
    const r = await DB.prepare('SELECT falhas, desde FROM auth_tentativas WHERE chave=?').bind(k).first();
    if (r && r.falhas >= LIMITE_FALHAS && agora - r.desde < JANELA_FALHAS) return true;
  }
  return false;
}
export async function registrarFalha(DB, chaves) {
  const agora = Date.now();
  await DB.batch(chaves.map(k => DB.prepare(`INSERT INTO auth_tentativas (chave,falhas,desde) VALUES (?,1,?)
    ON CONFLICT(chave) DO UPDATE SET falhas=CASE WHEN ?-auth_tentativas.desde>? THEN 1 ELSE auth_tentativas.falhas+1 END,
      desde=CASE WHEN ?-auth_tentativas.desde>? THEN ? ELSE auth_tentativas.desde END`).bind(k, agora, agora, JANELA_FALHAS, agora, JANELA_FALHAS, agora)));
}
export async function limparFalhas(DB, chaves) { await DB.batch(chaves.map(k => DB.prepare('DELETE FROM auth_tentativas WHERE chave=?').bind(k))); }

export const usuarioPublico = (u) => ({ id: u.id, nome: u.nome, login: u.login, status: u.status, papel: u.papel, perfil: u.perfil || null });
