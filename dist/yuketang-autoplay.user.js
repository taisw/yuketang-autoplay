// ==UserScript==
// @name         雨课堂·学堂在线 自动连播 v27 正式版（强制静音增强）
// @namespace    https://yuketang.cn
// @version      27.1.0
// @description  雨课堂/学堂在线自动连播：视频沿用 v21 已验证逻辑（videoId+1/node_id+1 硬跳、
//              播完或"已完成"立即 pause、60s 加载宽限、完成后等完成度达标才跳）；
//              图文/讨论/作业用 node_id 排序法跳到下一节（默认优先跳视频）；
//              强制静音（video+audio、动态元素 MutationObserver、play/loadedmetadata/volumechange 校正）；
//              播完最短等待默认 3s，非视频/空页跳过前等待默认 2s；章节列表缓存、面板 RAF 节流。
// @author       taisw
// @homepageURL  https://github.com/taisw/yuketang-autoplay
// @supportURL   https://github.com/taisw/yuketang-autoplay/issues
// @downloadURL  https://github.com/taisw/yuketang-autoplay/releases/latest/download/yuketang-autoplay.user.js
// @updateURL    https://github.com/taisw/yuketang-autoplay/releases/latest/download/yuketang-autoplay.user.js
// @match        *://*.yuketang.cn/ai-workspace/*
// @match        *://*.yuketang.cn/*video*
// @match        *://*.xuetangx.com/*video*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @grant        unsafeWindow
// @run-at       document-idle
// @license      MIT
// ==/UserScript==

(function () {
    'use strict';
    const w = unsafeWindow;
    const DEBUG = false;
    const log = (...a) => {
        if (DEBUG || a[0] === 'ERROR' || a[0] === 'v27正式启动' || a[0] === '跳转')
            console.log('%c[雨课堂·v27正式]', 'color:#00695c', ...a);
    };

    /* 配置 */
    const CFG = {
        muted:            GM_getValue('ykt.muted', true) === true,
        autoStep:         GM_getValue('ykt.autoStep', true) === true,
        threshold:        parseFloat(GM_getValue('ykt.threshold', 0.95)) || 0.95,
        targetCompletion: parseInt(GM_getValue('ykt.targetCompletion', 95), 10) || 95,
        endWait:          parseInt(GM_getValue('ykt.endWait', 3000), 10) || 3000,        // 播完最短等待 3s
        maxWait:          parseInt(GM_getValue('ykt.maxWait', 180000), 10) || 180000,
        stallLimit:       parseInt(GM_getValue('ykt.stallLimit', 8), 10) || 8,
        nonVideoWait:     parseInt(GM_getValue('ykt.nonVideoWait', 2000), 10) || 2000,    // 跳过前等待 2s
        preferVideo:      GM_getValue('ykt.preferVideo', true) === true,
        autoClean:        GM_getValue('ykt.autoClean', true) === true,
    };
    if (GM_getValue('ykt.endWait_default_written', 0) !== 27) {
        GM_setValue('ykt.endWait', 3000); CFG.endWait = 3000;
        GM_setValue('ykt.nonVideoWait', 2000); CFG.nonVideoWait = 2000;
        GM_setValue('ykt.endWait_default_written', 27);
    }

    const NO_VIDEO_TICKS  = 8;
    const LOAD_WAIT_TICKS = 40;
    const TYPES = 'video|exercise|forum|graph|homework|discussion';
    const CH_RE = new RegExp('/(' + TYPES + ')/\\d+');
    const sleep = ms => new Promise(r => setTimeout(r, ms));

    /* 页面工具 */
    const currentVideoId = () => { const m = location.pathname.match(/\/video\/(\d+)/); return m ? m[1] : null; };
    const currentNodeId  = () => new URLSearchParams(location.search).get('node_id');
    const currentResKey  = () => { const m = location.pathname.match(new RegExp('/(' + TYPES + ')/(\\d+)')); return m ? (m[1] + '/' + m[2]) : null; };
    const curPath        = () => location.pathname + location.search;
    const isChapterPage  = () => CH_RE.test(location.pathname) || !!currentNodeId();

    /* 已访问防重 */
    function getVisited() { try { return JSON.parse(GM_getValue('ykt_visited', '[]')); } catch (e) { return []; } }
    function markVisited(key) {
        if (!key) return;
        const v = getVisited();
        if (!v.includes(key)) { v.push(key); if (v.length > 400) v.shift(); GM_setValue('ykt_visited', JSON.stringify(v)); }
    }
    const visitedHas = url => { const m = url.match(CH_RE); return m ? getVisited().includes(m[0].slice(1)) : false; };

    /* 轻量清理（不动 localStorage） */
    async function softClean() {
        try { sessionStorage.clear(); } catch (e) {}
        try { if (w.caches && w.caches.keys) { const ks = await w.caches.keys(); await Promise.all(ks.map(k => w.caches.delete(k))); } } catch (e) {}
    }
    async function ensureCleanForThisVideo() {
        const vid = currentVideoId();
        if (!vid || !CFG.autoClean) return false;
        const k = 'ykt_cleaned_' + vid;
        if (GM_getValue(k, false)) return false;
        GM_setValue(k, Date.now());
        const backup = location.href;
        await softClean();
        log('视频', vid, '清理完成，重载中...');
        location.replace(backup);
        return true;
    }

    /* 完成度 */
    function readCompletionInfo() {
        let value = null, doneText = false;
        try {
            const v = document.querySelector('video');
            let scope = document.body;
            if (v) { let el = v.parentElement, found = null;
                for (let i = 0; i < 8 && el; i++) { if (el.innerText && /完成度/.test(el.innerText)) { found = el; break; } el = el.parentElement; }
                if (found) scope = found; }
            const text = scope.innerText || '';
            const m = text.match(/完成度[：:\s]*(\d+)\s*%/);
            if (m) value = parseInt(m[1], 10);
            if (/已完成/.test(text)) doneText = true;
        } catch (e) {}
        return { value, doneText };
    }
    const realProgress = v => (!v || !v.duration) ? 0 : Math.min(1, v.currentTime / v.duration);

    /* ===== 强制静音 ===== */
    let savedVolume = null;
    const _mutedSet = new WeakSet();
    function muteOneMedia(el) {
        try {
            if (el.tagName === 'VIDEO' || el.tagName === 'AUDIO') {
                if (!CFG.muted) return;
                if (savedVolume === null && !el.muted && el.volume > 0) savedVolume = el.volume;
                el.muted = true;
                try { el.volume = 0; } catch (e) {}
                if (!_mutedSet.has(el)) {
                    _mutedSet.add(el);
                    el.addEventListener('play', () => { if (CFG.muted) { el.muted = true; try { el.volume = 0; } catch (e) {} } });
                    el.addEventListener('loadedmetadata', () => { if (CFG.muted) { el.muted = true; try { el.volume = 0; } catch (e) {} } });
                    el.addEventListener('volumechange', () => { if (CFG.muted && (!el.muted || el.volume > 0)) { el.muted = true; try { el.volume = 0; } catch (e) {} } });
                }
            }
        } catch (e) {}
    }
    function muteAllMedia() {
        if (!CFG.muted) return;
        document.querySelectorAll('video,audio').forEach(muteOneMedia);
    }
    let mediaObserver = null;
    function startMediaObserver() {
        if (mediaObserver) return;
        mediaObserver = new MutationObserver(muts => {
            if (!CFG.muted) return;
            for (const mu of muts) if (mu.addedNodes && mu.addedNodes.length) {
                mu.addedNodes.forEach(n => {
                    if (n.nodeType !== 1) return;
                    if (n.tagName === 'VIDEO' || n.tagName === 'AUDIO') muteOneMedia(n);
                    else if (n.querySelectorAll) n.querySelectorAll('video,audio').forEach(muteOneMedia);
                });
            }
        });
        const root = document.documentElement || document.body;
        if (root) mediaObserver.observe(root, { childList: true, subtree: true });
    }
    function applyMute() {
        if (CFG.muted) { muteAllMedia(); startMediaObserver(); }
        else document.querySelectorAll('video,audio').forEach(el => {
            try { el.muted = false; if (savedVolume != null) el.volume = savedVolume; else if (el.volume === 0) el.volume = 1; } catch (e) {}
        });
    }
    function toggleMute() {
        CFG.muted = !CFG.muted;
        GM_setValue('ykt.muted', CFG.muted);
        applyMute();
        if (Panel.built && Panel.refs['p-mute'])
            Panel.refs['p-mute'].textContent = CFG.muted ? '🔇 取消强制静音' : '🔊 强制静音';
        log('静音 →', CFG.muted);
    }

    /* 上报 */
    function triggerNativeReport(v) {
        if (!v) return;
        try { v.dispatchEvent(new Event('timeupdate', { bubbles: true })); } catch (e) {}
        [v, w.player, w.videoPlayer, w.app].forEach(root => {
            try { if (root && typeof root.reportProgress === 'function') root.reportProgress(); } catch (e) {}
        });
    }

    /* 章节列表缓存 */
    let chaptersCache = null, chaptersCacheUrl = '';
    function findListContainer() {
        let best = null, bestCount = 0;
        for (const el of document.querySelectorAll('div,ul,ol,aside,nav,section')) {
            const links = el.querySelectorAll('a[href*="/video/"],a[href*="/exercise/"],a[href*="/forum/"],a[href*="/graph/"]');
            if (links.length > bestCount && links.length >= 2 && (el.textContent || '').length < 50000) { bestCount = links.length; best = el; }
        }
        return best;
    }
    function collectChapters() {
        if (chaptersCache && location.href === chaptersCacheUrl) return chaptersCache;
        const root = findListContainer() || document.body;
        const seen = new Set(); const out = [];
        root.querySelectorAll('a[href]').forEach(a => {
            const h = a.getAttribute('href') || '';
            if (!CH_RE.test(h)) return;
            const tm = h.match(new RegExp('/(' + TYPES + ')/(\\d+)'));
            const nm = h.match(/node_id=(\d+)/);
            const key = (tm ? tm[0] : '') + '|' + (nm ? nm[1] : '');
            if (seen.has(key)) return; seen.add(key);
            out.push({ href: h, type: tm ? tm[1] : '', resId: tm ? tm[2] : '', nodeId: nm ? Number(nm[1]) : null, text: (a.textContent || '').trim().slice(0, 18) });
        });
        chaptersCache = out; chaptersCacheUrl = location.href;
        log('collectChapters:', out.length);
        return out;
    }
    const invalidateCache = () => { chaptersCache = null; chaptersCacheUrl = ''; };

    /* 跳转策略 */
    function buildNextUrlForVideo() {
        let pathname = location.pathname;
        const q = new URLSearchParams(location.search);
        const re = /\/video\/(\d+)/;
        if (re.test(pathname)) pathname = pathname.replace(re, (m, id) => '/video/' + (Number(id) + 1));
        const nid = currentNodeId(); if (nid) q.set('node_id', String(Number(nid) + 1));
        const s = q.toString(); return pathname + (s ? '?' + s : '');
    }
    function nextByNodeId() {
        const cur = currentNodeId(); if (!cur) return null;
        const curN = Number(cur);
        const list = collectChapters().filter(c => c.nodeId && c.nodeId > curN);
        if (!list.length) return null;
        list.sort((a, b) => a.nodeId - b.nodeId);
        if (CFG.preferVideo) {
            const minNode = list[0].nodeId;
            const same = list.filter(c => c.nodeId === minNode);
            const v = same.find(c => c.type === 'video');
            return (v || same[0]).href;
        }
        return list[0].href;
    }
    function nextByListOrder() {
        const list = collectChapters(); if (list.length < 2) return null;
        const ck = currentResKey(); let idx = -1;
        if (ck) idx = list.findIndex(c => (c.type + '/' + c.resId) === ck);
        if (idx < 0) { const cn = currentNodeId(); if (cn) idx = list.findIndex(c => String(c.nodeId) === cn); }
        if (idx < 0) return null;
        for (let i = idx + 1; i < list.length; i++) if (!CFG.preferVideo || list[i].type === 'video') return list[i].href;
        return null;
    }
    function nextByStep() {
        const m = location.pathname.match(new RegExp('/(' + TYPES + ')/(\\d+)')); if (!m) return null;
        const base = Number(m[2]); const nid = currentNodeId();
        for (let s = 1; s <= 20; s++) {
            let pathname = location.pathname.replace(new RegExp('/(' + TYPES + ')/(\\d+)'),
                (CFG.preferVideo ? '/video/' : '/' + m[1] + '/') + (base + s));
            const q = new URLSearchParams(location.search);
            if (nid) q.set('node_id', String(Number(nid) + s));
            const url = pathname + (q.toString() ? '?' + q.toString() : '');
            if (url === curPath() || visitedHas(url)) continue;
            return url;
        }
        return null;
    }
    function goToUrl(url, from) { log('跳转[' + from + ']:', url); location.href = url; return true; }
    async function gotoNextVideo() {
        const v21 = buildNextUrlForVideo();
        if (v21 && v21 !== curPath() && !visitedHas(v21)) return goToUrl(v21, '视频推导(v21)');
        const byNode = nextByNodeId(); if (byNode && !visitedHas(byNode)) return goToUrl(byNode, 'node排序');
        const byStep = nextByStep(); if (byStep) return goToUrl(byStep, '递增');
        Panel.setTip('⚠ 找不到下一个视频，请手动'); return false;
    }
    async function gotoNextChapter() {
        const byNode = nextByNodeId(); if (byNode && !visitedHas(byNode)) return goToUrl(byNode, 'node排序');
        const byList = nextByListOrder(); if (byList && !visitedHas(byList)) return goToUrl(byList, '列表顺序');
        const byStep = nextByStep(); if (byStep) return goToUrl(byStep, '递增');
        Panel.setTip('⚠ 找不到下一节，请手动（可🔍诊断）'); return false;
    }
    const gotoNext = isVideo => isVideo ? gotoNextVideo() : gotoNextChapter();

    /* 诊断 */
    function scanList() {
        invalidateCache();
        const list = collectChapters(); const cn = currentNodeId();
        console.groupCollapsed('%c[雨课堂·v27正式] 诊断', 'color:#00695c');
        console.log('当前:', currentResKey(), 'node:', cn, '章节:', list.length);
        console.table(list.slice(0, 30).map((c, i) => ({ 序号: i, 类型: c.type, 资源: c.resId, node: c.nodeId, 文字: c.text, 当前: (cn && String(c.nodeId) === cn) ? '←' : '' })));
        console.log('node排序:', nextByNodeId() || '无', '| 列表:', nextByListOrder() || '无', '| 递增:', nextByStep() || '无');
        console.groupEnd();
        alert('章节:' + list.length + '\nnode排序:' + (nextByNodeId() ? '✓' : '✗') + ' | 列表:' + (nextByListOrder() ? '✓' : '✗') + ' | 递增:' + (nextByStep() ? '✓' : '✗'));
    }

    /* 等待并跳转 */
    async function waitAndGo(v, alreadyDone, myGen) {
        const start = Date.now(); let lastVal = null, stall = 0;
        while (gen === myGen) {
            const elapsed = Date.now() - start;
            const info = readCompletionInfo();
            if (info.value === lastVal) stall++; else stall = 0; lastVal = info.value;
            const minDone = elapsed >= CFG.endWait;
            const numOk = (info.value != null && info.value >= CFG.targetCompletion);
            const doneOk = info.doneText || alreadyDone;
            const stalled = stall >= CFG.stallLimit;
            const timeout = elapsed >= CFG.maxWait;
            Panel.update(realProgress(v), info.value, info.doneText);
            Panel.setTip((alreadyDone ? '✅ 已完成' : '✅ 播完') + '｜完成度 ' + (info.value != null ? info.value + '%' : '--') + (doneOk ? ' ✓' : '') + '｜已等 ' + Math.ceil(elapsed / 1000) + 's');
            if (minDone && (numOk || doneOk || stalled || timeout)) { log('满足跳转'); break; }
            triggerNativeReport(v);
            await sleep(2000);
        }
        if (gen === myGen && CFG.autoStep) await gotoNext(true);
    }
    async function skipStuckSection(reason, myGen) {
        log('跳过:', reason);
        const sec = Math.ceil(CFG.nonVideoWait / 1000);
        for (let i = sec; i > 0; i--) { if (gen !== myGen) return; Panel.setTip('⏭ ' + reason + '，' + i + 's 后跳...'); await sleep(1000); }
        if (gen === myGen && CFG.autoStep) await gotoNext(false);
    }

    /* 主循环 */
    let gen = 0, lastUrl = location.href, loopRunning = false;
    let finalized, lastReport, noVideoElTicks, loadWaitTicks, skipHandled, hasValidVideo = false;
    function resetState() { finalized = false; lastReport = 0; noVideoElTicks = 0; loadWaitTicks = 0; skipHandled = false; invalidateCache(); }

    async function mainLoop() {
        loopRunning = true;
        const myGen = gen; resetState();
        await sleep(1200);
        const rk = currentResKey(); if (rk) markVisited(rk);
        while (myGen === gen) {
            if (!isChapterPage()) { await sleep(2000); continue; }
            const v = document.querySelector('video');
            hasValidVideo = !!(v && v.duration && !isNaN(v.duration) && v.duration > 0);
            if (!v) {
                noVideoElTicks++;
                Panel.update(0, null, false);
                if (!skipHandled && noVideoElTicks >= NO_VIDEO_TICKS) { skipHandled = true; await skipStuckSection('非视频章节(图文/讨论/作业)', myGen); break; }
                Panel.setTip('📄 非视频章节检测 ' + noVideoElTicks + '/' + NO_VIDEO_TICKS);
                await sleep(1500); continue;
            }
            if (!hasValidVideo) {
                loadWaitTicks++;
                try { v.play().catch(() => {}); } catch (e) {}
                Panel.update(0, null, false);
                Panel.setTip('⏳ 视频加载中 ' + loadWaitTicks + '/' + LOAD_WAIT_TICKS + '...');
                if (loadWaitTicks >= LOAD_WAIT_TICKS && !skipHandled) { skipHandled = true; await skipStuckSection('视频加载超时/空页', myGen); break; }
                await sleep(1500); continue;
            }
            noVideoElTicks = 0; loadWaitTicks = 0;
            applyMute();
            if (v.paused && !v.ended) { try { v.play().catch(() => {}); } catch (e) {} }
            const p = realProgress(v); const info = readCompletionInfo();
            Panel.update(p, info.value, info.doneText);
            if (!finalized && info.doneText) { finalized = true; try { v.pause(); } catch (e) {} log('已完成，暂停跳转'); await waitAndGo(v, true, myGen); break; }
            if (!finalized && (p >= CFG.threshold || v.ended)) { finalized = true; try { v.pause(); } catch (e) {} log('播完，等完成度'); await waitAndGo(v, false, myGen); break; }
            if (Date.now() - lastReport >= 2000) { lastReport = Date.now(); triggerNativeReport(v); }
            await sleep(1500);
        }
        loopRunning = false;
        if (gen !== myGen) startLoopIfNeeded();
    }
    const startLoopIfNeeded = () => { if (!loopRunning) mainLoop(); };

    setInterval(() => {
        if (location.href !== lastUrl) {
            log('URL变化→', location.href); lastUrl = location.href; gen++;
            (async () => { if (await ensureCleanForThisVideo()) return; startLoopIfNeeded(); })();
        }
    }, 500);

    /* 面板 */
    const Panel = (() => {
        const ID = 'ykt-v27ga';
        let el = null; const refs = {}; let rafId = null, pending = null;
        function build() {
            if (el && document.getElementById(ID)) return;
            GM_addStyle(`#${ID}{position:fixed;right:12px;bottom:12px;z-index:2147483647;background:rgba(0,105,92,.97);color:#fff;padding:10px 12px;border-radius:8px;font:12px/1.6 system-ui,sans-serif;width:330px;box-shadow:0 2px 14px rgba(0,0,0,.3)} #${ID} b{color:#80cbc4} #${ID} .bar{height:6px;background:rgba(255,255,255,.25);border-radius:3px;overflow:hidden;margin:4px 0} #${ID} .fill{height:100%;background:#80cbc4;width:0;transition:width .3s} #${ID} button{display:block;width:100%;margin-top:6px;padding:5px 8px;cursor:pointer;border:none;background:#fff;color:#00695c;border-radius:4px} #${ID} .note{font-size:10px;color:#b2dfdb;margin-top:4px}`);
            el = document.createElement('div'); el.id = ID;
            el.innerHTML = `
                <div><b>雨课堂·v27 正式版</b> 强制静音</div>
                <div>资源:<b id="p-res">-</b> ｜ node:<b id="p-nid">-</b></div>
                <div>播放进度:<b id="p-val">0%</b></div>
                <div>完成度:<b id="p-pc">-</b> <span id="p-done" style="font-size:10px"></span></div>
                <div class="bar"><div class="fill" id="p-bar"></div></div>
                <div id="p-tip" style="font-size:11px">观看中...</div>
                <div class="note">🎬视频=v21硬跳｜📄非视频=node排序｜🔇强制静音含audio/动态video</div>
                <button id="p-mute">${CFG.muted ? '🔇 取消强制静音' : '🔊 强制静音'}</button>
                <button id="p-scan">🔍 章节诊断</button>
                <button id="p-ewbtn">⏱ 播完最短等待（${CFG.endWait / 1000}s）</button>
                <button id="p-nvbtn">📄 跳过前等待（${CFG.nonVideoWait / 1000}s）</button>
                <button id="p-tcbtn">🎯 目标完成度（${CFG.targetCompletion}%）</button>
                <button id="p-pvbtn">🎬 优先跳视频（${CFG.preferVideo ? '开' : '关'}）</button>
                <button id="p-next">▶ 立即跳下一节</button>
                <button id="p-auto">${CFG.autoStep ? '⏹ 停止自动连播' : '▶ 开启自动连播'}</button>
            `;
            (document.documentElement || document.body).appendChild(el);
            ['p-res','p-nid','p-val','p-pc','p-done','p-bar','p-tip','p-mute','p-scan','p-ewbtn','p-nvbtn','p-tcbtn','p-pvbtn','p-next','p-auto'].forEach(id => refs[id] = document.getElementById(id));
            const rk = currentResKey(); if (rk && refs['p-res']) refs['p-res'].textContent = rk;
            const nid = currentNodeId(); if (nid && refs['p-nid']) refs['p-nid'].textContent = nid;
            refs['p-mute'].onclick = toggleMute;
            refs['p-scan'].onclick = scanList;
            refs['p-ewbtn'].onclick = () => { const n = parseFloat(prompt('播完后最短等待秒？', CFG.endWait / 1000)); if (!isNaN(n) && n >= 0) { CFG.endWait = n * 1000; GM_setValue('ykt.endWait', CFG.endWait); } };
            refs['p-nvbtn'].onclick = () => { const n = parseFloat(prompt('跳过前等待秒？', CFG.nonVideoWait / 1000)); if (!isNaN(n) && n >= 0) { CFG.nonVideoWait = n * 1000; GM_setValue('ykt.nonVideoWait', CFG.nonVideoWait); } };
            refs['p-tcbtn'].onclick = () => { const n = parseInt(prompt('目标完成度%？', CFG.targetCompletion), 10); if (!isNaN(n) && n > 0 && n <= 100) { CFG.targetCompletion = n; GM_setValue('ykt.targetCompletion', n); } };
            refs['p-pvbtn'].onclick = () => { CFG.preferVideo = !CFG.preferVideo; GM_setValue('ykt.preferVideo', CFG.preferVideo); refs['p-pvbtn'].textContent = '🎬 优先跳视频（' + (CFG.preferVideo ? '开' : '关') + '）'; };
            refs['p-next'].onclick = () => gotoNext(hasValidVideo);
            refs['p-auto'].onclick = () => { CFG.autoStep = !CFG.autoStep; GM_setValue('ykt.autoStep', CFG.autoStep); refs['p-auto'].textContent = CFG.autoStep ? '⏹ 停止自动连播' : '▶ 开启自动连播'; };
        }
        function update(progress, pc, done) {
            if (!el) build();
            pending = { progress, pc, done };
            if (rafId) return;
            rafId = requestAnimationFrame(() => {
                rafId = null; if (!pending) return;
                const d = pending; pending = null;
                if (refs['p-val']) refs['p-val'].textContent = (d.progress != null ? (d.progress * 100).toFixed(1) + '%' : '--');
                if (refs['p-bar']) refs['p-bar'].style.width = Math.min(100, (d.progress || 0) * 100) + '%';
                if (refs['p-pc']) refs['p-pc'].textContent = (d.pc != null ? d.pc + '%' : '--');
                if (refs['p-done']) refs['p-done'].textContent = d.done ? '已完成✓' : '';
            });
        }
        function setTip(t) { if (!el) build(); if (refs['p-tip']) refs['p-tip'].textContent = t; }
        return { build, update, setTip, refs, get built() { return !!el; } };
    })();

    /* 启动 */
    async function init() {
        if (!isChapterPage()) { setTimeout(init, 2000); return; }
        if (await ensureCleanForThisVideo()) return;
        Panel.build();
        applyMute(); startMediaObserver();
        log('v27正式启动 | 资源', currentResKey(), '| node', currentNodeId(), '| 静音', CFG.muted);
        startLoopIfNeeded();
    }
    init();
})();
