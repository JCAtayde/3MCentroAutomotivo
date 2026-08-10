/* ============================================================
   3M Centro Automotivo — Popup de pré-cadastro (captação)
   Adicione ao site com:  <script defer src="/captacao.js"></script>
   Grava em /api/lead (mesmo banco do gestão). Placa obrigatória.
   ============================================================ */
(function(){
  "use strict";
  var VISTO = 'pc3m_visto';         // snooze ao fechar
  var FEITO = 'pc3m_feito';         // cadastrou (não mostra mais)
  var SNOOZE_DIAS = 7;

  try {
    if (localStorage.getItem(FEITO)) return;
    var v = parseInt(localStorage.getItem(VISTO) || '0');
    if (v && (Date.now() - v) < SNOOZE_DIAS*864e5) return;
  } catch(e){}

  var CSS = ''
   + '.pc3m-back{position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;padding:16px;'
   + 'background:rgba(6,7,9,.72);backdrop-filter:blur(3px);animation:pc3mfade .25s ease}'
   + '@keyframes pc3mfade{from{opacity:0}to{opacity:1}}'
   + '.pc3m-card{position:relative;width:100%;max-width:460px;max-height:92vh;overflow:auto;background:#14171c;color:#EEF1F5;'
   + 'border:1px solid #2a2f38;border-radius:18px;padding:24px 22px;box-shadow:0 30px 80px rgba(0,0,0,.6);'
   + 'font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;animation:pc3mup .3s ease}'
   + '@keyframes pc3mup{from{transform:translateY(14px);opacity:0}to{transform:none;opacity:1}}'
   + '.pc3m-x{position:absolute;top:12px;right:14px;background:none;border:0;color:#9AA3AF;font-size:26px;line-height:1;cursor:pointer}'
   + '.pc3m-logo{width:50px;height:50px;border:2px solid #E8B23A;border-radius:12px;display:grid;place-items:center;'
   + 'font-weight:800;font-size:22px;color:#E8B23A;font-family:Arial Black,Arial;margin-bottom:12px}'
   + '.pc3m-h{font-size:21px;font-weight:800;line-height:1.22;margin-bottom:6px}'
   + '.pc3m-h b{color:#E8B23A}'
   + '.pc3m-sub{color:#9AA3AF;font-size:14px;margin-bottom:16px}'
   + '.pc3m-f{margin-bottom:11px}'
   + '.pc3m-f label{display:block;font-size:12.5px;color:#c4cbd4;margin-bottom:4px;font-weight:600}'
   + '.pc3m-f input,.pc3m-f select{width:100%;background:#0f1216;border:1px solid #2a2f38;border-radius:10px;'
   + 'padding:11px 12px;color:#EEF1F5;font-size:15px;outline:none}'
   + '.pc3m-f input:focus,.pc3m-f select:focus{border-color:#E8B23A}'
   + '.pc3m-row{display:grid;grid-template-columns:1fr 1fr;gap:10px}'
   + '.pc3m-car{border:1px solid #2a2f38;border-radius:12px;padding:12px;margin-bottom:10px;background:#0f1216}'
   + '.pc3m-car .cap{font-size:12px;font-weight:700;color:#E8B23A;text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px}'
   + '.pc3m-req{color:#E5675C}'
   + '.pc3m-btn{width:100%;border:0;border-radius:11px;padding:14px;font-size:15.5px;font-weight:800;cursor:pointer;'
   + 'background:#E8B23A;color:#14161A;margin-top:6px}'
   + '.pc3m-btn:disabled{opacity:.6;cursor:default}'
   + '.pc3m-msg{min-height:18px;font-size:13px;color:#E5675C;text-align:center;margin:8px 0 2px}'
   + '.pc3m-ok{text-align:center;padding:8px 0}'
   + '.pc3m-ok .big{font-size:44px;margin-bottom:8px}'
   + '.pc3m-hp{position:absolute;left:-9999px;opacity:0}';

  function el(tag, attrs, html){ var e=document.createElement(tag); if(attrs) for(var k in attrs) e.setAttribute(k, attrs[k]); if(html!=null) e.innerHTML=html; return e; }

  function montar(){
    var style = el('style'); style.textContent = CSS; document.head.appendChild(style);
    var back = el('div', {class:'pc3m-back'});
    var card = el('div', {class:'pc3m-card'});
    back.appendChild(card);

    function fechar(){ try{ localStorage.setItem(VISTO, String(Date.now())); }catch(e){} back.remove(); }

    function tela(){
      card.innerHTML='';
      card.appendChild(el('button',{class:'pc3m-x','aria-label':'Fechar'},'&times;')).onclick=fechar;
      card.appendChild(el('div',{class:'pc3m-logo'},'3M'));
      card.appendChild(el('div',{class:'pc3m-h'},'Quer ter seu carro sempre <b>bem cuidado</b>?'));
      card.appendChild(el('div',{class:'pc3m-sub'},'Faça seu cadastro rápido e se surpreenda com o cuidado da 3M Centro Automotivo. É só preencher abaixo. 🔧'));

      var form = el('form');
      form.innerHTML =
        '<div class="pc3m-f"><label>Seu nome <span class="pc3m-req">*</span></label><input name="nome" placeholder="Nome completo" autocomplete="name"></div>'+
        '<div class="pc3m-f"><label>WhatsApp (com DDD) <span class="pc3m-req">*</span></label><input name="telefone" inputmode="tel" placeholder="62 99999-8888" autocomplete="tel"></div>'+
        '<div class="pc3m-car">'+
          '<div class="cap">Seu veículo</div>'+
          '<div class="pc3m-f"><label>Modelo do veículo</label><input name="modelo" placeholder="Ex: Onix, HB20, Corolla"></div>'+
          '<div class="pc3m-row">'+
            '<div class="pc3m-f"><label>Ano</label><input name="ano" inputmode="numeric" placeholder="2018"></div>'+
            '<div class="pc3m-f"><label>Câmbio</label><select name="cambio"><option value="">Selecione</option><option value="Manual">Manual</option><option value="Automático">Automático</option></select></div>'+
          '</div>'+
        '</div>'+
        '<input class="pc3m-hp" name="website" tabindex="-1" autocomplete="off">'+
        '<div class="pc3m-msg" id="pc3m-msg"></div>'+
        '<button type="submit" class="pc3m-btn">Quero cuidar do meu carro</button>';
      card.appendChild(form);

      form.onsubmit = function(ev){
        ev.preventDefault();
        var msg = form.querySelector('#pc3m-msg'); msg.textContent='';
        var nome = form.nome.value.trim();
        var telefone = form.telefone.value.trim();
        if(!nome){ msg.textContent='Por favor, informe seu nome.'; return; }
        if(telefone.replace(/\D/g,'').length < 10){ msg.textContent='Informe um WhatsApp válido com DDD.'; return; }
        var carro = { modelo:form.modelo.value.trim(), ano:form.ano.value.trim(), cambio:form.cambio.value };

        var btn = form.querySelector('.pc3m-btn'); btn.disabled=true; btn.textContent='Enviando…';
        fetch('/api/lead', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ nome:nome, telefone:telefone, website:form.website.value, carros:[carro] }) })
          .then(function(r){ return r.json().then(function(d){ return {ok:r.ok, d:d}; }); })
          .then(function(res){
            if(!res.ok || res.d.error){ throw new Error(res.d.error||'Falha ao enviar'); }
            try{ localStorage.setItem(FEITO,'1'); }catch(e){}
            sucesso(nome);
          })
          .catch(function(err){ btn.disabled=false; btn.textContent='Quero cuidar do meu carro'; msg.textContent = err.message || 'Não foi possível enviar. Tente de novo.'; });
      };
    }

    function sucesso(nome){
      card.innerHTML='';
      card.appendChild(el('button',{class:'pc3m-x'},'&times;')).onclick=fechar;
      card.appendChild(el('div',{class:'pc3m-ok'},
        '<div class="big">✅</div>'+
        '<div class="pc3m-h" style="text-align:center">Cadastro recebido!</div>'+
        '<div class="pc3m-sub" style="text-align:center">Obrigado, '+nome.split(' ')[0].replace(/[<>]/g,'')+'! Em breve a 3M entra em contato para cuidar do seu veículo. 🔧</div>'+
        '<button class="pc3m-btn" style="max-width:200px;margin:6px auto 0">Fechar</button>'));
      card.querySelector('.pc3m-ok .pc3m-btn').onclick=fechar;
    }

    tela();
    document.body.appendChild(back);
  }

  function start(){ setTimeout(montar, 900); }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
