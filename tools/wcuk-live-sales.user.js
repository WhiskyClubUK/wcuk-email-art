// ==UserScript==
// @name         WCUK live sales for Today's Push
// @namespace    https://whiskyclubuk.com/
// @version      2.0
// @updateURL    https://raw.githubusercontent.com/WhiskyClubUK/wcuk-email-art/claude/project-thread-pypykz/tools/wcuk-live-sales.user.js
// @downloadURL  https://raw.githubusercontent.com/WhiskyClubUK/wcuk-email-art/claude/project-thread-pypykz/tools/wcuk-live-sales.user.js
// @description  Every 60 seconds, reads Rafflex Analytics (from a pinned Analytics tab) and today's completed orders with your own sign-in and shows the totals on the Marketing Desk and HQ pages. On the Marketing Analytics and HQ pages it also reads past orders, a page at a time, and hands over each day's totals by hour and source. Reads only date, source and total; nothing about customers leaves the orders list.
// @match        https://claude.ai/*
// @match        https://whiskyclubuk.com/admin/analytics*
// @noframes
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      whiskyclubuk.com
// @run-at       document-idle
// ==/UserScript==
(function () {
  'use strict';
  var PAGE_ID = '2NXmVoHY5jqSCigPTi9P5r';      // the Marketing Desk artifact
  var ANALYTICS_ID = 'GHGGTQZqCJt69pfKFtbWLo'; // the Marketing Analytics artifact
  var HQ_ID = 'Bb98bS29Yi9QEoGHT3joMR';        // the Whisky Club HQ front page
  var SITE = 'https://whiskyclubuk.com';
  var EVERY_MS = 60 * 1000, MAX_PAGES = 15;
  var last = null, busy = false;

  function onHQ() { return location.pathname.indexOf(HQ_ID) !== -1; }
  // Today's sales go to the Marketing Desk and to HQ.
  function onPage() { return location.pathname.indexOf(PAGE_ID) !== -1 || onHQ(); }
  function onAnalytics() { return location.pathname.indexOf(ANALYTICS_ID) !== -1; }
  function get(path) {
    return new Promise(function (ok, fail) {
      GM_xmlhttpRequest({ method: 'GET', url: SITE + path, timeout: 20000,
        onload: function (r) { ok(r); }, onerror: fail, ontimeout: fail });
    });
  }
  function parse(html) {
    var light = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<svg[\s\S]*?<\/svg>/gi, '');
    return new DOMParser().parseFromString(light, 'text/html');
  }
  function money(s) { var m = String(s || '').replace(/,/g, '').match(/-?£?\s*(-?\d+(?:\.\d+)?)/); return m ? parseFloat(m[1]) : 0; }
  function cell(r, i) { return ((r.cells[i] && r.cells[i].textContent) || '').replace(/\s+/g, ' ').trim(); }
  function isoDay(d) { return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); }
  function r2(n) { return Math.round(n * 100) / 100; }

  // Rafflex's own Analytics cards, found by their captions (Sales: "Total Revenue + Credit", Orders: "Orders made"). This is the number Simon checks.
  function norm(t) { return String(t || '').replace(/\s+/g, ' ').trim(); }
  function cardValue(doc, label) {
    var els = doc.querySelectorAll('body *');
    for (var i = els.length - 1; i >= 0; i--) {           // deepest first
      // Since 19 Oct the captions run on ("Total Revenue + Credit, by order date."), so a caption only has to start with the label.
      if (els[i].children.length || norm(els[i].textContent).indexOf(label) !== 0) continue;
      for (var box = els[i].parentElement, up = 0; box && up < 4; box = box.parentElement, up++) {
        var m = norm(box.textContent).replace(label, '').replace(/,/g, '').match(/£?\s*(\d+(?:\.\d+)?)/);
        if (m) return parseFloat(m[1]);
      }
    }
    return null;
  }
  // Analytics fills its cards in after load, so a fetch sees no figures. A pinned Analytics tab
  // reads them once rendered and hands them over through Tampermonkey's storage.
  async function analytics() {
    var a = GM_getValue('analytics', null);
    if (!a) return { why: 'open Rafflex Analytics in a pinned tab' };
    if (a.day !== isoDay(new Date()) || Date.now() - a.at > 3 * 60 * 1000) return { why: 'Analytics tab last read ' + new Date(a.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) };
    return a;
  }
  function analyticsTab() {
    // The cards count up from zero when the page loads, so only trust a figure once it has held still for 2 seconds.
    var tries = 0, prev = null, steady = 0;
    var t = setInterval(function () {
      tries++;
      var text = norm(document.body && document.body.textContent);
      var sales = cardValue(document, 'Total Revenue + Credit'), orders = cardValue(document, 'Orders made');
      if (sales == null || !/Today\s*-/.test(text)) { if (tries > 80) clearInterval(t); return; }
      var key = sales + '|' + orders;
      steady = key === prev ? steady + 1 : 0; prev = key;
      if (steady >= 4) {
        clearInterval(t);
        GM_setValue('analytics', { sales: sales, orders: orders, day: isoDay(new Date()), at: Date.now() });
      } else if (tries > 80) clearInterval(t);
    }, 500);
    // Reload once a minute for fresh figures, unless someone has picked a different date range.
    setTimeout(function () { if (/Today\s*-/.test(norm(document.body.textContent))) location.reload(); }, EVERY_MS);
  }

  // Rafflex's orders table (17 Oct layout): Order (with a <time datetime>), Customer, Paid, Source, Status. Columns are
  // found by their headings so a reshuffle doesn't zero the split again; the old fixed layout is the fallback.
  function columns(tb) {
    var h = [].map.call(tb.querySelectorAll('thead th'), function (t) { return norm(t.textContent).toLowerCase(); });
    var at = function (name, dflt) { var i = h.indexOf(name); return i === -1 ? dflt : i; };
    return { paid: at('paid', at('total', 3)), source: at('source', 2), status: at('status', 4), date: at('date', 5) };
  }
  function when(r, col) {
    var t = r.querySelector('time[datetime]');
    return new Date(t ? t.getAttribute('datetime') : cell(r, col.date));
  }
  async function scan() {
    var now = new Date(), start = new Date(now); start.setHours(0, 0, 0, 0);
    var out = { type: 'wcuk-sales', date: isoDay(now), total_revenue: 0, total_orders: 0, marketing_revenue: 0, marketing_orders: 0, by_source: {} };
    for (var page = 1; page <= MAX_PAGES; page++) {
      var res = await get('/admin/orders?per_page=50&page=' + page);
      var doc = parse(res.responseText || '');
      var tb = doc.querySelector('table');
      if (!tb || !tb.tBodies[0]) {
        if (page === 1) return { type: 'wcuk-sales', state: 'signed_out', date: out.date, checked_at: now.toISOString() };
        break;
      }
      var col = columns(tb);
      var rows = [].slice.call(tb.tBodies[0].rows).filter(function (r) { return !isNaN(when(r, col)); });
      if (!rows.length) break;
      var older = false;
      rows.forEach(function (r) {
        var dt = when(r, col);
        if (dt < start) { older = true; return; }
        if (!/complete/i.test(cell(r, col.status))) return;
        var src = (cell(r, col.source).split(' ')[0] || 'unknown').toLowerCase(), total = money(cell(r, col.paid));
        if (total > 0) out.total_orders++; out.total_revenue += total;
        var s = out.by_source[src] = out.by_source[src] || { orders: 0, revenue: 0 };
        if (total > 0) s.orders++; s.revenue += total;
        if (src === 'attentive') { if (total > 0) out.marketing_orders++; out.marketing_revenue += total; }
      });
      if (older) break;
    }
    out.total_revenue = r2(out.total_revenue); out.marketing_revenue = r2(out.marketing_revenue);
    Object.keys(out.by_source).forEach(function (k) { out.by_source[k].revenue = r2(out.by_source[k].revenue); });
    // Headline figures come from Analytics when it can be read; the orders list still gives the split by source.
    var a = await analytics();
    // 'gap2' (2.0): 1.8 stored its gap while the orders list read nothing, so that one is dropped.
    // Analytics adds wallet credit the orders list doesn't show. Remember the gap while Analytics is fresh,
    // and when its tab goes quiet (Chrome rests background tabs) add that gap to the orders list, so the total never flips back.
    var listRev = out.total_revenue, listOrders = out.total_orders, gap = GM_getValue('gap2', null);
    if (a.sales != null) {
      out.total_revenue = r2(a.sales); if (a.orders != null) out.total_orders = Math.round(a.orders); out.from = 'analytics';
      if (Date.now() - a.at < 90 * 1000) GM_setValue('gap2', { day: out.date, rev: a.sales - listRev, orders: (a.orders != null ? a.orders : listOrders) - listOrders });
    } else if (gap && gap.day === out.date) {
      out.total_revenue = r2(listRev + gap.rev); out.total_orders = Math.max(0, listOrders + gap.orders); out.from = 'estimate'; out.why = a.why;
    } else { out.from = 'orders list'; out.why = a.why; }
    out.state = 'ok'; out.checked_at = now.toISOString();
    out.as_of = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    return out;
  }

  // The page sits in nested cross-origin frames, so hand the totals to every frame.
  function post(msg, w) {
    w = w || window;
    for (var i = 0; i < w.frames.length; i++) {
      try { w.frames[i].postMessage(msg, '*'); post(msg, w.frames[i]); } catch (e) {}
    }
  }
  async function tick() {
    if (!onPage() || busy) return;
    busy = true;
    try { last = await scan(); } catch (e) { last = { type: 'wcuk-sales', state: 'error', checked_at: new Date().toISOString() }; }
    busy = false;
    post({ type: 'wcuk-helper', dictate: !!Rec });
    post(last);
  }
  if (location.hostname === 'whiskyclubuk.com') { analyticsTab(); return; }

  // Dictation: the page sits in a sandboxed frame without the microphone, so the top claude.ai tab listens
  // for it (Chrome asks once for microphone access) and posts the words back into the page.
  var Rec = window.SpeechRecognition || window.webkitSpeechRecognition, rec = null;
  function dictate(action) {
    if (action === 'stop') { if (rec) rec.stop(); return; }
    if (!Rec || rec) return;
    rec = new Rec(); rec.lang = 'en-GB'; rec.continuous = true; rec.interimResults = true;
    rec.onresult = function (e) {
      var text = '';
      for (var i = 0; i < e.results.length; i++) text += e.results[i][0].transcript;
      post({ type: 'wcuk-dictation', text: text });
    };
    rec.onerror = function (e) { post({ type: 'wcuk-dictation', error: e.error || 'error' }); };
    rec.onend = function () { rec = null; post({ type: 'wcuk-dictation', done: true }); };
    try { rec.start(); } catch (e) { rec = null; post({ type: 'wcuk-dictation', error: 'start' }); }
  }


  // Order history for the Analytics page. Walks the orders list newest first, one page a second, and posts each
  // finished day (orders, revenue, split by source and by hour) to the page, which saves it. Days the page already
  // has are skipped. A long backfill picks up where it stopped next time the page is opened.
  var histBusy = false;
  // Each page keeps its own place in the walk, so HQ's short top-up never moves the Analytics backfill.
  function histKey() { return onHQ() ? 'hist-hq' : 'hist'; }
  function sleep(ms) { return new Promise(function (ok) { setTimeout(ok, ms); }); }
  function blankDay(d) { var o = [], r = []; for (var i = 0; i < 24; i++) { o.push(0); r.push(0); } return { date: d, orders: 0, revenue: 0, zero_orders: 0, by_source: {}, o: o, r: r }; }
  function finish(day) {
    day.revenue = r2(day.revenue); day.r = day.r.map(r2);
    Object.keys(day.by_source).forEach(function (k) { day.by_source[k].revenue = r2(day.by_source[k].revenue); });
    return day;
  }
  async function getPage(page) {
    for (var tries = 0; tries < 4; tries++) {
      try {
        var res = await get('/admin/orders?per_page=50&page=' + page);
        if (res.status === 200) return res;
        if (res.status === 401 || res.status === 403) return null;
      } catch (e) {}
      await sleep(30000 * (tries + 1));            // the site is busy or blocking: back off and try again
    }
    return null;
  }
  async function history(have, since) {
    if (histBusy) return; histBusy = true;
    var done = {}; (have || []).forEach(function (d) { done[d] = true; });
    var today = isoDay(new Date()), sent = 0;
    // Resume a backfill near where it stopped (a little earlier, since new orders push old ones down the list).
    var saved = GM_getValue(histKey(), null), page = 1, resumed = false;
    var recentDone = done[isoDay(new Date(Date.now() - 864e5))];
    if (recentDone && saved && saved.page > 40 && saved.oldest > since) { page = Math.max(1, saved.page - 40); resumed = true; }
    var cur = null, firstDay = true, oldest = saved && saved.oldest || today;
    post({ type: 'wcuk-history', state: 'running', page: page });
    while (true) {
      var res = await getPage(page);
      if (!res) { post({ type: 'wcuk-history', state: 'stopped', why: 'Rafflex did not answer. Check you are signed in, then reload this page.', page: page }); break; }
      var doc = parse(res.responseText || ''), tb = doc.querySelector('table');
      if (!tb || !tb.tBodies[0]) { post({ type: 'wcuk-history', state: page === 1 ? 'signed_out' : 'done', page: page }); break; }
      var rows = [].slice.call(tb.tBodies[0].rows).filter(function (r) { return /^\d+$/.test(cell(r, 0)); });
      if (!rows.length) { if (cur && !firstDay && !done[cur.date]) post({ type: 'wcuk-history-day', day: finish(cur) }); post({ type: 'wcuk-history', state: 'done', page: page }); break; }
      // After a resume, landing past the saved frontier would leave a gap: step back and look again.
      if (resumed && !cur && page > 1 && isoDay(new Date(cell(rows[0], 5))) < saved.oldest) { page = Math.max(1, page - 100); await sleep(1000); continue; }
      var stop = false;
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i], dt = new Date(cell(r, 5)); if (isNaN(dt)) continue;
        var d = isoDay(dt);
        if (!cur || d !== cur.date) {
          if (cur) {
            // cur is now complete, unless the walk started part-way through it after a resume
            if (!(firstDay && resumed) && cur.date !== today && !done[cur.date]) { post({ type: 'wcuk-history-day', day: finish(cur) }); sent++; }
            if (cur.date < oldest) oldest = cur.date;
            firstDay = false;
          }
          if (d < since) { stop = true; break; }
          cur = blankDay(d);
        }
        if (!/complete/i.test(cell(r, 4))) continue;
        var src = (cell(r, 2) || 'unknown').toLowerCase(), total = money(cell(r, 3)), h = dt.getHours();
        var s = cur.by_source[src] = cur.by_source[src] || { orders: 0, revenue: 0 };
        if (total > 0) { cur.orders++; s.orders++; cur.o[h]++; } else cur.zero_orders++;
        cur.revenue += total; s.revenue += total; cur.r[h] += total;
      }
      // Caught up: the newest days are saved and no backfill is left, so stop once we reach a saved day.
      if (!stop && !resumed && cur && done[cur.date] && cur.date < today && saved && saved.oldest <= since) stop = true;
      // Also caught up when we reach two saved days in a row: everything older was saved by an earlier backfill.
      if (!stop && !resumed && cur && cur.date < today && done[cur.date] && done[isoDay(new Date(new Date(cur.date + 'T12:00:00').getTime() - 864e5))]) stop = true;
      GM_setValue(histKey(), { page: page, oldest: oldest });
      post({ type: 'wcuk-history', state: stop ? 'done' : 'running', page: page, reached: cur && cur.date, sent: sent });
      if (stop) { if (oldest <= since || (cur && cur.date < since)) GM_setValue(histKey(), { page: page, oldest: since }); break; }
      page++;
      await sleep(1000);
    }
    histBusy = false;
  }

  // The page says hello when it loads; answer straight away.
  window.addEventListener('message', function (ev) {
    if (ev.data && ev.data.type === 'wcuk-history-hello' && (onAnalytics() || onHQ())) {
      var since = /^\d{4}-\d{2}-\d{2}$/.test(ev.data.since || '') ? ev.data.since : '2024-06-01';
      post({ type: 'wcuk-helper', history: true });
      history(Array.isArray(ev.data.have) ? ev.data.have : [], since);
      return;
    }
    if (!ev.data || !onPage()) return;
    if (ev.data.type === 'wcuk-dictate') { dictate(ev.data.action); return; }
    if (ev.data.type !== 'wcuk-sales-hello') return;
    post({ type: 'wcuk-helper', dictate: !!Rec });
    if (last) post(last); else tick();
  });
  setTimeout(tick, 3000);
  setInterval(tick, EVERY_MS);
})();
