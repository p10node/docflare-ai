/*! DocFlare AI widget v0.1.0 | MIT | https://github.com/p10node/docflare-ai */
(function () {
  'use strict';
  var s = document.currentScript;
  if (!s || window.__docflare) return;
  window.__docflare = 1;
  var d = s.dataset, siteId = d.siteId;
  if (!siteId) { console.error('[DocFlare] data-site-id is required'); return; }
  var api = (d.api || new URL(s.src, location.href).origin).replace(/\/$/, '');
  var cfg = {
    title: d.title || 'Ask AI',
    ph: d.placeholder || 'Ask a question about these docs…',
    hi: d.welcome || 'Hi! Ask me anything about this documentation.',
    accent: d.color || '#f6821f',
    pos: d.position === 'left' ? 'left' : 'right',
    theme: d.theme || 'auto'
  };

  var CSS = ':host{all:initial;--a:' + cfg.accent + ';--bg:#fff;--fg:#1a1a1a;--mu:#6b7280;--bd:#e5e7eb;--ub:var(--a);--uf:#fff;--bb:#f3f4f6;--sh:0 12px 40px rgba(0,0,0,.18);font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:var(--fg);position:fixed;z-index:2147483000;bottom:20px;' + cfg.pos + ':20px}' +
  ':host([data-theme=dark]){--bg:#111827;--fg:#f3f4f6;--mu:#9ca3af;--bd:#374151;--bb:#1f2937;--sh:0 12px 40px rgba(0,0,0,.5)}' +
  '*{box-sizing:border-box}button{font:inherit;cursor:pointer;border:0}' +
  '.fab{width:56px;height:56px;border-radius:50%;background:var(--a);color:#fff;display:flex;align-items:center;justify-content:center;box-shadow:0 6px 20px rgba(0,0,0,.25);transition:transform .15s}.fab:hover{transform:scale(1.06)}.fab svg{width:26px;height:26px}' +
  '.p{display:none;position:absolute;bottom:68px;' + cfg.pos + ':0;width:380px;max-width:calc(100vw - 40px);height:560px;max-height:calc(100vh - 110px);background:var(--bg);border:1px solid var(--bd);border-radius:16px;box-shadow:var(--sh);flex-direction:column;overflow:hidden}.p.o{display:flex}' +
  '.h{display:flex;align-items:center;gap:8px;padding:12px 16px;border-bottom:1px solid var(--bd);font-weight:600}.h i{width:8px;height:8px;border-radius:50%;background:var(--a)}.h b{flex:1;font-weight:600}.x{background:none;color:var(--mu);font-size:22px;line-height:1;padding:2px 6px}.x:hover{color:var(--fg)}' +
  '.m{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:10px}' +
  '.b{max-width:88%;padding:9px 13px;border-radius:14px;white-space:pre-wrap;word-wrap:break-word;overflow-wrap:anywhere}.u{align-self:flex-end;background:var(--ub);color:var(--uf);border-bottom-right-radius:4px}.t{align-self:flex-start;background:var(--bb);border-bottom-left-radius:4px}' +
  '.t pre{background:rgba(0,0,0,.08);padding:8px;border-radius:8px;overflow-x:auto;margin:6px 0;font-size:12px}:host([data-theme=dark]) .t pre{background:rgba(0,0,0,.35)}.t code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px}.t a{color:var(--a)}' +
  '.c{display:inline-block;min-width:16px;padding:0 4px;margin:0 1px;border-radius:6px;background:var(--a);color:#fff!important;font-size:10px;font-weight:700;text-align:center;text-decoration:none;vertical-align:super;line-height:14px}' +
  '.sr{align-self:flex-start;max-width:88%;font-size:12px;color:var(--mu)}.sr a{display:inline-block;margin:3px 4px 0 0;padding:2px 8px;border:1px solid var(--bd);border-radius:999px;color:var(--fg);text-decoration:none;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.sr a:hover{border-color:var(--a)}' +
  '.e{color:#dc2626}.d span{display:inline-block;width:6px;height:6px;margin:0 2px;border-radius:50%;background:var(--mu);animation:k 1s infinite}.d span:nth-child(2){animation-delay:.2s}.d span:nth-child(3){animation-delay:.4s}@keyframes k{0%,80%,100%{opacity:.3}40%{opacity:1}}' +
  '.f{display:flex;gap:8px;padding:12px;border-top:1px solid var(--bd)}.f textarea{flex:1;resize:none;border:1px solid var(--bd);border-radius:10px;padding:9px 12px;font:inherit;color:var(--fg);background:var(--bg);outline:none;max-height:120px}.f textarea:focus{border-color:var(--a)}.f button{width:40px;border-radius:10px;background:var(--a);color:#fff}.f button:disabled{opacity:.5;cursor:default}' +
  '.w{text-align:center;font-size:11px;color:var(--mu);padding:0 0 8px}.w a{color:inherit}' +
  '@media(max-width:480px){.p{width:calc(100vw - 40px)}}';

  var ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5z"/></svg>';

  var host = document.createElement('div');
  host.id = 'docflare-ai';
  var root = host.attachShadow({ mode: 'open' });
  root.innerHTML = '<style>' + CSS + '</style>' +
    '<button class="fab" aria-label="Open ' + esc(cfg.title) + '">' + ICON + '</button>' +
    '<div class="p" role="dialog" aria-label="' + esc(cfg.title) + '">' +
    '<div class="h"><i></i><b>' + esc(cfg.title) + '</b><button class="x" aria-label="Close">&times;</button></div>' +
    '<div class="m"></div>' +
    '<form class="f"><textarea rows="1" placeholder="' + esc(cfg.ph) + '" aria-label="Question"></textarea><button type="submit" aria-label="Send">&#10148;</button></form>' +
    '<div class="w">Powered by <a href="https://github.com/p10node/docflare-ai" target="_blank" rel="noopener">DocFlare AI</a></div></div>';

  var $ = function (q) { return root.querySelector(q); };
  var fab = $('.fab'), panel = $('.p'), msgs = $('.m'), form = $('.f'), ta = $('textarea'), send = $('.f button');
  var hist = [], busy = false;

  function applyTheme() {
    var t = cfg.theme;
    if (t === 'auto') t = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    host.setAttribute('data-theme', t);
  }
  applyTheme();
  if (cfg.theme === 'auto' && matchMedia) matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

  function esc(x) { return String(x).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  // Minimal Markdown: fenced code, inline code, bold, bullets, [n] citations.
  function md(t, src) {
    var blocks = [];
    var h = esc(t).replace(/\n*```\w*\n?([\s\S]*?)```\n*/g, function (_, c) { blocks.push('<pre><code>' + c.replace(/\n$/, '') + '</code></pre>'); return '\u0000' + (blocks.length - 1) + '\u0000'; });
    h = h.replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
      .replace(/^#{1,6} (.*)$/gm, '<b>$1</b>')
      .replace(/^\s*[-*] /gm, '• ')
      .replace(/\[(\d+)\](?:\[(\d+)\])*/g, function (m) {
        return m.replace(/\[(\d+)\]/g, function (_, n) { var x = src[n - 1]; return x ? '<a class="c" href="' + esc(x.url) + '" target="_blank" rel="noopener" title="' + esc(x.title) + '">' + n + '</a>' : '[' + n + ']'; });
      });
    return h.replace(/\u0000(\d+)\u0000/g, function (_, i) { return blocks[i]; });
  }

  function bubble(cls, html) {
    var el = document.createElement('div');
    el.className = 'b ' + cls;
    el.innerHTML = html;
    msgs.appendChild(el);
    msgs.scrollTop = msgs.scrollHeight;
    return el;
  }

  function showSources(src) {
    var seen = {}, html = '';
    src.forEach(function (x) { if (!seen[x.url]) { seen[x.url] = 1; html += '<a href="' + esc(x.url) + '" target="_blank" rel="noopener">' + esc(x.title || x.url) + '</a>'; } });
    if (!html) return;
    var el = document.createElement('div');
    el.className = 'sr';
    el.innerHTML = 'Sources<br>' + html;
    msgs.appendChild(el);
    msgs.scrollTop = msgs.scrollHeight;
  }

  function setBusy(v) { busy = v; send.disabled = v; }

  function ask(q) {
    hist.push({ role: 'user', content: q });
    bubble('u', esc(q));
    var bot = bubble('t d', '<span></span><span></span><span></span>');
    var text = '', src = [], sawToken = false;
    setBusy(true);

    function paint() { if (!sawToken) { sawToken = true; bot.className = 'b t'; } bot.innerHTML = md(text, src); msgs.scrollTop = msgs.scrollHeight; }
    function finish(err) {
      // Drop the unanswered question so the next request does not send two user turns in a row.
      if (err) { hist.pop(); bot.className = 'b t e'; bot.textContent = err; }
      else { if (!text) text = '(no answer)'; paint(); hist.push({ role: 'assistant', content: text }); showSources(src); }
      setBusy(false); ta.focus();
    }
    function onEvent(raw) {
      var ev = '', data = '';
      raw.split('\n').forEach(function (l) { if (l.indexOf('event:') === 0) ev = l.slice(6).trim(); else if (l.indexOf('data:') === 0) data += l.slice(5).trim(); });
      if (!data) return;
      var j; try { j = JSON.parse(data); } catch (e) { return; }
      if (ev === 'meta') src = j.sources || [];
      else if (ev === 'token') { text += j.text; paint(); }
      else if (ev === 'error') throw new Error(j.message || 'Stream error');
    }

    fetch(api + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ siteId: siteId, question: q, stream: true, history: hist.slice(-7, -1) })
    }).then(function (r) {
      if (!r.ok) return r.json().catch(function () { return {}; }).then(function (j) { throw new Error(j.error || ('Request failed (' + r.status + ')')); });
      if ((r.headers.get('content-type') || '').indexOf('text/event-stream') < 0) {
        return r.json().then(function (j) { text = j.answer || ''; src = j.sources || []; });
      }
      var rd = r.body.getReader(), dec = new TextDecoder(), buf = '';
      return (function pump() {
        return rd.read().then(function (c) {
          if (c.done) return;
          buf += dec.decode(c.value, { stream: true });
          var parts = buf.split('\n\n'); buf = parts.pop();
          parts.forEach(onEvent);
          return pump();
        });
      })();
    }).then(function () { finish(); }).catch(function (e) { finish(e.message || 'Something went wrong'); });
  }

  function toggle(open) {
    var o = typeof open === 'boolean' ? open : !panel.classList.contains('o');
    panel.classList.toggle('o', o);
    fab.setAttribute('aria-expanded', o);
    if (o) { if (!msgs.children.length) bubble('t', esc(cfg.hi)); ta.focus(); }
  }

  fab.addEventListener('click', function () { toggle(); });
  $('.x').addEventListener('click', function () { toggle(false); });
  root.addEventListener('keydown', function (e) { if (e.key === 'Escape') toggle(false); });
  ta.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event('submit', { cancelable: true })); } });
  ta.addEventListener('input', function () { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 120) + 'px'; });
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var q = ta.value.trim();
    if (!q || busy) return;
    ta.value = ''; ta.style.height = 'auto';
    ask(q);
  });

  function mount() { document.body.appendChild(host); }
  document.body ? mount() : document.addEventListener('DOMContentLoaded', mount);

  // Public API: window.DocFlare.open() / close() / ask('question')
  window.DocFlare = {
    open: function () { toggle(true); },
    close: function () { toggle(false); },
    ask: function (q) { q = String(q == null ? '' : q).trim(); toggle(true); if (q && !busy) ask(q); }
  };
})();
