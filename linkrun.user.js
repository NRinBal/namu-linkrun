// ==UserScript==
// @name         나무 링크런 기록기
// @namespace    https://claude.ai/linkrun
// @version      1.3.1
// @description  나무 링크런 라운드 동안 나무위키에서 이동한 문서를 자동으로 기록하고, 끝나면 결과 코드를 만들어요.
// @match        https://namu.wiki/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_setClipboard
// @run-at       document-idle
// @noframes
// ==/UserScript==

// 이 파일은 북마크 버전으로도 쓰여요. 게임 페이지가 GM_* 함수를 localStorage로 흉내 내는
// 감싸개를 붙이고 __LINKRUN_BM 을 정의해서 북마크 코드로 만들어요.
(function () {
  'use strict';

  const BM = typeof __LINKRUN_BM !== 'undefined';
  const mark = document.documentElement.dataset.linkrun;
  if (mark) {
    if (BM && mark === 'bm' && window.__linkrunShow) window.__linkrunShow();
    else if (BM) alert('링크런: Tampermonkey 스크립트가 이미 기록 중이에요. 북마크는 누르지 않아도 돼요.');
    return;
  }
  if (BM && !/linkrun=/.test(location.hash) && !GM_getValue('linkrun.run', null)) {
    alert('링크런: 진행 중인 라운드가 없어요. 게임 페이지에서 ‘참가하고 시작 문서 열기’로 연 나무위키 탭에서 눌러 주세요.');
    return;
  }
  document.documentElement.dataset.linkrun = BM ? 'bm' : 'tm';

  const RUN = 'linkrun.run';       // 진행 중인 라운드 기록
  const PEND = 'linkrun.pending';  // 방금 누른 링크 (다음 문서 도착 때 확인)

  /* ---------- 공통 도구 ---------- */
  const norm = s => (s || '').normalize('NFC').replace(/_/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  const enc = new TextEncoder(), dec = new TextDecoder();
  function b64e(str) {
    const b = enc.encode(str); let s = '';
    for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function b64d(str) {
    str = str.replace(/-/g, '+').replace(/_/g, '/');
    while (str.length % 4) str += '=';
    const s = atob(str), b = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
    return dec.decode(b);
  }
  function fnv(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(16).padStart(8, '0');
  }
  function fmt(ms) {
    if (ms == null || ms < 0) ms = 0;
    const m = Math.floor(ms / 60000), s = Math.floor(ms / 1000) % 60, d = Math.floor(ms / 100) % 10;
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0') + '.' + d;
  }
  function titleOf(href) {
    try {
      const u = new URL(href, location.href);
      if (u.hostname !== 'namu.wiki') return null;
      const m = u.pathname.match(/^\/w\/(.+)$/);
      if (!m) return null;
      return decodeURIComponent(m[1]).replace(/_/g, ' ').trim();
    } catch (e) { return null; }
  }
  const load = () => GM_getValue(RUN, null);
  const save = run => GM_setValue(RUN, run);

  function makeCode(run) {
    const body = b64e(JSON.stringify({ v: 1, r: run.r, p: run.p, s: run.s, t: run.t, a: run.a, f: run.f, g: run.g, x: !!run.x, path: run.path }));
    return 'LR1.' + body + '.' + fnv(body);
  }

  /* ---------- 1. 링크런 페이지에서 넘어온 시작 정보 ---------- */
  const hm = location.hash.match(/linkrun=([A-Za-z0-9_-]+)/);
  if (hm) {
    try {
      const d = JSON.parse(b64d(hm[1]));
      const cur = load();
      const same = cur && cur.r === d.r && cur.p === d.p && cur.a === d.a;
      // b: 금지 문서 제목들, bp: 금지 규칙 이름들(예: date), bm: 'warn'(경고만) | 'dq'(밟으면 실격)
      if (!same) save({ r: d.r, p: d.p, s: d.s, t: d.t, a: d.a, path: [], f: null, g: false,
        b: Array.isArray(d.b) ? d.b : [], bp: Array.isArray(d.bp) ? d.bp : [], bm: d.bm === 'dq' ? 'dq' : 'warn' });
    } catch (e) { console.warn('[링크런] 시작 정보를 읽지 못했어요', e); }
    history.replaceState(history.state, '', location.pathname + location.search);
  }

  /* ---------- 1-1. 넘겨주기(리다이렉트) 확인 ---------- */
  // 목표가 '세종대왕'이면 실제 문서는 '세종(조선)'. 본문 링크가 '세종(조선)'을 바로 가리키면
  // 주소에 ?from= 이 안 붙어서, 라운드 시작 때 숨은 창으로 목표 문서를 한 번 열어 실제 제목을 알아둬요.
  function resolveTitle(title) {
    return new Promise(res => {
      const f = document.createElement('iframe');
      f.style.cssText = 'position:fixed;width:1px;height:1px;left:-9999px;top:0;opacity:0;pointer-events:none;border:0';
      f.setAttribute('aria-hidden', 'true'); f.tabIndex = -1;
      f.src = '/w/' + title.split('/').map(encodeURIComponent).join('/');
      const started = Date.now();
      const iv = setInterval(() => {
        let out;
        try {
          const u = new URL(f.contentWindow.location.href);
          if (f.contentDocument.querySelector('h1') && u.pathname.startsWith('/w/')) out = decodeURIComponent(u.pathname.slice(3)).replace(/_/g, ' ').trim();
        } catch (e) { /* 아직 로딩 중 */ }
        if (out || Date.now() - started > 15000) { clearInterval(iv); f.remove(); res(out || null); }
      }, 200);
      document.body.appendChild(f);
    });
  }
  /* ---------- 1-2. 금지 문서 ---------- */
  // 게임 페이지(linkrun.html)의 BAN_PATTERNS와 같아야 해요.
  const BAN_PATTERNS = {
    date: [/^(기원전 )?\d{1,4}년$/, /^\d{1,4}년대$/, /^(기원전 )?\d{1,2}세기$/, /^\d{1,2}월 \d{1,2}일$/, /^\d{1,2}월$/]
  };
  let banKey = '', banSet = new Set(), banRes = [];
  function banRules(run) {
    const key = run ? run.r + ':' + run.a : '';
    if (key !== banKey) {
      banKey = key;
      banSet = new Set(((run && run.b) || []).map(norm));
      banRes = ((run && run.bp) || []).flatMap(k => BAN_PATTERNS[k] || []);
    }
    return banSet.size || banRes.length;
  }
  function isBanned(run, t, from) {
    if (!run || !banRules(run) || isGoal(run, t, from) || norm(t) === norm(run.s) || (run.sr && norm(t) === norm(run.sr))) return false;
    const hit = x => !!x && (banSet.has(norm(x)) || banRes.some(re => re.test(x.trim())));
    return hit(t) || hit(from);
  }
  const isGoal = (run, t, from) => norm(t) === norm(run.t) || (run.tr && norm(t) === norm(run.tr)) || (!!from && norm(from) === norm(run.t));
  function resolveTarget() {
    const run = load();
    if (!run || run.tr !== undefined || run.f != null || run.g || run.x) return;
    resolveTitle(run.t).then(real => {
      const cur = load();
      if (!cur || cur.r !== run.r || cur.a !== run.a) return;
      cur.tr = real && norm(real) !== norm(cur.t) ? real : null;
      // 확인이 끝나기 전에 이미 실제 문서에 도착해 있었다면 그때 완주로 쳐요.
      const hit = cur.f == null && !cur.g && !cur.x && cur.tr ? cur.path.find(x => norm(x[0]) === norm(cur.tr)) : null;
      if (hit) { cur.path = cur.path.slice(0, cur.path.indexOf(hit) + 1); cur.f = hit[1]; }
      save(cur); render(true);
      if (hit) copyCode('완주! 결과 코드를 복사했어요. 링크런 페이지에 붙여넣으세요.');
    });
  }

  /* ---------- 2. 어떤 링크를 눌렀는지 ---------- */
  // 본문 = 문서 제목(h1)과 분류 링크를 함께 감싸는 가장 작은 영역.
  // 오른쪽 '최근 변경', 검색창, 각주 팝업 같은 곳은 여기 밖이에요.
  function contentRoot() {
    const h1 = document.querySelector('h1');
    if (!h1) return null;
    const cat = document.querySelector('a[href^="/w/%EB%B6%84%EB%A5%98:"], a[href^="/w/분류:"]');
    if (cat) { let e = h1; while (e && !e.contains(cat)) e = e.parentElement; if (e) return e; }
    let e = h1;
    for (let i = 0; i < 3 && e.parentElement; i++) e = e.parentElement;
    return e;
  }
  function onClick(ev) {
    const a = ev.target && ev.target.closest ? ev.target.closest('a[href]') : null;
    if (!a) return;
    const t = titleOf(a.href);
    if (!t) return;
    const root = contentRoot();
    GM_setValue(PEND, { t, at: Date.now(), how: root && root.contains(a) ? 'l' : 'o' });
  }
  document.addEventListener('click', onClick, true);
  document.addEventListener('auxclick', onClick, true);

  let lastPop = 0;
  window.addEventListener('popstate', () => { lastPop = Date.now(); });
  function navType() { try { return performance.getEntriesByType('navigation')[0].type; } catch (e) { return ''; } }

  /* ---------- 3. 문서 도착 기록 ---------- */
  // how: l = 본문 링크, o = 본문 밖 링크, b = 뒤로/앞으로, j = 검색·주소창 등 링크 없이 이동
  let lastUrl = null, first = true;
  function check() {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    const isFirst = first; first = false;
    const run = load();
    if (!run || run.f != null || run.g || run.x) { render(true); return; }
    const t = titleOf(location.href);
    if (!t) { render(true); return; }
    const from0 = new URL(location.href).searchParams.get('from');
    // 시작 문서가 넘겨주기라면(예: '한국' → '대한민국?from=한국') 실제 제목을 시작 문서로 기억해요.
    if (!run.path.length && run.sr === undefined && from0 && norm(from0) === norm(run.s)) { run.sr = t; save(run); }
    const last = run.path.length ? run.path[run.path.length - 1][0] : (run.sr || run.s);
    if (norm(t) === norm(last) || (!run.path.length && norm(t) === norm(run.s))) { GM_setValue(PEND, null); render(true); return; }

    // 페이지를 새로 불러온 직후라면(북마크를 나중에 눌렀을 수 있음) 도착 시각 = 페이지를 불러온 시각
    let now = Date.now();
    if (isFirst) {
      try {
        const nav = performance.getEntriesByType('navigation')[0];
        if (nav && nav.name.split('#')[0] === location.href.split('#')[0]) now = Math.round(performance.timeOrigin);
      } catch (e) { /* 그대로 현재 시각 사용 */ }
    }
    const from = new URL(location.href).searchParams.get('from');
    const pend = GM_getValue(PEND, null);
    let how = 'j';
    if (pend && now - pend.at < 10000 && (norm(pend.t) === norm(t) || (from && norm(pend.t) === norm(from)))) how = pend.how;
    else if (now - lastPop < 2000 || (isFirst && navType() === 'back_forward')) how = 'b';
    GM_setValue(PEND, null);

    const ms = now - run.a;
    const banned = isBanned(run, t, from);
    run.path.push([t, ms, banned ? 'x' : how]);
    if (banned && run.bm === 'dq') run.x = true;
    else if (isGoal(run, t, from)) run.f = ms;
    save(run);
    render(true);
    if (run.x) copyCode('금지 문서 ‘' + t + '’에 들어가서 실격이에요. 결과 코드를 복사했어요.');
    else if (banned) flash('금지 문서 ‘' + t + '’예요! 경고가 붙어요.');
    if (run.f != null) copyCode('완주! 결과 코드를 복사했어요. 링크런 페이지에 붙여넣으세요.');
  }
  setInterval(check, 250);

  /* ---------- 3-1. 금지 문서로 가는 링크에 취소선 ---------- */
  const banStyle = document.createElement('style');
  banStyle.textContent = 'a[data-lr-ban="1"]{text-decoration:line-through 2px #d0342c !important;color:#c0392b !important;opacity:.7}';
  document.head.appendChild(banStyle);
  const banCache = new Map();
  function markLinks() {
    const run = load();
    const on = run && run.f == null && !run.g && !run.x && banRules(run);
    for (const a of document.querySelectorAll('a[href^="/w/"]')) {
      let b = false;
      if (on) {
        const href = a.getAttribute('href');
        if (!banCache.has(href)) banCache.set(href, isBanned(run, titleOf(a.href) || ''));
        b = banCache.get(href);
      }
      if (b && a.dataset.lrBan !== '1') { a.dataset.lrBan = '1'; a.title = '링크런 금지 문서'; }
      else if (!b && a.dataset.lrBan === '1') { delete a.dataset.lrBan; a.removeAttribute('title'); }
    }
    if (!on) banCache.clear();
  }
  setInterval(markLinks, 700);

  /* ---------- 4. 화면 구석 기록판 ---------- */
  // 게임 페이지와 같은 글꼴(Gothic A1). 문서에 한 번 불러오면 기록판(shadow DOM) 안에서도 쓰여요.
  if (!document.getElementById('linkrun-font')) {
    const lf = document.createElement('link');
    lf.id = 'linkrun-font'; lf.rel = 'stylesheet';
    lf.href = 'https://fonts.googleapis.com/css2?family=Gothic+A1:wght@500;700;800;900&display=swap';
    document.head.appendChild(lf);
  }
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;';
  const sh = host.attachShadow({ mode: 'open' });
  sh.innerHTML = `
<style>
  :host{--ink:#F1F2FA;--muted:#9097B5;--surface:#141827;--sunk:#1C2135;--edge:#3A4270;--link:#7D95FF;--visited:#B28CFF;--mark:#FFE34D;--bad:#FF6B6E;--good:#3DD39A}
  .box{width:280px;background:var(--surface);color:var(--ink);border:2px solid var(--edge);border-radius:16px;padding:14px 16px;
       font:500 13px/1.5 "Gothic A1","Apple SD Gothic Neo","Malgun Gothic",system-ui,sans-serif;box-shadow:5px 5px 0 #000;-webkit-font-smoothing:antialiased}
  .row{display:flex;align-items:center;justify-content:space-between;gap:8px}
  .brand{font-weight:900;letter-spacing:-.02em}
  .brand::first-letter{color:var(--link)}
  .timer{font-weight:900;font-size:34px;line-height:1;font-variant-numeric:tabular-nums;letter-spacing:-.04em;margin:10px 0 6px}
  .goal{color:var(--muted);font-weight:700}
  .goal b{color:#0B0D1F;background:var(--mark);padding:0 5px;border-radius:4px;font-weight:900}
  .stat{color:var(--muted);font-size:12px;font-weight:700;margin-top:4px}
  .stat.done{color:var(--good)}
  ol{list-style:none;margin:10px 0 0;padding:8px 0 0;border-top:2px solid var(--sunk);display:flex;flex-direction:column;gap:3px;max-height:124px;overflow:auto}
  li{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--visited);font-weight:700}
  .tag{font-size:10.5px;border-radius:4px;padding:0 5px;margin-left:5px;background:var(--sunk);color:var(--ink);font-weight:800}
  .tag.bad{background:var(--bad);color:#fff}
  .btns{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px}
  button{font:inherit;font-size:12px;font-weight:800;border:2px solid var(--edge);background:var(--sunk);color:var(--ink);border-radius:8px;padding:4px 10px;cursor:pointer;box-shadow:2px 2px 0 #000}
  button:active{transform:translate(2px,2px);box-shadow:none}
  button.primary{background:var(--link);color:#0B0D18}
  button.armed{background:var(--bad);color:#fff}
  #fold{box-shadow:none;border-color:transparent;background:transparent;color:var(--muted);padding:2px 6px}
  .msg{margin-top:10px;font-size:12px;color:var(--mark);font-weight:700}
  .mini{cursor:pointer;background:var(--surface);color:var(--ink);border:2px solid var(--edge);border-radius:999px;padding:7px 14px;font:900 14px "Gothic A1","Malgun Gothic",system-ui,sans-serif;font-variant-numeric:tabular-nums;box-shadow:3px 3px 0 #000}
  textarea{width:100%;height:56px;margin-top:8px;font:11px ui-monospace,Consolas,monospace;background:#0B0D18;color:var(--ink);border:2px solid var(--edge);border-radius:8px;resize:none}
  [hidden]{display:none!important}
</style>
<button class="mini" id="mini" hidden></button>
<div class="box" id="box">
  <div class="row"><span class="brand" id="round">링크런</span><button id="fold" title="접기">접기</button></div>
  <div class="timer" id="timer">00:00.0</div>
  <div class="goal">목표 <b id="target"></b></div>
  <div class="stat" id="stat"></div>
  <ol id="path"></ol>
  <div class="btns">
    <button class="primary" id="copy" hidden>결과 코드 복사</button>
    <button id="giveup">포기</button>
    <button id="clear" hidden>기록 지우기</button>
  </div>
  <div class="msg" id="msg" hidden></div>
  <textarea id="code" readonly hidden></textarea>
</div>`;
  const $ = id => sh.getElementById(id);
  let folded = false, armed = null, armTimer = null, msgTimer = null, lastLen = -1, lastState = '';

  function flash(text) {
    const m = $('msg'); m.textContent = text; m.hidden = false;
    clearTimeout(msgTimer); msgTimer = setTimeout(() => { m.hidden = true; }, 5000);
  }
  function copyCode(okText) {
    const run = load(); if (!run) return;
    const code = makeCode(run);
    const fail = () => { $('code').value = code; $('code').hidden = false; $('code').select(); flash('자동 복사가 막혔어요. 아래 칸의 코드를 Ctrl+C로 복사하세요.'); };
    try { Promise.resolve(GM_setClipboard(code, 'text')).then(() => flash(okText), fail); } catch (e) { fail(); }
  }
  function arm(name, fn) {
    if (armed === name) { armed = null; clearTimeout(armTimer); fn(); render(true); return; }
    armed = name; render(true);
    clearTimeout(armTimer); armTimer = setTimeout(() => { armed = null; render(true); }, 3000);
  }
  $('fold').onclick = () => { folded = true; render(true); };
  $('mini').onclick = () => { folded = false; render(true); };
  $('copy').onclick = () => copyCode('결과 코드를 복사했어요. 링크런 페이지의 입력칸에 붙여넣으세요.');
  $('giveup').onclick = () => arm('giveup', () => {
    const run = load(); if (!run || run.f != null || run.x) return;
    run.g = true; save(run); copyCode('포기했어요. 결과 코드를 복사했어요.');
  });
  window.__linkrunShow = () => { folded = false; render(true); flash('기록 중이에요. 다시 누르지 않아도 돼요.'); };
  $('clear').onclick = () => arm('clear', () => { GM_setValue(RUN, null); });

  const TAG = { o: ['본문 밖', true], b: ['뒤로', false], j: ['링크 없이 이동', true], x: ['금지 문서', true] };
  function render(full) {
    const run = load();
    if (!run) { host.remove(); return; }
    if (!host.isConnected) document.body.appendChild(host);
    $('box').hidden = folded; $('mini').hidden = !folded;

    const now = Date.now();
    const state = run.f != null ? 'done' : run.x ? 'dq' : run.g ? 'out' : 'run';
    const timerText = state === 'done' ? fmt(run.f) : state === 'dq' ? '실격' : state === 'out' ? '포기' : now < run.a ? '곧 시작' : fmt(now - run.a);
    $('timer').textContent = timerText;
    $('mini').textContent = '링크런 ' + timerText;
    if (!full && run.path.length === lastLen && state === lastState) return;
    lastLen = run.path.length; lastState = state;

    $('round').textContent = '링크런 ' + run.r + 'R';
    $('target').textContent = run.t + (run.tr ? ' (= ' + run.tr + ')' : run.tr === undefined && state === 'run' ? ' · 넘겨주기 확인 중' : '');
    const warn = run.path.filter(x => x[2] === 'o' || x[2] === 'j' || x[2] === 'x').length;
    const nBan = ((run.b || []).length) + ((run.bp || []).includes('date') ? ' + 연도·날짜' : '');
    $('stat').textContent = run.path.length + '클릭' + (warn ? ' · 경고 ' + warn : '') + (state === 'done' ? ' · 완주' : state === 'dq' ? ' · 실격' : '')
      + (banRules(run) ? ' · 금지 ' + nBan + (run.bm === 'dq' ? '(밟으면 실격)' : '') : '');
    $('stat').className = state === 'done' ? 'stat done' : 'stat';

    const ol = $('path'); ol.replaceChildren();
    const items = [[run.s, 0, 's'], ...run.path];
    for (const [t, ms, how] of items.slice(-6)) {
      const li = document.createElement('li');
      li.textContent = (how === 's' ? '출발 ' : fmt(ms) + ' ') + t;
      if (TAG[how]) { const s = document.createElement('span'); s.className = 'tag' + (TAG[how][1] ? ' bad' : ''); s.textContent = TAG[how][0]; li.appendChild(s); }
      ol.appendChild(li);
    }
    ol.scrollTop = ol.scrollHeight;

    $('copy').hidden = state === 'run';
    $('giveup').hidden = state !== 'run';
    $('clear').hidden = state === 'run';
    $('giveup').textContent = armed === 'giveup' ? '한 번 더 누르면 포기' : '포기';
    $('giveup').className = armed === 'giveup' ? 'armed' : '';
    $('clear').textContent = armed === 'clear' ? '한 번 더 누르면 지워요' : '기록 지우기';
    $('clear').className = armed === 'clear' ? 'armed' : '';
  }
  setInterval(() => render(false), 200);
  check();
  render(true);
  resolveTarget();
})();
