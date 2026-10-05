/*! Smith Lake Map v3 — Justin Dyar / Lake Homes Realty. Built by AI Syndicate. Plain JS + MapLibre GL. */
(function () {
  'use strict';

  var root = document.querySelector('[data-slm-app]');
  if (!root) return;
  var DATA = window.SLM_DATA;
  if (!DATA) { var el = document.getElementById('slm-data'); try { DATA = JSON.parse(el ? el.textContent : 'null'); } catch (e) { DATA = null; } }
  if (!DATA) return;

  var CATS = DATA.cats, ORDER = DATA.catOrder, ICONS = DATA.icons;
  var PLACES = DATA.places, LISTINGS = DATA.listings || [];
  var ALL = PLACES.concat(LISTINGS);
  var byId = {}; ALL.forEach(function (p) { byId[p.id] = p; });
  var J = DATA.justin;
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var mqMobile = window.matchMedia('(max-width: 899px)');

  // ---------------- state ----------------
  var chosen = {};            // empty = everything
  var waterMax = 0;           // >0: only places within this many metres of the shoreline
  var query = '';
  var inView = true;          // list follows the map
  var selectedId = null;
  var userPos = null;         // [lon, lat]
  var map = null, everLoaded = false, hoverId = null, tip = null;
  var homeMarkers = [];

  // ---------------- dom ----------------
  var $ = function (s, r) { return (r || root).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || root).querySelectorAll(s)); };
  var panel = $('[data-slm-panel]'), listEl = $('[data-slm-list]'), countEl = $('[data-slm-count]');
  var detailEl = $('[data-slm-detail]'), browseEl = $('[data-slm-browse]');
  var searchEl = $('[data-slm-search]'), mapEl = $('[data-slm-map]'), statusEl = $('[data-slm-status]');
  var viewToggle = $('[data-slm-inview]');
  var shell = root.closest('.slm') || document;   // hero tiles live outside the map box
  var clearBtn = $('[data-slm-clear]'), hintEl = $('[data-slm-hint]');
  var activePick = null;
  root.classList.add('slm--js');

  function hideHint() { if (hintEl) hintEl.classList.add('is-gone'); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function announce(m) { if (!statusEl) return; statusEl.textContent = ''; setTimeout(function () { statusEl.textContent = m; }, 40); }
  function svg(cat, cls) {
    var d = ICONS[cat] || ICONS.todo;
    return '<svg class="' + (cls || 'slm-ico') + '" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="' + d + '"/></svg>';
  }
  function badge(cat) { var c = CATS[cat] || {}; return '<span class="slm-badge" style="--c:' + c.color + '">' + svg(cat) + '</span>'; }
  function miles(a, b) {
    var R = 3958.8, t = Math.PI / 180, dLa = (b[1] - a[1]) * t, dLo = (b[0] - a[0]) * t;
    var h = Math.sin(dLa / 2) * Math.sin(dLa / 2) + Math.cos(a[1] * t) * Math.cos(b[1] * t) * Math.sin(dLo / 2) * Math.sin(dLo / 2);
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  function waterLabel(p) { if (p.w == null) return ''; return p.w <= 300 ? 'On the lake' : (p.w / 1609.34 < 10 ? (p.w / 1609.34).toFixed(1) : Math.round(p.w / 1609.34)) + ' mi to lake'; }
  function fmtMi(m) { return m < 0.1 ? 'here' : (m < 10 ? m.toFixed(1) : Math.round(m)) + ' mi'; }
  function ll(p) { return [p.lon, p.lat]; }

  // ---------------- filtering ----------------
  function anyChosen() { for (var k in chosen) if (chosen[k]) return true; return false; }
  function catOn(cat) { return !anyChosen() || !!chosen[cat]; }
  function matches(p) {
    if (!catOn(p.cat)) return false;
    if (waterMax && !(p.w != null && p.w <= waterMax)) return false;
    if (!query) return true;
    var hay = (p.name + ' ' + (p.town || '') + ' ' + (p.addr || '') + ' ' + (CATS[p.cat] ? CATS[p.cat].label + ' ' + CATS[p.cat].plural : '') + ' ' + (p.desc || '') + ' ' + (p.tags || []).join(' ')).toLowerCase();
    return query.split(/\s+/).every(function (w) { return (SYN[w] || [w]).some(function (x) { return hay.indexOf(x) !== -1; }); });
  }
  var SYN = { bbq: ['bbq', 'barbecue', 'bar-b-q', 'bar b q'], barbecue: ['bbq', 'barbecue', 'bar-b-q'], coffee: ['coffee', 'cafe', 'starbucks', 'dunkin'],
    gas: ['gas', 'fuel'], food: ['restaurant', 'food', 'cafe', 'grill'], eat: ['restaurant', 'food', 'cafe', 'grill'], groceries: ['grocery', 'groceries', 'market', 'foodland', 'supersaver'],
    hospital: ['hospital', 'medical', 'urgent'], doctor: ['medical', 'urgent', 'clinic', 'hospital'], pharmacy: ['pharmacy', 'drug'], boat: ['boat', 'marina', 'pontoon', 'jet ski'],
    ramp: ['ramp', 'launch'], hike: ['trail', 'falls', 'hike'], waterfall: ['falls', 'waterfall'], camping: ['camp', 'rv'], mexican: ['mexican', 'taco', 'tex-mex', 'cantina'] };
  function origin() { return userPos || (map ? [map.getCenter().lng, map.getCenter().lat] : [(DATA.bounds[0] + DATA.bounds[2]) / 2, (DATA.bounds[1] + DATA.bounds[3]) / 2]); }

  // ---------------- chips ----------------
  function syncChips() {
    var none = !anyChosen();
    $$('[data-slm-cat]').forEach(function (b) { b.setAttribute('aria-pressed', String(!none && !!chosen[b.getAttribute('data-slm-cat')])); });
    var all = $('[data-slm-all]'); if (all) all.setAttribute('aria-pressed', String(none));
    $$('[data-slm-pick]', shell).forEach(function (b) { b.setAttribute('aria-pressed', String(b === activePick)); });
    if (clearBtn) clearBtn.hidden = none && !waterMax && !query;
  }
  $$('[data-slm-cat]').forEach(function (b) {
    b.addEventListener('click', function () {
      var k = b.getAttribute('data-slm-cat');
      chosen[k] = !chosen[k]; waterMax = 0; activePick = null;
      syncChips(); refresh(true);
      announce(anyChosen() ? 'Showing ' + Object.keys(chosen).filter(function (x) { return chosen[x]; }).map(function (x) { return CATS[x].plural; }).join(', ') : 'Showing everything');
    });
  });
  var allBtn = $('[data-slm-all]');
  function showAll() { chosen = {}; waterMax = 0; activePick = null; query = ''; if (searchEl) searchEl.value = ''; syncChips(); refresh(true); announce('Showing everything'); }
  if (allBtn) allBtn.addEventListener('click', showAll);
  if (clearBtn) clearBtn.addEventListener('click', function () { showAll(); if (map) map.fitBounds([[DATA.bounds[0], DATA.bounds[1]], [DATA.bounds[2], DATA.bounds[3]]], { padding: fitPad(), duration: reduceMotion ? 0 : 600 }); });

  // quick picks
  $$('[data-slm-pick]', shell).forEach(function (b) {
    b.addEventListener('click', function () {
      if (activePick === b) { showAll(); return; }   // second tap turns the tile off
      activePick = b;
      var cats = b.getAttribute('data-slm-pick').split(',');
      chosen = {}; cats.forEach(function (c) { chosen[c] = true; });
      waterMax = +(b.getAttribute('data-slm-water') || 0);
      query = ''; if (searchEl) searchEl.value = '';
      inView = false; if (viewToggle) viewToggle.checked = false;
      syncChips(); closeDetail(true); refresh(true);
      fitTo(ALL.filter(matches));
      // the tiles sit above the map: bring the map into view so the result is visible
      var r = root.getBoundingClientRect();
      if (r.top > window.innerHeight * 0.45 || r.bottom < 120) root.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
      hideHint();
      announce(b.querySelector('.slm-tile__t').textContent + ': ' + ALL.filter(matches).length + ' places');
    });
  });

  // search
  var st;
  if (searchEl) searchEl.addEventListener('input', function () {
    clearTimeout(st);
    st = setTimeout(function () {
      query = searchEl.value.trim().toLowerCase();
      if (query) { inView = false; if (viewToggle) viewToggle.checked = false; }
      activePick = null; syncChips();
      refresh(true);
      announce(countEl.textContent);
    }, 160);
  });
  if (viewToggle) viewToggle.addEventListener('change', function () { inView = viewToggle.checked; renderList(); });

  // ---------------- list ----------------
  function visibleNow(p) {
    if (!inView || !map || !everLoaded) return true;
    var b = map.getBounds();
    return b.contains([p.lon, p.lat]);
  }
  function renderList() {
    var o = origin();
    var byWater = !userPos;  // lake-first unless the visitor asked for 'near me'
    var rows = ALL.filter(matches).filter(visibleNow).map(function (p) { return { p: p, d: byWater ? (p.w == null ? 99999 : p.w) / 1609.34 : miles(o, ll(p)) }; });
    rows.sort(function (a, b) { return a.d - b.d; });
    var total = ALL.filter(matches).length;
    var shown = rows.slice(0, 250);
    var html = shown.map(function (r) {
      var p = r.p, c = CATS[p.cat] || {};
      var sub = p.cat === 'homes' ? (p.price + ' · ' + (p.kind || 'Listing')) : (c.label + (p.town ? ' · ' + p.town : ''));
      return '<li><button type="button" class="slm-row' + (p.id === selectedId ? ' is-on' : '') + '" data-id="' + esc(p.id) + '">' +
        badge(p.cat) + '<span class="slm-row__txt"><span class="slm-row__name">' + esc(p.name) + '</span><span class="slm-row__sub">' + esc(sub) + '</span></span>' +
        '<span class="slm-row__mi">' + (byWater ? waterLabel(p) : fmtMi(r.d)) + '</span></button></li>';
    }).join('');
    if (!rows.length) html = '<li class="slm-empty">' + (inView && total ? 'Nothing here in this part of the map. <button type="button" class="slm-link" data-slm-widen>Show the whole lake</button>' : 'Nothing matches. Try another word or tap <strong>All</strong>.') + '</li>';
    listEl.innerHTML = html;
    var label = inView && everLoaded ? rows.length + (rows.length === 1 ? ' place' : ' places') + ' in this part of the map' : rows.length + (rows.length === 1 ? ' place' : ' places');
    if (rows.length > shown.length) label += ' (closest ' + shown.length + ' listed)';
    countEl.textContent = label + (userPos ? ' · nearest to you first' : byWater ? ' · closest to the lake first' : ' · nearest the middle of the map first');
  }
  listEl.addEventListener('click', function (e) {
    var w = e.target.closest('[data-slm-widen]');
    if (w) { inView = false; if (viewToggle) viewToggle.checked = false; renderList(); fitTo(ALL.filter(matches)); return; }
    var b = e.target.closest('[data-id]'); if (b) select(b.getAttribute('data-id'), { fly: true, from: b });
  });
  listEl.addEventListener('mouseover', function (e) { var b = e.target.closest('[data-id]'); setHover(b ? b.getAttribute('data-id') : null); });
  listEl.addEventListener('mouseleave', function () { setHover(null); });
  listEl.addEventListener('focusin', function (e) { var b = e.target.closest('[data-id]'); setHover(b ? b.getAttribute('data-id') : null); });

  // ---------------- detail ----------------
  function nearest(p, filterFn, n) {
    return ALL.filter(function (q) { return q.id !== p.id && filterFn(q); })
      .map(function (q) { return { q: q, d: miles(ll(p), ll(q)) }; })
      .sort(function (a, b) { return a.d - b.d; }).slice(0, n);
  }
  function miniRow(r) {
    var q = r.q, c = CATS[q.cat] || {};
    var sub = q.cat === 'homes' ? q.price : c.label;
    return '<li><button type="button" class="slm-mini" data-id="' + esc(q.id) + '">' + badge(q.cat) +
      '<span class="slm-row__txt"><span class="slm-row__name">' + esc(q.name) + '</span><span class="slm-row__sub">' + esc(sub) + '</span></span><span class="slm-row__mi">' + fmtMi(r.d) + '</span></button></li>';
  }
  function dirUrl(p) { return 'https://www.google.com/maps/dir/?api=1&destination=' + p.lat + ',' + p.lon; }
  function telHref(ph) { return 'tel:' + String(ph).replace(/[^\d+]/g, ''); }

  function detailHtml(p) {
    var c = CATS[p.cat] || {}, h = '';
    h += '<div class="slm-d__top"><button type="button" class="slm-back" data-slm-back><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>All places</button>';
    h += '<button type="button" class="slm-share" data-slm-share aria-label="Share a link to ' + esc(p.name) + '"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 12h.01M4 12a8 8 0 0 0 8 8M12 4v10M8 8l4-4 4 4"/></svg>Share</button></div>';
    h += '<div class="slm-d__head" style="--c:' + c.color + '">' + badge(p.cat) + '<div><p class="slm-d__cat">' + esc(c.label) + (p.town ? ' · ' + esc(p.town) : '') + '</p>';
    h += '<h3 class="slm-d__name" tabindex="-1" data-slm-dname>' + esc(p.name) + '</h3></div></div>';
    if (p.w != null) h += '<p class="slm-d__water">' + (p.w <= 300 ? 'On the lake' : waterLabel(p).replace('mi to lake', 'miles from the lake')) + '</p>';

    if (p.cat === 'homes') {
      h += '<p class="slm-d__price">' + esc(p.price) + '</p>';
      var bits = [];
      if (p.beds) bits.push('<span><strong>' + esc(p.beds) + '</strong> bed' + (p.beds === '1' ? '' : 's') + '</span>');
      if (p.baths) bits.push('<span><strong>' + esc(p.baths) + '</strong> bath' + (p.baths === '1' ? '' : 's') + '</span>');
      if (p.acres) bits.push('<span><strong>' + esc(p.acres) + '</strong> acres</span>');
      if (bits.length) h += '<p class="slm-d__stats">' + bits.join('') + '</p>';
      h += '<p class="slm-d__meta">MLS# ' + esc(p.mls) + ' · ' + esc(p.status) + ' · ' + esc(J.brokerage) + '</p>';
      h += '<div class="slm-d__actions"><a class="slm-btn slm-btn--lead" href="' + esc(p.url) + '">View this listing</a><a class="slm-btn" href="' + esc(telHref(J.phone)) + '">Call Justin</a><a class="slm-btn" href="' + esc(J.contact) + '">Ask a question</a></div>';
      h += '<p class="slm-d__fine">Price as of ' + esc(DATA.listingsAsOf) + '. Open the listing for today\'s price and status.</p>';
      var near = ['ramp', 'marina', 'food', 'grocery', 'fuel', 'essentials'].map(function (k) { return nearest(p, function (q) { return q.cat === k; }, 1)[0]; }).filter(Boolean);
      if (near.length) h += '<h4 class="slm-d__h">What\'s close to this home</h4><ul class="slm-d__list">' + near.map(miniRow).join('') + '</ul>';
    } else {
      if (p.desc) h += '<p class="slm-d__desc">' + esc(p.desc) + '</p>';
      if (p.status) h += '<p class="slm-d__note">' + esc(p.status) + '</p>';
      h += '<div class="slm-d__actions"><a class="slm-btn slm-btn--primary" href="' + esc(dirUrl(p)) + '" target="_blank" rel="noopener" aria-label="Directions to ' + esc(p.name) + ' (opens in a new tab)">Directions</a>';
      if (p.phone) h += '<a class="slm-btn" href="' + esc(telHref(p.phone)) + '">Call</a>';
      if (p.web) h += '<a class="slm-btn" href="' + esc(p.web) + '" target="_blank" rel="noopener nofollow" aria-label="Website for ' + esc(p.name) + ' (opens in a new tab)">Website</a>';
      h += '</div><dl class="slm-d__info">';
      if (p.addr) h += '<div><dt>Address</dt><dd>' + esc(p.addr) + '</dd></div>';
      if (p.phone) h += '<div><dt>Phone</dt><dd><a href="' + esc(telHref(p.phone)) + '">' + esc(p.phone) + '</a></dd></div>';
      if (p.hours) h += '<div><dt>Hours</dt><dd>' + esc(p.hours) + '</dd></div>';
      if (p.fee) h += '<div><dt>Fees</dt><dd>' + esc(p.fee === true ? 'Fee or pass required' : p.fee) + '</dd></div>';
      h += '</dl>';
      var homes = nearest(p, function (q) { return q.cat === 'homes'; }, 3).filter(function (r) { return r.d <= 10; });
      h += '<section class="slm-d__homes" aria-label="Homes for sale near here"><h4 class="slm-d__h">' + (homes.length ? 'Justin\'s homes near here' : 'Looking for a place on the lake?') + '</h4>';
      if (homes.length) h += '<ul class="slm-d__list">' + homes.map(miniRow).join('') + '</ul>';
      h += '<a class="slm-btn slm-btn--lead slm-btn--block" href="' + esc(p.homesUrl || J.listings) + '">See homes for sale near ' + esc(p.near || 'Smith Lake') + '</a></section>';
      var around = nearest(p, function (q) { return q.cat !== 'homes' && q.cat !== p.cat; }, 4);
      if (around.length) h += '<h4 class="slm-d__h">Also nearby</h4><ul class="slm-d__list">' + around.map(miniRow).join('') + '</ul>';
      if (p.srcName) h += '<p class="slm-d__fine">Source: ' + esc(p.srcName) + (p.approx ? '. Pin placed from the street address, so it may be a little off.' : '.') + ' Call ahead: hours and fees change.</p>';
    }
    return h;
  }

  function openDetail(p) {
    detailEl.innerHTML = detailHtml(p);
    detailEl.hidden = false; browseEl.hidden = true;
    root.classList.add('slm--detail');
    panel.scrollTop = 0;
    var n = $('[data-slm-dname]', detailEl); if (n) try { n.focus({ preventScroll: true }); } catch (e) {}
  }
  var lastTrigger = null;
  function closeDetail(silent) {
    if (detailEl.hidden) return;
    detailEl.hidden = true; browseEl.hidden = false; root.classList.remove('slm--detail');
    setSel(null); selectedId = null;
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {}
    renderList();
    if (!silent && lastTrigger && document.contains(lastTrigger)) try { lastTrigger.focus(); } catch (e) {}
    else if (!silent) { var r = listEl.querySelector('.slm-row'); if (r) r.focus(); }
  }
  detailEl.addEventListener('click', function (e) {
    if (e.target.closest('[data-slm-back]')) { closeDetail(); return; }
    if (e.target.closest('[data-slm-share]')) { share(); return; }
    var b = e.target.closest('[data-id]'); if (b) select(b.getAttribute('data-id'), { fly: true });
  });
  root.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !detailEl.hidden) { e.preventDefault(); closeDetail(); } });

  function share() {
    var p = byId[selectedId]; if (!p) return;
    var url = location.href.split('#')[0] + '#place=' + encodeURIComponent(p.id);
    if (navigator.share) { navigator.share({ title: p.name + ' — Smith Lake Map', url: url }).catch(function () {}); return; }
    var done = function () { var b = $('[data-slm-share]', detailEl); if (b) { b.lastChild.textContent = 'Link copied'; } announce('Link copied'); };
    if (navigator.clipboard) navigator.clipboard.writeText(url).then(done, function () {}); else done();
  }

  function select(id, opts) {
    var p = byId[id]; if (!p) return;
    hideHint();
    opts = opts || {};
    if (opts.from) lastTrigger = opts.from;
    if (!catOn(p.cat)) { chosen = {}; syncChips(); refresh(false); }
    selectedId = id; setSel(p);
    try { history.replaceState(null, '', '#place=' + encodeURIComponent(id)); } catch (e) {}
    openDetail(p);
    if (mqMobile.matches) { var stg = $('.slm-stage'); if (stg && (stg.getBoundingClientRect().top < -40 || stg.getBoundingClientRect().top > window.innerHeight * 0.3)) stg.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' }); }
    if (map && opts.fly !== false) {
      var z = Math.max(map.getZoom(), p.cat === 'homes' ? 14.5 : 13.5);
      var pad = mqMobile.matches ? { top: 40, bottom: Math.round(mapEl.clientHeight * 0.45), left: 20, right: 20 } : { left: 0, top: 0, right: 0, bottom: 0 };
      if (reduceMotion) map.jumpTo({ center: ll(p), zoom: z, padding: pad }); else map.flyTo({ center: ll(p), zoom: z, speed: 1.3, padding: pad });
    }
    updateHomeMarkers();
    announce(p.name + ' opened');
  }

  // ---------------- map ----------------
  var B = DATA.bounds;
  function fitPad() { return mqMobile.matches ? 30 : { top: 70, bottom: 60, right: 60, left: (panel && panel.offsetWidth ? panel.offsetWidth + 44 : 60) }; } // keep pins out from under the side panel
  function fitTo(items) {
    if (!map || !items.length) return;
    var w = 180, s = 90, e = -180, n = -90;
    items.forEach(function (p) { w = Math.min(w, p.lon); e = Math.max(e, p.lon); s = Math.min(s, p.lat); n = Math.max(n, p.lat); });
    if (e - w < 0.01) { w -= 0.02; e += 0.02; s -= 0.015; n += 0.015; }
    map.fitBounds([[w, s], [e, n]], { padding: fitPad(), maxZoom: 14, duration: reduceMotion ? 0 : 700 });
  }
  // "Satellite" = USGS aerial photos with road and town labels from the street map laid on top
  var vectorJson = null;
  function getVector() {
    if (vectorJson) return Promise.resolve(vectorJson);
    return fetch(DATA.styles.vector).then(function (r) { if (!r.ok) throw new Error('style'); return r.json(); }).then(function (j) { vectorJson = j; return j; });
  }
  var OVERLAY = [];   // ids of label/road layers added on top of the photo map
  function overlayLayers(v) {
    var out = [];
    v.layers.forEach(function (l) {
      var sl = l['source-layer'] || '';
      if (l.type === 'line' && sl === 'transportation' && !/tunnel|path|rail|ferry|aeroway|pier|casing/.test(l.id)) {
        var L = JSON.parse(JSON.stringify(l)); L.id = 'ov-' + l.id; L.paint = L.paint || {};
        L.paint['line-color'] = 'rgba(255,244,214,.5)'; delete L.paint['line-dasharray']; delete L.paint['line-pattern']; out.push(L);
      } else if (l.type === 'symbol' && /^(transportation_name|water_name)$/.test(sl)) {
        var S = JSON.parse(JSON.stringify(l)); S.id = 'ov-' + l.id; S.paint = S.paint || {}; S.layout = S.layout || {};
        if (!S.layout['text-field']) return;
        delete S.layout['icon-image']; delete S.paint['icon-color'];
        S.paint['text-color'] = sl === 'water_name' ? '#d8f1fb' : '#ffffff';
        S.paint['text-halo-color'] = 'rgba(8,22,21,.85)'; S.paint['text-halo-width'] = 1.6; S.paint['text-halo-blur'] = 0.4;
        out.push(S);
      }
    });
    return out;
  }
  function addOverlay() {
    if (currentBase !== 'hybrid' || !map) return;
    getVector().then(function (v) {
      if (currentBase !== 'hybrid') return;
      try {
        for (var k in v.sources) if (!map.getSource(k)) map.addSource(k, v.sources[k]);
        var before = map.getLayer('slm-cluster') ? 'slm-cluster' : undefined;
        overlayLayers(v).forEach(function (l) { if (!map.getLayer(l.id)) { map.addLayer(l, before); OVERLAY.push(l.id); } });
      } catch (e) { /* labels are a bonus; the photo map still works without them */ }
    }).catch(function () {});
  }
  function styleFor(base) {
    if (base === 'map') return DATA.styles.vector;
    var r = DATA.styles.raster[base];
    return { version: 8, glyphs: DATA.styles.glyphs, sources: { base: { type: 'raster', tiles: [r.url], tileSize: 256, maxzoom: r.maxzoom, attribution: r.attribution } }, layers: [{ id: 'base', type: 'raster', source: 'base' }] };
  }
  function fc(items) {
    return { type: 'FeatureCollection', features: items.map(function (p) {
      return { type: 'Feature', id: p.n, geometry: { type: 'Point', coordinates: ll(p) }, properties: { id: p.id, cat: p.cat, name: p.name, icon: 'slm-' + p.cat, color: (CATS[p.cat] || {}).color } };
    }) };
  }
  // draw one round icon per category onto a canvas (no image files to host)
  function makeIcons() {
    var ratio = 2, size = 34, r = 14;
    ORDER.forEach(function (cat) {
      var id = 'slm-' + cat; if (map.hasImage(id)) return;
      var cv = document.createElement('canvas'); cv.width = cv.height = size * ratio;
      var g = cv.getContext('2d'); g.scale(ratio, ratio);
      g.shadowColor = 'rgba(0,0,0,.35)'; g.shadowBlur = 3; g.shadowOffsetY = 1;
      g.beginPath(); g.arc(size / 2, size / 2, r, 0, Math.PI * 2); g.fillStyle = CATS[cat].color; g.fill();
      g.shadowColor = 'transparent'; g.lineWidth = 2.2; g.strokeStyle = '#fbfaf7'; g.stroke();
      g.save(); g.translate(size / 2 - 8.5, size / 2 - 8.5); g.scale(17 / 24, 17 / 24);
      g.lineWidth = 2.4; g.lineCap = 'round'; g.lineJoin = 'round'; g.strokeStyle = '#fbfaf7';
      try { g.stroke(new Path2D(ICONS[cat])); } catch (e) {}
      g.restore();
      map.addImage(id, g.getImageData(0, 0, cv.width, cv.height), { pixelRatio: ratio });
    });
  }
  function tintWater() {
    try { (map.getStyle().layers || []).forEach(function (l) { if (l.type === 'fill' && /water/.test(l.id) && !/pattern|shadow/.test(l.id)) map.setPaintProperty(l.id, 'fill-color', '#8ec5d8'); }); } catch (e) {}
  }
  function addLayers() {
    makeIcons(); tintWater();
    var pts = PLACES.filter(matches);
    if (map.getSource('slm')) { map.getSource('slm').setData(fc(pts)); return; }
    if (DATA.towns && !map.getSource('slm-towns')) {
      var dark = currentBase === 'hybrid';
      map.addSource('slm-towns', { type: 'geojson', data: { type: 'FeatureCollection', features: DATA.towns.map(function (t) { return { type: 'Feature', geometry: { type: 'Point', coordinates: [t.lon, t.lat] }, properties: { name: t.name } }; }) } });
      map.addLayer({ id: 'slm-town', type: 'symbol', source: 'slm-towns', minzoom: 8.5,
        layout: { 'text-field': ['get', 'name'], 'text-font': DATA.styles.fontBold, 'text-size': ['interpolate', ['linear'], ['zoom'], 9, 12, 13, 15],
          'text-letter-spacing': 0.06, 'text-transform': 'uppercase', 'text-anchor': 'bottom', 'text-offset': [0, -1.1],
          'text-allow-overlap': true, 'text-ignore-placement': true },   // a town name must never vanish behind a pin
        paint: { 'text-color': dark ? '#ffffff' : '#24403d', 'text-halo-color': dark ? 'rgba(8,22,21,.85)' : 'rgba(255,253,248,.95)', 'text-halo-width': 1.8 } });
    }
    map.addSource('slm', { type: 'geojson', data: fc(pts), cluster: true, clusterRadius: 38, clusterMaxZoom: 9 /* whole number only: supercluster */ });
    map.addLayer({ id: 'slm-cluster', type: 'circle', source: 'slm', filter: ['has', 'point_count'],
      paint: { 'circle-color': '#12302f', 'circle-opacity': 0.9, 'circle-stroke-color': 'rgba(251,250,247,.9)', 'circle-stroke-width': 3,
        'circle-radius': ['step', ['get', 'point_count'], 16, 10, 20, 30, 25] } });
    map.addLayer({ id: 'slm-cluster-n', type: 'symbol', source: 'slm', filter: ['has', 'point_count'],
      layout: { 'text-field': ['get', 'point_count_abbreviated'], 'text-size': 13, 'text-font': DATA.styles.fontBold }, paint: { 'text-color': '#fbfaf7' } });
    map.addLayer({ id: 'slm-halo', type: 'circle', source: 'slm', filter: ['!', ['has', 'point_count']],
      paint: { 'circle-radius': ['case', ['boolean', ['feature-state', 'sel'], false], 26, ['boolean', ['feature-state', 'hover'], false], 21, 0],
        'circle-color': ['get', 'color'], 'circle-opacity': 0.28, 'circle-stroke-width': ['case', ['boolean', ['feature-state', 'sel'], false], 2, 0], 'circle-stroke-color': ['get', 'color'] } });
    map.addLayer({ id: 'slm-pt', type: 'symbol', source: 'slm', filter: ['!', ['has', 'point_count']],
      layout: { 'icon-image': ['get', 'icon'], 'icon-size': ['interpolate', ['linear'], ['zoom'], 9, 0.72, 13, 0.92, 16, 1.05], 'icon-allow-overlap': true,
        'text-field': ['step', ['zoom'], '', 13.2, ['get', 'name']], 'text-font': DATA.styles.font, 'text-size': 12, 'text-offset': [0, 1.35], 'text-anchor': 'top', 'text-optional': true, 'text-max-width': 9 },
      paint: { 'text-color': '#13201f', 'text-halo-color': '#fbfaf7', 'text-halo-width': 1.6 } });
    map.on('click', 'slm-pt', function (e) { select(e.features[0].properties.id, { fly: false }); });
    map.on('mousemove', 'slm-pt', function (e) { map.getCanvas().style.cursor = 'pointer'; setHover(e.features[0].properties.id, true); });
    map.on('mouseleave', 'slm-pt', function () { map.getCanvas().style.cursor = ''; setHover(null); });
    map.on('click', 'slm-cluster', function (e) {
      var f = map.queryRenderedFeatures(e.point, { layers: ['slm-cluster'] })[0];
      map.getSource('slm').getClusterExpansionZoom(f.properties.cluster_id).then(function (z) { map.easeTo({ center: f.geometry.coordinates, zoom: z + 0.3, duration: reduceMotion ? 0 : 500 }); }).catch(function () {});
    });
    map.on('mouseenter', 'slm-cluster', function () { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'slm-cluster', function () { map.getCanvas().style.cursor = ''; });
    if (selectedId) setSel(byId[selectedId]);
  }

  // Justin's listings: grouped price tags (HTML buttons, so they work with a keyboard too)
  var groups = (function () {
    var out = [];
    LISTINGS.slice().sort(function (a, b) { return b.priceNum - a.priceNum; }).forEach(function (l) {
      var g = out.filter(function (x) { return miles(ll(x.items[0]), ll(l)) < 0.25; })[0];
      if (g) g.items.push(l); else out.push({ items: [l] });
    });
    return out;
  })();
  function short(n) { return n >= 1e6 ? '$' + (Math.round(n / 1e5) / 10).toString().replace(/\.0$/, '') + 'M' : '$' + Math.round(n / 1e3) + 'K'; }
  function buildHomeMarkers() {
    homeMarkers.forEach(function (m) { m.marker.remove(); }); homeMarkers = [];
    groups.forEach(function (g) {
      var first = g.items[0], el = document.createElement('button');
      el.type = 'button'; el.className = 'slm-tag';
      var min = Math.min.apply(null, g.items.map(function (x) { return x.priceNum; }));
      el.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="' + ICONS.homes + '"/></svg><span>' + (g.items.length > 1 ? g.items.length + ' lots · from ' + short(min) : short(first.priceNum)) + '</span>';
      el.setAttribute('aria-label', g.items.length > 1 ? g.items.length + ' of Justin\'s listings, from ' + short(min) + ', at ' + first.name.replace(/^Lot \d+ /i, '') : 'Justin\'s listing: ' + first.name + ', ' + first.price);
      el.addEventListener('click', function (e) { e.stopPropagation(); select(g.items.length > 1 && g.items.some(function (x) { return x.id === selectedId; }) ? nextIn(g) : first.id, { fly: true, from: el }); });
      var m = new maplibregl.Marker({ element: el, anchor: 'bottom', offset: [0, -2] }).setLngLat(ll(first)).addTo(map);
      homeMarkers.push({ marker: m, el: el, g: g });
    });
    updateHomeMarkers();
  }
  function nextIn(g) { var i = g.items.map(function (x) { return x.id; }).indexOf(selectedId); return g.items[(i + 1) % g.items.length].id; }
  function updateHomeMarkers() {
    // price tags never pile on top of each other: when two would overlap, the pricier one stays and the
    // other waits until you zoom in (every listing is still in the list). Keeps tap targets apart (WCAG 2.5.8).
    var kept = [];
    if (map) {   // keep tags clear of the map's own buttons too
      var mr = mapEl.getBoundingClientRect();
      $$('.maplibregl-ctrl-top-right, .slm-bases, .slm-reset', root).forEach(function (c) {
        var r = c.getBoundingClientRect(); if (!r.width) return;
        kept.push({ l: r.left - mr.left - 4, r: r.right - mr.left + 4, t: r.top - mr.top - 4, b: r.bottom - mr.top + 4 });
      });
    }
    homeMarkers.forEach(function (h) {
      var on = h.g.items.some(function (x) { return x.id === selectedId; });
      var vis = h.g.items.some(matches);
      if (vis && map) {
        var pt = map.project(ll(h.g.items[0])), wdt = 84, hgt = 30;
        var box = { l: pt.x - wdt / 2 - 12, r: pt.x + wdt / 2 + 12, t: pt.y - hgt - 12, b: pt.y + 12 };
        var hit = kept.some(function (k) { return !(box.r < k.l || box.l > k.r || box.b < k.t || box.t > k.b); });
        if (hit && !on) vis = false; else kept.push(box);
      }
      h.el.style.display = vis ? '' : 'none';
      h.el.classList.toggle('is-on', on);
    });
  }

  var selF = null, hovF = null;
  function fs(p, key, on) { if (!map || !p || p.cat === 'homes' || !map.getSource('slm')) return; try { map.setFeatureState({ source: 'slm', id: p.n }, (function () { var o = {}; o[key] = on; return o; })()); } catch (e) {} }
  function setSel(p) { if (selF) fs(selF, 'sel', false); selF = p; if (p) fs(p, 'sel', true); }
  function setHover(id, fromMap) {
    var p = id ? byId[id] : null;
    if (hovF) fs(hovF, 'hover', false); hovF = p; if (p) fs(p, 'hover', true);
    $$('.slm-row.is-hover').forEach(function (b) { b.classList.remove('is-hover'); });
    if (p) { var row = listEl.querySelector('[data-id="' + id + '"]'); if (row) row.classList.add('is-hover'); }
    if (fromMap && p && map && !mqMobile.matches) {
      if (!tip) tip = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 16, className: 'slm-tip' });
      tip.setLngLat(ll(p)).setHTML('<strong>' + esc(p.name) + '</strong><span>' + esc((CATS[p.cat] || {}).label) + ' · click for details</span>').addTo(map);
    } else if (tip) tip.remove();
  }

  var currentBase = 'hybrid';
  function setBase(base) {
    if (!map || base === currentBase) return;
    currentBase = base;
    $$('[data-slm-base]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-slm-base') === base)); });
    map.once('style.load', function () { addLayers(); addOverlay(); });
    map.setStyle(styleFor(base === 'hybrid' ? 'sat' : base), { diff: false }); // diff:true skips 'style.load' and drops our layers
    announce(base === 'map' ? 'Street map' : base === 'sat' ? 'Satellite photo' : 'Topographic map');
  }
  $$('[data-slm-base]').forEach(function (b) { b.addEventListener('click', function () { setBase(b.getAttribute('data-slm-base')); }); });

  function fail(msg) {
    root.classList.add('slm--nomap');
    var f = $('[data-slm-fallback]'); if (f) { f.hidden = false; $('[data-slm-fallback-msg]', f).textContent = msg; }
  }

  function refresh(fromFilter) {
    if (map && map.getSource('slm')) map.getSource('slm').setData(fc(PLACES.filter(matches)));
    updateHomeMarkers();
    renderList();
  }

  function initMap() {
    if (typeof maplibregl === 'undefined') return fail('The map could not load. Every place is still listed here.');
    if (maplibregl.supported && !maplibregl.supported()) return fail('This browser cannot draw the map. Every place is still listed here.');
    try {
      map = new maplibregl.Map({
        container: mapEl, style: styleFor('sat'), bounds: [[B[0], B[1]], [B[2], B[3]]], fitBoundsOptions: { padding: fitPad() },
        maxBounds: [[B[0] - 0.7, B[1] - 0.5], [B[2] + 0.7, B[3] + 0.5]], minZoom: 8, maxZoom: 18,
        cooperativeGestures: root.hasAttribute('data-coop'), attributionControl: { compact: true },
        dragRotate: false, pitchWithRotate: false, touchPitch: false
      });
    } catch (e) { return fail('The map could not start. Every place is still listed here.'); }
    window.SLM_MAP = map;
    map.touchZoomRotate.disableRotation();
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(new maplibregl.FullscreenControl({ container: root }), 'top-right');
    map.addControl(new maplibregl.ScaleControl({ unit: 'imperial' }), 'bottom-left');
    // start on 'style.load' (style parsed), not 'load' (waits for every tile) so pins show right away on slow connections
    var started = false;
    function onReady() {
      if (started) return; started = true;
      everLoaded = true; root.classList.remove('slm--nomap'); var f = $('[data-slm-fallback]'); if (f) f.hidden = true;
      addLayers(); addOverlay(); buildHomeMarkers(); renderList();
      map.once('dragstart', hideHint); map.once('zoomstart', function (e) { if (e && e.originalEvent) hideHint(); }); setTimeout(hideHint, 12000);
      map.once('idle', function () { refresh(); }); // re-send the pins once the map settles (first send can be dropped while tiles load)
      var c = mapEl.querySelector('canvas'); if (c) c.setAttribute('aria-label', 'Map of Smith Lake. Use the list of places to pick one with the keyboard.');
      var m = /place=([^&]+)/.exec(location.hash); if (m && byId[decodeURIComponent(m[1])]) select(decodeURIComponent(m[1]), { fly: true });
    }
    map.once('style.load', onReady);
    map.on('load', onReady);
    var mt; map.on('moveend', function () { updateHomeMarkers(); clearTimeout(mt); mt = setTimeout(function () { if (inView && detailEl.hidden) renderList(); }, 120); });
    var waited = 0, tick = setInterval(function () {
      if (everLoaded) return clearInterval(tick);
      if (document.visibilityState === 'visible') waited += 1;   // background tabs do not draw; do not count them
      if (waited >= 15) { clearInterval(tick); fail('The map pictures are not loading right now. Every place is still listed here.'); }
    }, 1000);
    document.addEventListener('fullscreenchange', function () {
      if (!map.cooperativeGestures) return;
      if (document.fullscreenElement) map.cooperativeGestures.disable(); else if (root.hasAttribute('data-coop')) map.cooperativeGestures.enable();
      setTimeout(function () { map.resize(); }, 50);
    });
  }

  // near me
  var nearBtn = $('[data-slm-near]');
  if (nearBtn) nearBtn.addEventListener('click', function () {
    if (!navigator.geolocation) { announce('Your browser cannot share its location.'); return; }
    nearBtn.setAttribute('aria-busy', 'true');
    navigator.geolocation.getCurrentPosition(function (pos) {
      nearBtn.removeAttribute('aria-busy');
      userPos = [pos.coords.longitude, pos.coords.latitude];
      var far = miles(userPos, [(B[0] + B[2]) / 2, (B[1] + B[3]) / 2]);
      if (map) {
        if (!map.getSource('slm-me')) {
          map.addSource('slm-me', { type: 'geojson', data: { type: 'Point', coordinates: userPos } });
          map.addLayer({ id: 'slm-me', type: 'circle', source: 'slm-me', paint: { 'circle-radius': 8, 'circle-color': '#0b5cad', 'circle-stroke-color': '#fff', 'circle-stroke-width': 3 } });
        } else map.getSource('slm-me').setData({ type: 'Point', coordinates: userPos });
        if (far < 30) { inView = false; if (viewToggle) viewToggle.checked = false; map.flyTo({ center: userPos, zoom: 12.5, duration: reduceMotion ? 0 : 900 }); }
      }
      renderList();
      announce(far < 30 ? 'Showing places nearest to you.' : 'You are about ' + Math.round(far) + ' miles from Smith Lake. Distances are now from you.');
    }, function () { nearBtn.removeAttribute('aria-busy'); announce('Location was not shared, so distances stay from the middle of the map.'); }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 });
  });

  var resetBtn = $('[data-slm-reset]');
  if (resetBtn) resetBtn.addEventListener('click', function () { if (map) map.fitBounds([[B[0], B[1]], [B[2], B[3]]], { padding: 30, duration: reduceMotion ? 0 : 700 }); });

  // "Show on map" links in the written guide
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('[data-slm-goto]'); if (!a) return;
    var id = a.getAttribute('data-slm-goto'); if (!byId[id]) return;
    e.preventDefault();
    root.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
    select(id, { fly: true, from: a });
  });

  syncChips();
  renderList();
  initMap();
})();
