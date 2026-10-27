/**
 * Agendador da 3M (Cloudflare Worker com cron, de hora em hora).
 *
 * Busca as notas de compra na SEFAZ mesmo com o sistema fechado — sem isso a busca só
 * acontecia quando alguém tocava em "Buscar na SEFAZ", e nota sem ciência em 10 dias
 * fica só no resumo. Ele não fala com a SEFAZ: chama a rota do próprio sistema
 * (/gestao/api/fiscal/sincronizar), que faz tudo (regra de 1 consulta por hora inclusa).
 *
 * Autorização: uma chave aleatória guardada no D1 (auth_gestao, chave 'cron'), que o
 * porteiro da API (functions/gestao/api/_middleware.js) confere só para essa rota.
 * O resultado fica em fiscal_config 'auto_ultima' (aparece em Notas de compra).
 */

export default {
  async scheduled(evento, env, ctx) {
    ctx.waitUntil(buscar(env));
  },
};

const hex = (a) => [...a].map((b) => b.toString(16).padStart(2, '0')).join('');

async function chave(DB) {
  await DB.prepare('CREATE TABLE IF NOT EXISTS auth_gestao (chave TEXT PRIMARY KEY, valor TEXT)').run();
  const r = await DB.prepare("SELECT valor FROM auth_gestao WHERE chave='cron'").first();
  if (r && r.valor) return r.valor;
  const nova = hex(crypto.getRandomValues(new Uint8Array(32)));
  await DB.prepare("INSERT OR IGNORE INTO auth_gestao (chave,valor) VALUES ('cron',?)").bind(nova).run();
  return (await DB.prepare("SELECT valor FROM auth_gestao WHERE chave='cron'").first()).valor;
}

async function buscar(env) {
  const tot = { resumos: 0, completas: 0, ciencias: 0, pecas_novas: 0 };
  let erro = null, rodadas = 0, status = null;
  try {
    const k = await chave(env.DB);
    // Cada chamada é uma rodada curta; repete até o sistema dizer que acabou (como o botão faz).
    for (let i = 0; i < 10; i++) {
      rodadas++;
      const r = await fetch(env.SITE + '/gestao/api/fiscal/sincronizar', { method: 'POST', headers: { 'x-cron-key': k } });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'http ' + r.status);
      for (const c of Object.keys(tot)) tot[c] += d[c] || 0;
      status = d.ultimo_status || status;
      if (d.fim) break;
    }
  } catch (e) {
    erro = String((e && e.message) || e);
  }
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS fiscal_config (chave TEXT PRIMARY KEY, valor TEXT)').run();
  await env.DB.prepare("INSERT INTO fiscal_config (chave,valor) VALUES ('auto_ultima',?) ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor")
    .bind(JSON.stringify({ quando: Date.now(), ...tot, rodadas, status, erro })).run();
}
