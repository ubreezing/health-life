/* 健康生活 · 多端同步层
 * 用法：
 *   HealthSync.init({ app:'fitness', snapshot:fn, restore:fn, hasData:fn, rerender:fn })
 *   本地每次写入后调用 HealthSync.touch()
 *
 * 依赖一个 Supabase 风格的云客户端，挂在 window.CloudSDK 上：
 *   CloudSDK.create({ endpoint, publishableKey, oauthRelayBaseUrl })
 * 返回对象需要提供：
 *   auth.getSession() / auth.sendOtp() / auth.verifyOtp() / auth.signOut()
 *   database.from(t).select(cols).eq(k,v).maybeSingle() / .insert() / .update()
 * 没有这个 SDK 也能用，会退化成「仅本机」，数据只存在 localStorage。
 */
(function (global) {
  'use strict';

  /* 云端配置不写死在代码里。
   * 用之前先建一个 site/config.js（仓库里给了 config.example.js 模板）：
   *   window.HEALTH_SYNC_CONFIG = { endpoint:'https://your-app.example.com', publishableKey:'pk_xxx' };
   * 不配也能跑，只是退化成「仅本机」，数据全在 localStorage 里。 */
  var CFG = {
    endpoint: '',
    oauthRelayBaseUrl: '',
    publishableKey: '',
    sdkGlobal: 'CloudSDK'
  };

  (function applyExternalConfig() {
    var c = global.HEALTH_SYNC_CONFIG;
    if (!c || typeof c !== 'object') return;
    if (c.endpoint) CFG.endpoint = String(c.endpoint).replace(/\/+$/, '');
    if (c.publishableKey) CFG.publishableKey = String(c.publishableKey);
    if (c.oauthRelayBaseUrl) CFG.oauthRelayBaseUrl = String(c.oauthRelayBaseUrl);
    if (c.sdkGlobal) CFG.sdkGlobal = String(c.sdkGlobal);
  })();

  function isConfigured() {
    return !!(CFG.endpoint && CFG.publishableKey);
  }

  var S = {
    app: 'fitness',
    snapshot: function () { return {}; },
    restore: function () {},
    /* 可选：opts.merge(remotePayload) → 把云端内容并入本地，返回本地是否发生变化。
       有它时 pull 不再整包覆盖，避免“新设备本地为空 → 覆盖云端历史”。*/
    merge: null,
    hasData: function () { return false; },
    rerender: function () {},
    metaKey: '',
    cloud: null,
    session: null,
    status: 'local',      // local | idle | syncing | ok | error
    statusMsg: '',
    lastSync: 0,
    timer: null,
    pulling: false,
    pendingPush: false,
    inited: false
  };

  /* ---------- 基础 ---------- */
  function $(sel, root) { return (root || document).querySelector(sel); }

  /* 键顺序无关的序列化，用于判断本地与云端是否真的不同 */
  function stableStr(o) {
    if (o === null || typeof o !== 'object') return JSON.stringify(o);
    if (Array.isArray(o)) return '[' + o.map(stableStr).join(',') + ']';
    return '{' + Object.keys(o).sort().map(function (k) {
      return JSON.stringify(k) + ':' + stableStr(o[k]);
    }).join(',') + '}';
  }
  function now() { return Date.now(); }
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function hhmm(ts) {
    var d = new Date(ts);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  function getCloud() {
    if (S.cloud) return S.cloud;
    if (!isConfigured()) return null;
    var sdk = global[CFG.sdkGlobal];
    if (!sdk || typeof sdk.create !== 'function') return null;
    try {
      S.cloud = sdk.create({
        endpoint: CFG.endpoint,
        oauthRelayBaseUrl: CFG.oauthRelayBaseUrl,
        publishableKey: CFG.publishableKey
      });
    } catch (e) { S.cloud = null; }
    return S.cloud;
  }
  function readMeta() {
    try {
      var raw = localStorage.getItem(S.metaKey);
      if (raw) {
        var o = JSON.parse(raw);
        if (o && typeof o.ts === 'number') return o;
      }
    } catch (e) {}
    return { ts: 0, rev: 0 };
  }
  function writeMeta(m) {
    try { localStorage.setItem(S.metaKey, JSON.stringify(m)); } catch (e) {}
  }
  function errText(err) {
    if (!err) return '未知错误';
    var m = err.message || err.error_description || err.error || '';
    if (!m) return '请求失败';
    if (/network|fetch|Failed/i.test(m)) return '网络不通，稍后自动重试';
    return m;
  }

  /* ---------- 同步核心 ---------- */
  function markDirty() {
    var m = readMeta();
    m.ts = now();
    writeMeta(m);
  }

  async function push() {
    var c = getCloud();
    if (!c || !S.session) return false;
    var meta = readMeta();
    /* 以「本地时间与当前时间较大者」作为版本戳，避免回推后时间戳反而变旧 */
    var tsPush = Math.max(Number(meta.ts) || 0, now());
    var body = {
      app: S.app,
      payload: S.snapshot(),
      client_ts: tsPush,
      rev: (meta.rev || 0) + 1
    };
    S.status = 'syncing'; paint();
    try {
      var q = await c.database.from('sync_state').select('id').eq('app', S.app).maybeSingle();
      if (q.error) throw q.error;
      var res;
      if (q.data && q.data.id) {
        res = await c.database.from('sync_state')
          .update({ payload: body.payload, client_ts: body.client_ts, rev: body.rev, updated_at: new Date().toISOString() })
          .eq('id', q.data.id).select();
      } else {
        res = await c.database.from('sync_state').insert(body).select();
        /* 两台设备首次同时插入 → 唯一键冲突，退化为更新 */
        if (res.error && res.error.code === '23505') {
          var again = await c.database.from('sync_state').select('id').eq('app', S.app).maybeSingle();
          if (again.data && again.data.id) {
            res = await c.database.from('sync_state')
              .update({ payload: body.payload, client_ts: body.client_ts, rev: body.rev, updated_at: new Date().toISOString() })
              .eq('id', again.data.id).select();
          }
        }
      }
      if (res && res.error) throw res.error;
      writeMeta({ ts: body.client_ts, rev: body.rev });
      S.status = 'ok'; S.lastSync = now(); S.statusMsg = '';
      paint();
      return true;
    } catch (e) {
      S.status = 'error'; S.statusMsg = errText(e); paint();
      return false;
    }
  }

  async function pull(silent) {
    var c = getCloud();
    if (!c || !S.session || S.pulling) return false;
    S.pulling = true;
    if (!silent) { S.status = 'syncing'; paint(); }
    try {
      var q = await c.database.from('sync_state').select('payload, client_ts, rev').eq('app', S.app).maybeSingle();
      if (q.error) throw q.error;
      var meta = readMeta();
      if (!q.data) {
        S.pulling = false;
        if (meta.ts === 0) meta.ts = now();
        writeMeta(meta);
        await push();
        return true;
      }
      var remoteTs = Number(q.data.client_ts) || 0;
      var remotePayload = q.data.payload || {};
      S.pulling = false;

      /* 先把云端内容并入本地；页面提供 merge 时按业务规则合并，绝不整包覆盖 */
      var localChanged = false;
      if (typeof S.merge === 'function') {
        try { localChanged = !!S.merge(remotePayload); } catch (e) { localChanged = false; }
        if (localChanged) S.rerender('remote');
      } else if (remoteTs > meta.ts) {
        S.restore(remotePayload);
        localChanged = true;
        S.rerender('remote');
      }

      /* 合并后本地若仍有云端没有的内容，回推，让两边最终一致 */
      var needPush = false;
      if (typeof S.snapshot === 'function') {
        try { needPush = stableStr(S.snapshot()) !== stableStr(remotePayload); }
        catch (e) { needPush = false; }
      }
      if (needPush) { await push(); return true; }

      writeMeta({ ts: Math.max(remoteTs, meta.ts), rev: Number(q.data.rev) || 0 });
      S.status = 'ok'; S.lastSync = now(); S.statusMsg = '';
      paint();
      return true;
    } catch (e) {
      S.pulling = false;
      S.status = 'error'; S.statusMsg = errText(e); paint();
      return false;
    }
  }

  function schedulePush(delay) {
    if (!S.session) return;
    clearTimeout(S.timer);
    S.timer = setTimeout(function () { push(); }, delay === undefined ? 1200 : delay);
  }

  /* ---------- 登录态 ---------- */
  async function refreshSession() {
    var c = getCloud();
    if (!c) { S.status = 'local'; paint(); return; }
    try {
      var r = await c.auth.getSession();
      S.session = (r && r.data) ? r.data : null;
    } catch (e) { S.session = null; }
    if (S.session) {
      var meta = readMeta();
      var localHas = false;
      try { localHas = !!S.hasData(); } catch (e2) { localHas = false; }
      if (meta.ts === 0 && localHas) { meta.ts = now(); writeMeta(meta); }
      await reconcile();
    } else {
      S.status = 'local'; paint();
    }
  }

  async function reconcile() {
    var c = getCloud();
    if (!c || !S.session) return;
    var meta = readMeta();
    var localHas = false;
    try { localHas = !!S.hasData(); } catch (e) {}
    if (meta.ts === 0 && !localHas) {
      /* 全新设备：先看云端有没有 */
      var q = await c.database.from('sync_state').select('payload, client_ts, rev').eq('app', S.app).maybeSingle();
      if (!q.error && q.data) {
        S.restore(q.data.payload);
        writeMeta({ ts: Number(q.data.client_ts) || 0, rev: Number(q.data.rev) || 0 });
        S.status = 'ok'; S.lastSync = now();
        S.rerender('remote'); paint();
        return;
      }
      S.status = 'ok'; S.lastSync = now(); paint();
      return;
    }
    await pull(true);
  }

  async function doSignOut() {
    var c = getCloud();
    if (c) { try { await c.auth.signOut(); } catch (e) {} }
    S.session = null; S.status = 'local'; paint(); renderPanel();
  }

  /* ---------- UI ---------- */
  var CSS = ''
    + '.hlsync-btn{display:inline-flex;align-items:center;gap:4px;border:1px solid rgba(0,0,0,.08);background:#fff;'
    + 'color:#5F5E5A;border-radius:999px;padding:4px 9px;font-size:11px;font-weight:600;cursor:pointer;line-height:1.2;'
    + 'flex:0 0 auto;white-space:nowrap;box-shadow:0 1px 2px rgba(20,40,30,.06)}'
    + '.hlsync-btn .d{width:6px;height:6px;border-radius:50%;background:#B7B7B0;display:inline-block}'
    + '.hlsync-btn.on .d{background:#1D9E75}'
    + '.hlsync-btn.err .d{background:#E24B4A}'
    + '.hlsync-mask{position:fixed;inset:0;background:rgba(10,30,24,.45);backdrop-filter:blur(3px);z-index:300;display:none;align-items:flex-end;justify-content:center}'
    + '.hlsync-mask.show{display:flex}'
    + '.hlsync-sheet{background:#fff;color:#26261f;width:100%;max-width:520px;border-radius:22px 22px 0 0;'
    + 'padding:20px 18px calc(20px + env(safe-area-inset-bottom));max-height:88vh;overflow:auto;'
    + 'font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}'
    + '.hlsync-sheet h3{font-size:18px;font-weight:800;margin:0 0 4px}'
    + '.hlsync-sheet .st{font-size:13px;color:#5F5E5A;line-height:1.6}'
    + '.hlsync-row{display:flex;gap:8px;margin-top:14px}'
    + '.hlsync-tab{flex:1;border:1.5px solid #E5E7E0;background:#fff;color:#5F5E5A;border-radius:12px;padding:9px;font-size:14px;font-weight:700;cursor:pointer}'
    + '.hlsync-tab.on{background:#1D9E75;border-color:#1D9E75;color:#fff}'
    + '.hlsync-input{width:100%;border:1.5px solid #E5E7E0;border-radius:12px;padding:11px 12px;font-size:15px;margin-top:10px;background:#fff;color:#26261f}'
    + '.hlsync-code{display:flex;gap:8px;margin-top:10px;align-items:center}'
    + '.hlsync-code .hlsync-input{margin-top:0}'
    + '.hlsync-btn-main{width:100%;border:none;border-radius:14px;padding:13px;font-size:15px;font-weight:800;background:#1D9E75;color:#fff;margin-top:12px;cursor:pointer}'
    + '.hlsync-btn-ghost{flex:1;border:1.5px solid #E5E7E0;border-radius:12px;padding:11px;font-size:14px;font-weight:700;background:#fff;color:#5F5E5A;cursor:pointer}'
    + '.hlsync-getcode{border:1.5px solid #1D9E75;color:#0F6E56;background:#E1F5EE;border-radius:12px;padding:10px 12px;font-size:13px;font-weight:700;white-space:nowrap;cursor:pointer}'
    + '.hlsync-getcode:disabled{opacity:.5}'
    + '.hlsync-err{color:#E24B4A;font-size:12px;margin-top:8px;min-height:14px}'
    + '.hlsync-tip{font-size:11px;color:#888780;margin-top:10px;line-height:1.6}'
    + '.hlsync-x{position:absolute;top:14px;right:16px;font-size:20px;color:#888780;cursor:pointer;background:none;border:none}';

  function injectCSS() {
    if ($('#hlsync-style')) return;
    var st = document.createElement('style');
    st.id = 'hlsync-style';
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  function statusText() {
    if (!getCloud()) return '同步组件未加载（离线可用，换设备不同步）';
    if (!S.session) return '未登录 · 数据只在本机';
    if (S.status === 'syncing') return '同步中…';
    if (S.status === 'error') return '同步出错：' + (S.statusMsg || '稍后重试');
    if (S.lastSync) return '已同步 · ' + hhmm(S.lastSync);
    return '已登录';
  }

  function paint() {
    var b = $('#hlsyncBtn');
    if (!b) return;
    b.className = 'hlsync-btn' + (S.session ? (S.status === 'error' ? ' err' : ' on') : '');
    var label = !S.session ? '仅本机' : (S.status === 'syncing' ? '同步中' : (S.status === 'error' ? '同步异常' : '已同步'));
    b.innerHTML = '<span class="d"></span>' + label;
  }

  function buildPanel() {
    if ($('#hlsyncMask')) return;
    var mask = document.createElement('div');
    mask.className = 'hlsync-mask';
    mask.id = 'hlsyncMask';
    mask.innerHTML = '<div class="hlsync-sheet" id="hlsyncSheet"></div>';
    mask.addEventListener('click', function (e) { if (e.target === mask) closePanel(); });
    document.body.appendChild(mask);
  }

  function closePanel() {
    var m = $('#hlsyncMask'); if (m) m.classList.remove('show');
  }

  function renderPanel() {
    buildPanel();
    var sheet = $('#hlsyncSheet');
    var loggedIn = !!S.session;
    var user = (S.session && S.session.user) ? S.session.user : null;
    var who = '';
    if (user) who = user.phone || user.email || user.name || '已登录';
    var esc = function (s) { return String(s || '').replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); };

    if (loggedIn) {
      sheet.innerHTML = '<button class="hlsync-x" id="hlClose">×</button>'
        + '<h3>多端同步</h3>'
        + '<div class="st">当前账号：' + esc(who) + '<br>' + esc(statusText()) + '</div>'
        + '<div class="hlsync-row"><button class="hlsync-btn-ghost" id="hlNow">立即同步</button>'
        + '<button class="hlsync-btn-ghost" id="hlOut">退出登录</button></div>'
        + '<div class="hlsync-tip">两端都登录同一账号后，数据改一边另一边自动跟上。同一时刻两边都改，以最后一次修改为准。</div>';
      $('#hlClose').onclick = closePanel;
      $('#hlNow').onclick = async function () { await pull(false); renderPanel(); };
      $('#hlOut').onclick = async function () { await doSignOut(); };
    } else {
      sheet.innerHTML = '<button class="hlsync-x" id="hlClose">×</button>'
        + '<h3>登录后多端同步</h3>'
        + '<div class="st">' + esc(statusText()) + '</div>'
        + '<div class="hlsync-row">'
        + '<button class="hlsync-tab on" data-m="phone">手机号</button>'
        + '<button class="hlsync-tab" data-m="email">邮箱</button></div>'
        + '<input class="hlsync-input" id="hlId" type="tel" inputmode="numeric" placeholder="11 位手机号">'
        + '<div class="hlsync-code"><input class="hlsync-input" id="hlCode" inputmode="numeric" placeholder="验证码">'
        + '<button class="hlsync-getcode" id="hlGet">获取验证码</button></div>'
        + '<div class="hlsync-err" id="hlErr"></div>'
        + '<button class="hlsync-btn-main" id="hlLogin">登录 / 注册</button>'
        + '<div class="hlsync-tip">首次使用的手机号或邮箱会自动注册。不登录也能用，只是数据只存在这台设备。</div>';
      var mode = 'phone';
      var pending = null;
      var err = $('#hlErr');
      var idEl = $('#hlId');
      var codeEl = $('#hlCode');
      var getEl = $('#hlGet');

      sheet.querySelectorAll('.hlsync-tab').forEach(function (t) {
        t.onclick = function () {
          mode = t.getAttribute('data-m');
          sheet.querySelectorAll('.hlsync-tab').forEach(function (x) { x.classList.toggle('on', x === t); });
          idEl.type = mode === 'phone' ? 'tel' : 'email';
          idEl.setAttribute('inputmode', mode === 'phone' ? 'numeric' : 'email');
          idEl.placeholder = mode === 'phone' ? '11 位手机号' : '邮箱地址';
          idEl.value = ''; codeEl.value = ''; pending = null; err.textContent = '';
        };
      });

      getEl.onclick = async function () {
        var c = getCloud();
        if (!c) { err.textContent = '同步组件未加载'; return; }
        var v = (idEl.value || '').trim();
        if (mode === 'phone' && !/^1\d{10}$/.test(v)) { err.textContent = '请输入正确的 11 位手机号'; return; }
        if (mode === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) { err.textContent = '请输入正确的邮箱'; return; }
        err.textContent = '';
        getEl.disabled = true;
        var payload = mode === 'phone' ? { phone: v } : { email: v };
        var r = await c.auth.sendOtp(payload);
        if (r.error) { getEl.disabled = false; err.textContent = errText(r.error); return; }
        pending = { id: v, verificationId: r.data.verificationId, isExistingUser: r.data.isExistingUser, mode: mode };
        err.textContent = '验证码已发送';
        var left = 60;
        var t = setInterval(function () {
          left--;
          if (left <= 0) { clearInterval(t); getEl.disabled = false; getEl.textContent = '重新获取'; }
          else getEl.textContent = left + 's';
        }, 1000);
        getEl.textContent = '60s';
      };

      $('#hlLogin').onclick = async function () {
        var c = getCloud();
        if (!c) { err.textContent = '同步组件未加载'; return; }
        var v = (idEl.value || '').trim();
        var code = (codeEl.value || '').trim();
        if (!pending || pending.id !== v) { err.textContent = '请先给当前' + (mode === 'phone' ? '手机号' : '邮箱') + '获取验证码'; return; }
        if (!code) { err.textContent = '请输入验证码'; return; }
        err.textContent = '';
        var btn = $('#hlLogin'); btn.disabled = true; btn.textContent = '登录中…';
        var args = { verificationId: pending.verificationId, isExistingUser: pending.isExistingUser, token: code };
        if (pending.mode === 'phone') args.phone = pending.id; else args.email = pending.id;
        var r = await c.auth.verifyOtp(args);
        btn.disabled = false; btn.textContent = '登录 / 注册';
        if (r.error) { err.textContent = errText(r.error); return; }
        S.session = r.data;
        closePanel();
        await reconcile();
        renderPanel();
      };
      $('#hlClose').onclick = closePanel;
    }
    $('#hlsyncMask').classList.add('show');
    paint();
  }

  /* ---------- 事件 ---------- */
  function bindGlobal() {
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && S.session) pull(true);
    });
    global.addEventListener('focus', function () { if (S.session) pull(true); });
    global.addEventListener('online', function () { if (S.session) pull(true); });
  }

  var api = {
    init: function (opts) {
      if (S.inited) return api;
      S.inited = true;
      S.app = opts.app;
      S.snapshot = opts.snapshot;
      S.restore = opts.restore;
      S.merge = typeof opts.merge === 'function' ? opts.merge : null;
      S.hasData = opts.hasData || S.hasData;
      S.rerender = opts.rerender || S.rerender;
      S.metaKey = 'hlsync.meta.' + S.app;
      injectCSS();
      var btn = $('#hlsyncBtn');
      if (btn) btn.addEventListener('click', function () { renderPanel(); });
      bindGlobal();
      paint();
      refreshSession().then(function () { paint(); });
      return api;
    },
    touch: function () {
      markDirty();
      paint();
      if (S.session) schedulePush();
    },
    status: function () { return { loggedIn: !!S.session, status: S.status, lastSync: S.lastSync }; },
    pull: function () { return pull(false); },
    panel: function () { renderPanel(); }
  };

  global.HealthSync = api;
})(window);
