// ==UserScript==
// @name         PPRGB Holder v24 (+3天净流入)
// @namespace    http://tampermonkey.net/
// @version      24
// @description  在LNFi订单列表/订单历史显示PPRGB持仓 + 近3天净流入流出
// @match        *://*.lnfi.network/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function() {
    'use strict';

    const API_HOLDER = 'https://api.lnfi.network/assets/api/getHolder';
    const API_ORDER  = 'https://api.lnfi.network/market/api/orderHistoryV1';
    const ASSET = 'rgb:od~ZUtqX-5IcDmgM-jUc~aDK-795lX_u-OSEUL0w-z3iYvxY';
    const TOTAL_SUPPLY = 21_000_000;

    let   WINDOW_H = 72;            // 统计窗口(小时)，默认3天
    const MAX_PAGES = 6;            // 6页 x 100单 = 600，覆盖高频地址
    const MAX_CONCURRENT = 4;       // 并发上限，避免触发限流
    const RETRY = 3;                // 失败重试次数
    const FLOW_TTL = 10 * 60 * 1000;

    const balCache  = new Map();
    const flowCache = new Map();

    // ── 并发队列 + 重试 ─────────────────────────────────────────────
    let active = 0;
    const queue = [];
    function pump() {
        while (active < MAX_CONCURRENT && queue.length) {
            const task = queue.shift();
            active++;
            task.run().then(task.resolve, task.reject)
                      .finally(() => { active--; pump(); });
        }
    }
    function enqueue(run) {
        return new Promise((resolve, reject) => { queue.push({run, resolve, reject}); pump(); });
    }
    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    async function postJSON(url, body) {
        let lastErr;
        for (let i = 0; i < RETRY; i++) {
            try {
                const r = await enqueue(() => fetch(url, {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify(body),
                    credentials: 'omit'
                }));
                if (!r.ok) throw new Error('HTTP ' + r.status);
                const j = await r.json();
                if (j && j.code !== undefined && j.code !== 0) throw new Error('API code ' + j.code);
                return j;
            } catch (e) {
                lastErr = e;
                if (i < RETRY - 1) await sleep(400 * (i + 1));
            }
        }
        throw lastErr;
    }

    // ── 样式 ────────────────────────────────────────────────────────
    function addStyles() {
        if (document.getElementById('pprgb-st-24')) return;
        const s = document.createElement('style');
        s.id = 'pprgb-st-24';
        s.textContent = `
.pprgb-h{display:inline-flex;align-items:center;margin-left:8px;font-size:11px;white-space:nowrap}
.pprgb-h span.a{font-weight:600}
.pprgb-h span.p{opacity:.7;margin-left:3px}
.pprgb-h.ld{opacity:.35;color:#888}
.pprgb-h.pprgb-none{color:#888;background:rgba(128,128,128,.15);border-radius:3px;padding:0 4px}
.pprgb-h.pprgb-gray{color:#999}
.pprgb-h.pprgb-white{color:#e0e0e0}
.pprgb-h.pprgb-green{color:#4caf50}
.pprgb-h.pprgb-yellow{color:#ffca28}
.pprgb-h.pprgb-orange{color:#ff9800}
.pprgb-f{display:inline-flex;margin-left:5px;font-size:11px;font-weight:700;white-space:nowrap;cursor:help}
.pprgb-f.up{color:#26a69a}
.pprgb-f.dn{color:#ef5350}
.pprgb-f.zero{color:#777;opacity:.55}
.pprgb-f.err{color:#b0bec5;opacity:.8}
.pprgb-f.ld{color:#888;opacity:.3}
        `;
        document.head.appendChild(s);
    }

    // ── bech32 解码 (npub/note → hex) ──────────────────────────────
    const B32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
    const B32V = {};
    for (let i = 0; i < B32.length; i++) B32V[B32[i]] = i;

    function bech32Decode(str) {
        const sep = str.indexOf('1');
        if (sep < 1 || sep + 7 > str.length) return null;
        const data = str.slice(sep + 1);
        const vals = [];
        for (const ch of data) {
            const v = B32V[ch];
            if (v === undefined) return null;
            vals.push(v);
        }
        const payload = vals.slice(0, -6);
        const bytes = [];
        let acc = 0, bits = 0;
        for (const v of payload) {
            acc = (acc << 5) | v;
            bits += 5;
            while (bits >= 8) { bits -= 8; bytes.push((acc >> bits) & 0xff); }
        }
        while (bytes.length > 32 && bytes[bytes.length - 1] === 0) bytes.pop();
        if (bytes.length < 32) return null;
        return bytes.slice(0, 32).map(b => b.toString(16).padStart(2, '0')).join('');
    }

    // ── React fiber 提取完整地址 ────────────────────────────────────
    function extractFullAddr(btn) {
        if (!btn) return null;
        const fk = Object.keys(btn).find(k => k.startsWith('__reactFiber'));
        if (!fk) return null;
        let f = btn[fk];
        for (let d = 0; d < 25 && f; d++) {
            const p = f.memoizedProps || f.pendingProps || {};
            const t = p.text || p.title;
            if (typeof t === 'string' && (t.startsWith('npub1') || t.startsWith('note1'))) return t;
            f = f.return;
        }
        return null;
    }

    // ── 持仓 ────────────────────────────────────────────────────────
    async function getHolder(addr) {
        if (balCache.has(addr)) return balCache.get(addr);
        try {
            const hex = bech32Decode(addr) || addr;
            const j = await postJSON(API_HOLDER, {owner: hex, assetId: ASSET});
            const balance = parseInt(j?.data?.data?.balance || j?.data?.balance || 0);
            const res = {balance, pct: (balance / TOTAL_SUPPLY * 100).toFixed(3)};
            balCache.set(addr, res);
            return res;
        } catch (e) {
            return null;                    // 失败不缓存，下次重试
        }
    }

    // ── 近 N 小时净流入（买入 - 卖出）──────────────────────────────
    async function getFlow(hex) {
        const now = Date.now();
        const c = flowCache.get(hex);
        if (c && now - c.t < FLOW_TTL && c.h === WINDOW_H) return c.v;

        const win = WINDOW_H * 3600 * 1000;
        let net = 0, buy = 0, sell = 0, nBuy = 0, nSell = 0, outOfWindow = false;

        for (let page = 1; page <= MAX_PAGES && !outOfWindow; page++) {
            const j = await postJSON(API_ORDER, {
                token: 'PPRGB', type: '', status: 'SUCCESS',   // 严格单币种，避免他币占满分页
                address: hex, eventId: '', page: page, count: 100
            });
            const pos = j?.data?.orderPOS || [];
            if (!pos.length) break;

            for (const o of pos) {
                if (o.token_address !== ASSET) continue;          // 只看 PPRGB
                // 服务端时间戳是 UTC 且无时区后缀，必须补 Z，否则按本地时区解析会偏移
                const t = Date.parse((o.modify_time || o.create_time) + 'Z');
                if (isNaN(t)) continue;
                if (now - t > win) { outOfWindow = true; continue; }  // 倒序，后面更旧
                const v = o.deal_volume || o.volume || 0;
                if (o.type === 'BUY') { buy += v; net += v; nBuy++; }
                else                  { sell += v; net -= v; nSell++; }
            }
            if (pos.length < 100) break;
        }

        const v = {net, buy, sell, nBuy, nSell};
        flowCache.set(hex, {t: now, v, h: WINDOW_H});
        return v;
    }

    function fmt(n) { return n >= 1000 ? (n / 1000).toFixed(1) + 'K' : String(n); }

    function fmtFlow(n) {
        if (!n) return '0';
        const s = n > 0 ? '+' : '-';
        const a = Math.abs(n);
        if (a >= 1e6) return s + (a / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
        if (a >= 1000) return s + (a / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
        return s + a;
    }

    function colorCls(b) {
        if (b < 2100) return 'pprgb-gray';
        if (b < 5000) return 'pprgb-white';
        if (b < 10000) return 'pprgb-green';
        if (b < 50000) return 'pprgb-yellow';
        return 'pprgb-orange';
    }

    function wLabel() { return WINDOW_H % 24 === 0 ? (WINDOW_H / 24) + '天' : WINDOW_H + 'h'; }

    // ── 注入标签 ────────────────────────────────────────────────────
    function injectTag(anchor, addr) {
        const cell = anchor.closest('td') || anchor.parentElement;
        if (!cell || cell.querySelector('.pprgb-h')) return false;

        const tag = document.createElement('span');
        tag.className = 'pprgb-h ld';
        tag.textContent = '⏳';
        if (anchor.nextSibling) cell.insertBefore(tag, anchor.nextSibling);
        else cell.appendChild(tag);

        const flow = document.createElement('span');
        flow.className = 'pprgb-f ld';
        flow.textContent = '·';
        if (tag.nextSibling) cell.insertBefore(flow, tag.nextSibling);
        else cell.appendChild(flow);

        const hex = bech32Decode(addr) || addr;

        getHolder(addr).then(h => {
            if (!h || h.balance === 0) {
                tag.className = 'pprgb-h pprgb-none';
                tag.textContent = '0 PP';
            } else {
                tag.className = 'pprgb-h ' + colorCls(h.balance);
                tag.innerHTML = '<span class="a">' + fmt(h.balance) + '</span> PP <span class="p">' + h.pct + '%</span>';
            }
        }).catch(() => {
            tag.className = 'pprgb-h pprgb-none';
            tag.textContent = '?';
        });

        getFlow(hex).then(f => {
            if (f.net > 0)      flow.className = 'pprgb-f up';
            else if (f.net < 0) flow.className = 'pprgb-f dn';
            else                flow.className = 'pprgb-f zero';
            flow.textContent = fmtFlow(f.net);
            flow.title = `${wLabel()}净流入 ${fmtFlow(f.net)}\n买入 ${f.buy} (${f.nBuy}单)\n卖出 ${f.sell} (${f.nSell}单)`;
        }).catch(() => {
            flow.className = 'pprgb-f err';      // 查询失败，不是 0
            flow.textContent = '?';
            flow.title = '净流入查询失败（网络/限流），非真实数值';
        });

        return true;
    }

    // ── 扫描 ────────────────────────────────────────────────────────
    let scanning = false;

    function scanPage() {
        if (scanning) return 0;
        scanning = true;
        let injected = 0;
        try {
            const svgs = document.querySelectorAll('svg[data-icon="copy"]');
            for (const svg of svgs) {
                try {
                    const btn = svg.closest('button');
                    if (!btn) continue;
                    const addr = extractFullAddr(btn);
                    if (!addr || !addr.startsWith('npub1')) continue;   // 只要卖家地址
                    const cell = btn.closest('td');
                    if (!cell || cell.querySelector('.pprgb-h')) continue;

                    let anchor = null;
                    for (const s of cell.querySelectorAll('span')) {
                        if (s.textContent.trim().startsWith('npub1')) { anchor = s; break; }
                    }
                    if (!anchor) continue;
                    if (injectTag(anchor, addr)) injected++;
                } catch (e) { /* 单条失败不影响其他 */ }
            }
        } finally {
            scanning = false;
        }
        return injected;
    }

    // ── 启动（静默）─────────────────────────────────────────────────
    addStyles();
    scanPage();
    [600, 1800].forEach(d => setTimeout(scanPage, d));

    let timer = null;
    new MutationObserver(() => {
        if (scanning) return;
        clearTimeout(timer);
        timer = setTimeout(scanPage, 400);
    }).observe(document.body, {childList: true, subtree: true});

    window.addEventListener('hashchange', () => setTimeout(scanPage, 600));

    window.__pprgb24_scan = scanPage;
    window.__pprgb24_status = () => ({
        window: wLabel(),
        buttons: document.querySelectorAll('svg[data-icon="copy"]').length,
        tags: document.querySelectorAll('.pprgb-h').length,
        flows: document.querySelectorAll('.pprgb-f').length,
        errors: document.querySelectorAll('.pprgb-f.err, .pprgb-h.pprgb-none').length,
        loading: document.querySelectorAll('.pprgb-h.ld').length,
        balCache: balCache.size,
        flowCache: flowCache.size
    });
    window.__pprgb24_query = async addr => {
        const hex = bech32Decode(addr) || addr;
        const f = await getFlow(hex);
        return {hex, ...f};
    };
    window.__pprgb24_setWindow = h => {
        WINDOW_H = h; flowCache.clear();
        document.querySelectorAll('.pprgb-f').forEach(e => e.remove());
        document.querySelectorAll('.pprgb-h').forEach(e => e.remove());
        scanPage();
        return wLabel();
    };
    window.__pprgb24_window = () => wLabel();
})();
