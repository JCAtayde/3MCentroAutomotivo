/**
 * API do sistema da oficina (Cloudflare Pages Function + D1).
 * Rota: /gestao/api/*   |   Binding do banco: DB (D1)
 * Protegida pelo Cloudflare Access (mesmo login do /gestao).
 */

const SCHEMA = {
  clientes: { cols:['id','nome','tipo','telefone1','telefone2','endereco','obs','contatos','nascimento','zap_num','lead','cpf','rua','setor','cidade','estado','cep','quadra','lote','numero','criado','atualizado'], json:['contatos'] },
  veiculos: { cols:['id','cliente_id','placa','modelo','ano','cor','km_atual','media_km_mes','entrevista','inspecao','cambio','criado','atualizado'], json:['entrevista','inspecao'] },
  ordens:   { cols:['id','veiculo_id','data','km','reclamacao','obs_mecanico','obs_admin','itens','maodeobra','status','agenda_data','agenda_hora','mecanico_id','midias','criado','atualizado'], json:['itens','maodeobra','midias'] },
  regras:   { cols:['id','nome','km','meses','ordem'], json:[] },
  mecanicos:{ cols:['id','nome','percentual','ativo','telefone','criado','atualizado'], json:[] },
  caixa:    { cols:['id','tipo','data','valor','forma','taxa','liquido','descricao','ordem_id','parcelas','criado','atualizado'], json:[] },
  usuarios: { cols:['id','nome','login','senha_hash','salt','status','papel','email','perms','reset','mecanico_id','criado','atualizado'], json:['perms'] },
  pecas:    { cols:['id','nome','preco','criado','atualizado'], json:[] },
};

const jsonResp = (o, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

function parse(v, def) { if (v == null) return def; try { return JSON.parse(v); } catch (e) { return def; } }

export async function onRequest(context) {
  const { request, env } = context;
  const DB = env.DB;
  if (!DB) return jsonResp({ error: 'Banco D1 não conectado (binding DB ausente).' }, 500);

  const url = new URL(request.url);
  const parts = url.pathname.split('/').filter(Boolean); // ['gestao','api','<acao>']
  const acao = parts[2] || '';

  try {
    if (request.method === 'GET' && acao === 'state') {
      const [cli, vei, ord, reg, cfg, usu, mec, cxa, pec] = await Promise.all([
        DB.prepare('SELECT * FROM clientes').all(),
        DB.prepare('SELECT * FROM veiculos').all(),
        DB.prepare('SELECT * FROM ordens').all(),
        DB.prepare('SELECT * FROM regras ORDER BY ordem').all(),
        DB.prepare('SELECT * FROM config').all(),
        DB.prepare('SELECT * FROM usuarios').all(),
        DB.prepare('SELECT * FROM mecanicos').all(),
        DB.prepare('SELECT * FROM caixa').all(),
        DB.prepare('SELECT * FROM pecas').all(),
      ]);
      const config = {};
      (cfg.results || []).forEach(r => { config[r.chave] = r.valor; });
      return jsonResp({
        clientes: (cli.results || []).map(r => ({ ...r, contatos: parse(r.contatos, []) })),
        veiculos: (vei.results || []).map(r => ({ ...r, entrevista: parse(r.entrevista, null), inspecao: parse(r.inspecao, {}) })),
        ordens:   (ord.results || []).map(r => ({ ...r, itens: parse(r.itens, []), maodeobra: parse(r.maodeobra, []), midias: parse(r.midias, []) })),
        regras:   (reg.results || []),
        usuarios: (usu.results || []).map(r => ({ ...r, perms: parse(r.perms, null) })),
        mecanicos:(mec.results || []),
        caixa:    (cxa.results || []),
        pecas:    (pec.results || []),
        config,
      });
    }

    if (request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      if (acao === 'upsert')  { await upsertRows(DB, body.table, body.rows || []); return jsonResp({ ok: true }); }
      if (acao === 'delete')  { await deleteRows(DB, body.table, body.ids || []);  return jsonResp({ ok: true }); }
      if (acao === 'config')  { await saveConfig(DB, body.config || {});           return jsonResp({ ok: true }); }
      if (acao === 'replace') { await replaceAll(DB, body);                          return jsonResp({ ok: true }); }
    }

    return jsonResp({ error: 'rota não encontrada' }, 404);
  } catch (e) {
    return jsonResp({ error: String((e && e.message) || e) }, 500);
  }
}

async function upsertRows(DB, table, rows) {
  const s = SCHEMA[table];
  if (!s) throw new Error('tabela inválida: ' + table);
  if (!rows.length) return;
  const placeholders = s.cols.map(() => '?').join(',');
  const updates = s.cols.filter(c => c !== 'id').map(c => `${c}=excluded.${c}`).join(',');
  const sql = `INSERT INTO ${table} (${s.cols.join(',')}) VALUES (${placeholders}) ON CONFLICT(id) DO UPDATE SET ${updates}`;
  const stmts = rows.map(row => {
    const vals = s.cols.map(c => {
      let v = row[c];
      if (s.json.includes(c)) return v === undefined ? null : JSON.stringify(v);
      return v === undefined ? null : v;
    });
    return DB.prepare(sql).bind(...vals);
  });
  await DB.batch(stmts);
}

async function deleteRows(DB, table, ids) {
  if (!SCHEMA[table]) throw new Error('tabela inválida: ' + table);
  if (!ids.length) return;
  const q = ids.map(() => '?').join(',');
  const stmts = [];
  if (table === 'clientes') {
    stmts.push(DB.prepare(`DELETE FROM ordens WHERE veiculo_id IN (SELECT id FROM veiculos WHERE cliente_id IN (${q}))`).bind(...ids));
    stmts.push(DB.prepare(`DELETE FROM veiculos WHERE cliente_id IN (${q})`).bind(...ids));
    stmts.push(DB.prepare(`DELETE FROM clientes WHERE id IN (${q})`).bind(...ids));
  } else if (table === 'veiculos') {
    stmts.push(DB.prepare(`DELETE FROM ordens WHERE veiculo_id IN (${q})`).bind(...ids));
    stmts.push(DB.prepare(`DELETE FROM veiculos WHERE id IN (${q})`).bind(...ids));
  } else {
    stmts.push(DB.prepare(`DELETE FROM ${table} WHERE id IN (${q})`).bind(...ids));
  }
  await DB.batch(stmts);
}

async function saveConfig(DB, config) {
  const entries = Object.entries(config);
  if (!entries.length) return;
  const stmts = entries.map(([k, v]) =>
    DB.prepare('INSERT INTO config (chave,valor) VALUES (?,?) ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor').bind(k, String(v)));
  await DB.batch(stmts);
}

async function replaceAll(DB, body) {
  await DB.batch([
    DB.prepare('DELETE FROM clientes'), DB.prepare('DELETE FROM veiculos'),
    DB.prepare('DELETE FROM ordens'),   DB.prepare('DELETE FROM regras'),
  ]);
  await upsertRows(DB, 'clientes', body.clientes || []);
  await upsertRows(DB, 'veiculos', body.veiculos || []);
  await upsertRows(DB, 'ordens',   body.ordens   || []);
  await upsertRows(DB, 'regras',   body.regras   || []);
  if (body.usuarios) await upsertRows(DB, 'usuarios', body.usuarios);
  if (body.mecanicos) await upsertRows(DB, 'mecanicos', body.mecanicos);
  if (body.caixa) await upsertRows(DB, 'caixa', body.caixa);
  if (body.pecas) await upsertRows(DB, 'pecas', body.pecas);
  if (body.config) await saveConfig(DB, body.config);
}
