// worker-m3u8.js

/* =========================
 * CẤU HÌNH NGUỒN
 * ========================= */
const SRC = {
    HLS_ORG: "https://raw.githubusercontent.com/tchiphuong/miscmisc/refs/heads/master/hls.json",
    HLS_MERGE: "https://api.npoint.io/39fe20f4c3372eb4a5b6",
    MPD: "https://api.npoint.io/585245f37ac451ea70f4",
    KLINH: "https://raw.githubusercontent.com/vuminhthanh12/vuminhthanh12/refs/heads/main/khanhlinh",
    KPLUS: "https://raw.githubusercontent.com/vuminhthanh12/vuminhthanh12/refs/heads/main/kplusvip",
    VMTTV: "https://raw.githubusercontent.com/vuminhthanh12/vuminhthanh12/refs/heads/main/vmttv",
    DAKLAK: "https://raw.githubusercontent.com/tranchiquan2017/DAKLAK_RADIO/refs/heads/main/DAKLAKIPTV",
    SPORT: "https://raw.githubusercontent.com/mimipipi22/lalajo/refs/heads/main/playlist25",
    ACESTREAM: "https://raw.githubusercontent.com/dovietsy/acestreamfb/main/acestreamfb.txt",
};

// Timeout & Retry cho fetch nguồn
const FETCH_TIMEOUT_MS = 7000;
const FETCH_RETRY = 1; // retry 1 lần nếu lỗi/timeout

/* =========================
 * WORKER ENTRY: CHỈ GỌI HÀM
 * ========================= */
// export default {
//     async fetch(request, env, ctx) {
//         return handleRequest(request, env, ctx);
//     },
// };

/* =========================
 * HÀM XỬ LÝ CHÍNH
 * ========================= */
async function handleRequest(request, env, ctx) {
    try {
        // 1) LẤY DỮ LIỆU NGUỒN (đã tách riêng)
        const {
            hlsOrg,
            hlsMerge,
            mpdData,
            kplusText,
            klplusText,
            vmtText,
            daklakText,
            aceStreamText,
            sportText,
        } = await fetchAllSources();

        // 2) PARSE M3U (đã tách parse riêng) + GOM NGUỒN
        const [kchannel, klchannel, vchannel, dchannel, aceStreamChannel, sportChannel] =
            await Promise.all([
                parseM3U(kplusText),
                parseM3U(klplusText),
                parseM3U(vmtText),
                parseM3U(daklakText),
                parseM3U(aceStreamText),
                parseM3U(sportText),
            ]);

        let merged = [
            ...toArr(hlsOrg),
            ...toArr(klchannel),
            ...toArr(kchannel),
            ...toArr(vchannel),
            ...toArr(dchannel),
            ...toArr(aceStreamChannel),
            ...toArr(hlsMerge),
            ...toArr(sportChannel),
        ];

        // 3) CHUẨN HÓA + DEDUPE (O(n))
        merged = normalizeGroups(merged);
        merged = moveDuplicateChannels(merged);

        console.log(merged);
        return merged;

        // 4) STREAM M3U8
        const body = streamM3U(merged);
        const headers = {
            "Content-Type": "text/plain; charset=utf-8",
            //'Content-Disposition': `inline; filename="playlist_${new Date().toISOString()}.m3u8"`,
            //'Cache-Control': 'max-age=60',  // cache ngắn để cập nhật kịp
            "Access-Control-Allow-Origin": "*",
        };

        const resp = new Response(body, { status: 200, headers });

        return resp;
    } catch (err) {
        console.error("Worker error:", err);
        return new Response(
            `#EXTM3U url-tvg="https://vnepg.site/epg.xml.gz"
      #EXTINF:-1 tvg-id="vtv1hd" group-title="VTV" tvg-logo="https://i.imgur.com/nfkmvAY.png",VTV1
      https://vng-live-cdn.seenow.vn/livesnv2/VTV1_HD/manifest.mpd`,
            {
                status: 500,
                headers: {
                    "Content-Type": "text/plain; charset=utf-8",
                    "Access-Control-Allow-Origin": "*",
                },
            }
        );
    }
}

/* =========================
 * FETCH LAYER (TÁCH RIÊNG)
 * ========================= */

// Gọi tất cả nguồn (song song, có timeout + retry)
async function fetchAllSources() {
    const [
        hlsOrg,
        hlsMerge,
        mpdData,
        klplusText,
        kplusText,
        vmtText,
        daklakText,
        aceStreamText,
        sportText,
    ] = await Promise.all([
        // @ts-ignore
        fetchWithPolicy(SRC.HLS_ORG, { as: "json" }),
        // @ts-ignore
        fetchWithPolicy(SRC.HLS_MERGE, { as: "json" }),
        // @ts-ignore
        fetchWithPolicy(SRC.MPD, { as: "json" }),
        fetchWithPolicy(SRC.KLINH),
        fetchWithPolicy(SRC.KPLUS),
        fetchWithPolicy(SRC.VMTTV),
        fetchWithPolicy(SRC.DAKLAK),
        fetchWithPolicy(SRC.ACESTREAM),
        fetchWithPolicy(SRC.SPORT),
    ]);

    return {
        hlsOrg,
        hlsMerge,
        mpdData,
        klplusText,
        kplusText,
        vmtText,
        daklakText,
        aceStreamText,
        sportText,
    };
}

// One-shot fetch (timeout + retry + auto parse)
// as: 'json' | 'text' | 'arrayBuffer' | 'auto' (mặc định auto theo Content-Type)
async function fetchWithPolicy(
    url,
    {
        as = "auto",
        // @ts-ignore
        init,
        timeoutMs = typeof FETCH_TIMEOUT_MS !== "undefined" ? FETCH_TIMEOUT_MS : 7000,
        retry = typeof FETCH_RETRY !== "undefined" ? FETCH_RETRY : 1,
    } = {}
) {
    const parseBody = async (res) => {
        if (as === "json") return res.json();
        if (as === "text") return res.text();
        if (as === "arrayBuffer") return res.arrayBuffer();
        // auto
        const ct = (res.headers.get("content-type") || "").toLowerCase();
        return ct.includes("json") ? res.json() : res.text();
    };

    for (let attempt = 0; attempt <= retry; attempt++) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
            const res = await fetch(url, { ...(init || {}), signal: ctrl.signal });
            if (!res.ok) {
                // Lỗi HTTP → không retry (thường retry vô ích)
                throw new Error(`HTTP ${res.status} at ${url}`);
            }
            return await parseBody(res);
        } catch (err) {
            // Hết retry thì quăng lỗi
            if (attempt === retry) {
                if (err.name === "AbortError")
                    throw new Error(`Timeout after ${timeoutMs}ms: ${url}`);
                throw err;
            }
            // HTTP lỗi thì không retry
            if (typeof err?.message === "string" && /^HTTP \d+/.test(err.message)) throw err;

            // Nhẹ nhàng backoff 100*attempt ms (0,100,200…)
            await new Promise((r) => setTimeout(r, 100 * attempt));
            continue;
        } finally {
            clearTimeout(timer);
        }
    }
}

/* =========================
 * PARSER & BUILDERS
 * ========================= */

// =========================
// OTT Parser nâng cao -> chuyển về cấu trúc cũ
// =========================

/**
 * parseOttNavigationFast(m3uText, opts)
 * - Output: { groups: [{ name, logo?, sortOrder?, channels: [{ id, name, logo?, group, tags: string[], sources: [...] }] }] }
 */
function parseOttNavigationFast(m3uText, opts = {}) {
    const groupLogos = opts.groupLogos || null;
    const groupSortOrder = opts.groupSortOrder || null;

    // ======= Maps & helpers cơ bản =======
    const groupsMap = new Map(); // name -> {name, logo?, sortOrder?, channels:[]}
    const channelIndex = new Map(); // key: group + \u0001 + (tvgId || tvgName/display)

    const trim = (s) => (s && s.trim()) || "";
    const unq = (s) => (s && s[0] === '"' && s[s.length - 1] === '"' ? s.slice(1, -1) : s);
    const lc = (s) => (s ? s.toLowerCase() : s);

    const chKey = (grp, tvgId, tvgName, display) =>
        grp + "\u0001" + (tvgId ? lc(tvgId) : lc(tvgName || display || ""));

    function looksLikeUrlLine(raw) {
        if (!raw || raw[0] === "#") return false;
        const bar = raw.indexOf("|");
        const s = (bar >= 0 ? raw.slice(0, bar) : raw).trim();
        if (s.length < 8) return false;
        if (!s.includes("/") && !s.includes("\\")) return false;
        const lower = s.toLowerCase();
        if (s.startsWith("//")) return true;
        if (lower.startsWith("http://") || lower.startsWith("https://")) return true;
        if (
            lower.startsWith("rtmp://") ||
            lower.startsWith("rtsp://") ||
            lower.startsWith("rtsps://")
        )
            return true;
        if (lower.startsWith("srt://") || lower.startsWith("udp://")) return true;
        if (s.startsWith("/") || s.startsWith("./") || /^[A-Za-z]:\\\\/.test(s)) return true;
        if (/\.(m3u8|mpd)(\?|$)/i.test(s)) return true;
        return false;
    }

    const detectType = (url) => {
        const u = lc(url);
        if (u.endsWith(".m3u8") || u.includes(".m3u8?")) return "hls";
        if (u.endsWith(".mpd") || u.includes(".mpd?")) return "dash";
        return "hls"; // mặc định là HLS
    };

    // Dòng URL dạng comment/noise: toàn ký tự dấu, hoặc // không phải URL hợp lệ
    function isCommentishLine(s0) {
        const s = (s0 || "").trim();
        if (!s) return true;
        if (/^[\/\\#\-= _|.]{6,}$/i.test(s)) return true;
        if (
            s.startsWith("//") &&
            !(/[a-z0-9-]+\.[a-z]{2,}/i.test(s) || /\.(m3u8|mpd)(\?|$)/i.test(s))
        )
            return true;
        return false;
    }
    function isNoiseText(s0) {
        const s = (s0 || "").trim();
        return !!s && /^[\/\\#\-= _|.]{6,}$/i.test(s);
    }

    function splitPipeHeaders(url) {
        const p = url.indexOf("|");
        if (p < 0) return { cleanUrl: url, headers: null };
        const base = url.slice(0, p);
        const tail = url.slice(p + 1);
        const headers = Object.create(null);
        let i = 0,
            key = "",
            val = "",
            mode = 0;
        const push = () => {
            if (!key) return;
            const k = key.toLowerCase();
            const v = decodeURIComponent(val || "");
            if (k === "user-agent" || k === "useragent") headers["User-Agent"] = v;
            else if (k === "referer" || k === "referrer") headers["Referer"] = v;
            else if (k === "origin") headers["Origin"] = v;
            else if (k === "cookie") headers["Cookie"] = v;
            else headers[key] = v;
        };
        while (i <= tail.length) {
            const c = tail[i] || "&";
            if (mode === 0) {
                if (c === "=") mode = 1;
                else if (c === "&") {
                    key = "";
                    val = "";
                } else key += c;
            } else {
                if (c === "&") {
                    push();
                    key = "";
                    val = "";
                    mode = 0;
                } else val += c;
            }
            i++;
        }
        return { cleanUrl: base, headers: Object.keys(headers).length ? headers : null };
    }

    function parseExtinf(line) {
        const comma = line.lastIndexOf(",");
        const displayName = comma >= 0 ? trim(line.slice(comma + 1)) : "";
        const attrPart = comma >= 0 ? line.slice(0, comma) : line;

        const attrs = Object.create(null);
        let i = 0,
            k = "",
            v = "",
            inKey = true,
            inQuote = false,
            reading = false;

        if (attrPart.startsWith("#EXTINF:")) i = 8;
        while (i < attrPart.length && attrPart[i] !== " ") i++;
        while (i < attrPart.length && attrPart[i] === " ") i++;

        for (; i < attrPart.length; i++) {
            const c = attrPart[i];
            if (inKey) {
                if (c === "=") {
                    inKey = false;
                    continue;
                }
                if (c === " ") {
                    k = "";
                    continue;
                }
                k += c;
            } else {
                if (!reading && c === '"') {
                    inQuote = true;
                    reading = true;
                    v = "";
                    continue;
                }
                if (inQuote) {
                    if (c === '"') {
                        attrs[k] = v;
                        inKey = true;
                        reading = false;
                        inQuote = false;
                        k = "";
                        v = "";
                    } else v += c;
                } else {
                    if (c === " ") {
                        attrs[k] = v;
                        inKey = true;
                        reading = false;
                        k = "";
                        v = "";
                    } else v += c;
                }
            }
        }
        if (k && v && !attrs[k]) attrs[k] = v;
        return { attrs, displayName };
    }

    function extractBitrate(s0) {
        const s = (s0 || "").toLowerCase();
        let m = s.match(/(\d+(?:\.\d+)?)\s*m[pb]?bs/);
        if (m) return Math.round(parseFloat(m[1]) * 1000);
        m = s.match(/(\d{3,6})\s*k(?:bps|b?s)?/);
        if (m) return parseInt(m[1], 10);
        m = s.match(/(\d+(?:\.\d+)?)\s*m(?![a-z])/);
        if (m) return Math.round(parseFloat(m[1]) * 1000);
        m = s.match(/[?&](?:bw|br|bitrate|vb|rate)=(\d{3,6})\b/);
        if (m) return parseInt(m[1], 10);
        return null;
    }
    const mapBitrate = (kbps) => {
        const mbps = (kbps || 0) / 1000;
        if (mbps >= 8) return { quality: "UHD", rank: 4, mbps };
        if (mbps >= 3) return { quality: "FHD", rank: 3, mbps };
        if (mbps >= 1.5) return { quality: "HD", rank: 2, mbps };
        return { quality: "SD", rank: 1, mbps };
    };

    function toHex(buf) {
        return Array.from(buf)
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("");
    }
    function fromBase64ToHex(b64) {
        try {
            // @ts-ignore
            if (typeof Buffer !== "undefined") return toHex(Buffer.from(b64, "base64"));
            const bin = atob(b64.replace(/-/g, "+").replace(/_/g, "/"));
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            return toHex(bytes);
        } catch {
            return null;
        }
    }
    function parseClearKey(licenseKeyRaw) {
        const raw = (licenseKeyRaw || "").trim();
        if (/^https?:\/\//i.test(raw)) return { licenseServer: raw };
        if (raw.startsWith("{") || raw.startsWith("[")) {
            try {
                const obj = JSON.parse(raw);
                const arr = Array.isArray(obj) ? obj : obj.keys || [];
                const keys = arr
                    .map((k) => {
                        const kidHex = /^[0-9a-fA-F-]{32,36}$/.test(k.kid || "")
                            ? (k.kid || "").toLowerCase().replace(/-/g, "")
                            : fromBase64ToHex(k.kid || "") || "";
                        const keyHex = /^[0-9a-fA-F]{32}$/.test(k.k || "")
                            ? (k.k || "").toLowerCase()
                            : fromBase64ToHex(k.k || "") || "";
                        return kidHex && keyHex ? { kid: kidHex, key: keyHex } : null;
                    })
                    .filter(Boolean);
                if (keys.length) return { keys };
            } catch {}
        }
        if (/kid\s*=|key\s*=|;/i.test(raw)) {
            const pairs = raw
                .replace(/[|;,]/g, "&")
                .split("&")
                .map((s) => s.trim())
                .filter(Boolean);
            let kid = "",
                key = "";
            for (const p of pairs) {
                const i = p.indexOf("=");
                if (i < 0) continue;
                const k = p.slice(0, i).trim().toLowerCase();
                const v = decodeURIComponent(p.slice(i + 1).trim());
                if (k === "kid" || k === "id") kid = v;
                else if (k === "k" || k === "key") key = v;
            }
            if (kid && key) {
                let kidHex = kid.toLowerCase().replace(/-/g, "");
                if (!/^[0-9a-f]{32}$/i.test(kidHex)) kidHex = fromBase64ToHex(kid) || kidHex;
                let keyHex = key.toLowerCase();
                if (!/^[0-9a-f]{32}$/i.test(keyHex)) keyHex = fromBase64ToHex(key) || keyHex;
                if (/^[0-9a-f]{32}$/i.test(kidHex) && /^[0-9a-f]{32}$/i.test(keyHex)) {
                    return { keys: [{ kid: kidHex, key: keyHex }] };
                }
            }
        }
        const colon = raw.indexOf(":");
        if (colon > 0) {
            let left = raw.slice(0, colon).trim();
            let right = raw.slice(colon + 1).trim();
            let kidHex = left.toLowerCase().replace(/-/g, "");
            if (!/^[0-9a-f]{32}$/i.test(kidHex)) kidHex = fromBase64ToHex(left) || kidHex;
            let keyHex = right.toLowerCase();
            if (!/^[0-9a-f]{32}$/i.test(keyHex)) keyHex = fromBase64ToHex(right) || keyHex;
            if (/^[0-9a-f]{32}$/i.test(kidHex) && /^[0-9a-f]{32}$/i.test(keyHex)) {
                return { keys: [{ kid: kidHex, key: keyHex }] };
            }
        }
        return { raw };
    }

    let lastGroup = undefined;
    let pending_extinf = null;
    let pending_kodi = Object.create(null);
    let pending_vlc = Object.create(null);

    function ensureGroup(name) {
        let g = groupsMap.get(name);
        if (!g) {
            g = {
                name,
                logo: (groupLogos && groupLogos[name]) || undefined,
                sortOrder: (groupSortOrder && groupSortOrder[name]) || undefined,
                channels: [],
            };
            groupsMap.set(name, g);
        }
        return g;
    }

    function commitToUrl(url) {
        // Bỏ qua nếu là dòng comment/noise ngụy dạng URL
        if (isCommentishLine(url)) {
            pending_extinf = null;
            pending_kodi = Object.create(null);
            pending_vlc = Object.create(null);
            return;
        }
        const at = (pending_extinf && pending_extinf.attrs) || {};
        const groupName = at["group-title"] ? unq(at["group-title"]) : lastGroup || "Khác";
        const group = ensureGroup(groupName);

        const tvgId = at["tvg-id"] ? unq(at["tvg-id"]) : "";
        const tvgName = at["tvg-name"] ? unq(at["tvg-name"]) : "";
        const tvgLogo = at["tvg-logo"] ? unq(at["tvg-logo"]) : "";
        const display = (pending_extinf && pending_extinf.displayName) || tvgName || tvgId || url;

        const key = chKey(groupName, tvgId, tvgName, display);
        let ch = channelIndex.get(key);
        if (!ch) {
            ch = {
                id: tvgId || (tvgName ? lc(tvgName).replace(/\s+/g, "") : display),
                name: tvgName || display,
                logo: tvgLogo || undefined,
                sources: [],
            };
            group.channels.push(ch);
            channelIndex.set(key, ch);
        } else {
            if (tvgLogo && !ch.logo) ch.logo = tvgLogo;
        }

        const { cleanUrl, headers: pipeHeaders } = splitPipeHeaders(url);

        let typeGuess = detectType(cleanUrl);
        if (pending_kodi && pending_kodi["inputstream.adaptive.license_type"]) {
            const lt = lc(pending_kodi["inputstream.adaptive.license_type"]);
            typeGuess = lt.includes("apple.fps") ? "hls" : "dash";
        }
        const src = { url: cleanUrl, type: typeGuess };

        const br =
            (function extractBitrate(s0) {
                const s = (s0 || "").toLowerCase();
                let m = s.match(/(\d+(?:\.\d+)?)\s*m[pb]?bs/);
                if (m) return Math.round(parseFloat(m[1]) * 1000);
                m = s.match(/(\d{3,6})\s*k(?:bps|b?s)?/);
                if (m) return parseInt(m[1], 10);
                m = s.match(/(\d+(?:\.\d+)?)\s*m(?![a-z])/);
                if (m) return Math.round(parseFloat(m[1]) * 1000);
                m = s.match(/[?&](?:bw|br|bitrate|vb|rate)=(\d{3,6})\b/);
                if (m) return parseInt(m[1], 10);
                return null;
            })(display) ||
            (function extractBitrateUrl(u0) {
                const s = (u0 || "").toLowerCase();
                let m = s.match(/[?&](?:bw|br|bitrate|vb|rate)=(\d{3,6})\b/);
                if (m) return parseInt(m[1], 10);
                return null;
            })(cleanUrl);
        if (br) {
            src.bitrateKbps = br;
            const mbps = br / 1000;
            if (mbps >= 8) {
                src.quality = "UHD";
                src.rank = 4;
                src.label = `UHD · ${Math.round(mbps * 10) / 10}Mbps`;
            } else if (mbps >= 3) {
                src.quality = "FHD";
                src.rank = 3;
                src.label = `FHD · ${Math.round(mbps * 10) / 10}Mbps`;
            } else if (mbps >= 1.5) {
                src.quality = "HD";
                src.rank = 2;
                src.label = `HD · ${Math.round(mbps * 10) / 10}Mbps`;
            } else {
                src.quality = "SD";
                src.rank = 1;
                src.label = "SD";
            }
        } else {
            const d = lc(display);
            if (d.includes("uhd") || d.includes("4k")) {
                src.quality = "UHD";
                src.rank = 4;
                src.label = "UHD";
            } else if (d.includes("fhd") || d.includes("1080")) {
                src.quality = "FHD";
                src.rank = 3;
                src.label = "FHD";
            } else if (d.includes("hd") || d.includes("720")) {
                src.quality = "HD";
                src.rank = 2;
                src.label = "HD";
            }
        }

        const ltRaw = pending_kodi["inputstream.adaptive.license_type"];
        const lkRaw = pending_kodi["inputstream.adaptive.license_key"];
        if (ltRaw) {
            src.drm = { licenseType: ltRaw };
            if (/clearkey|org\.w3\.clearkey/i.test(ltRaw) && lkRaw) {
                const parsed = (function parseClearKeyWrapper(lk) {
                    try {
                        return parseClearKey(lk);
                    } catch {
                        return { raw: lk };
                    }
                })(lkRaw);
                if (parsed.keys) src.drm.keys = parsed.keys;
                if (parsed.licenseServer) src.drm.licenseServer = parsed.licenseServer;
                if (!parsed.keys && !parsed.licenseServer) src.drm.licenseKey = lkRaw;
            } else if (lkRaw) {
                if (/^https?:\/\//i.test(lkRaw)) src.drm.licenseServer = lkRaw;
                else src.drm.licenseKey = lkRaw;
            }
        }

        if (pipeHeaders || (pending_vlc && Object.keys(pending_vlc).length)) {
            const h = Object.create(null);
            if (pipeHeaders) Object.assign(h, pipeHeaders);
            for (const k in pending_vlc) {
                const lk = k.toLowerCase();
                if (lk === "http-user-agent" || lk === "user-agent")
                    h["userAgent"] = pending_vlc[k];
                else if (lk === "http-referrer" || lk === "http-referer" || lk === "referer")
                    h["referer"] = pending_vlc[k];
                else if (lk === "origin") h["Origin"] = pending_vlc[k];
                else if (lk === "cookie" || lk === "http-cookie") h["Cookie"] = pending_vlc[k];
                else h[k] = pending_vlc[k];
            }
            if (Object.keys(h).length) src.headers = h;
        }

        ch.sources.push(src);

        pending_extinf = null;
        pending_kodi = Object.create(null);
        pending_vlc = Object.create(null);
    }

    const lines = m3uText ? m3uText.replace(/\r/g, "").split("\n") : [];
    for (let i = 0; i < lines.length; i++) {
        const raw = trim(lines[i]);
        if (!raw || raw === "#EXTM3U") continue;

        if (raw.startsWith("#EXTGRP:")) {
            lastGroup = trim(raw.slice(8));
            continue;
        }
        if (raw.startsWith("#KODIPROP:")) {
            const kv = raw.slice(10);
            const eq = kv.indexOf("=");
            if (eq > 0) pending_kodi[kv.slice(0, eq).trim()] = kv.slice(eq + 1).trim();
            continue;
        }
        if (raw.startsWith("#EXTVLCOPT:")) {
            const kv = raw.slice(11);
            const eq = kv.indexOf("=");
            if (eq > 0) {
                const k = kv.slice(0, eq).trim();
                let v = kv.slice(eq + 1).trim();
                if (v.length > 1 && v[0] === '"' && v[v.length - 1] === '"') v = v.slice(1, -1);
                pending_vlc[k] = v;
            }
            continue;
        }
        if (raw.startsWith("#EXTINF:")) {
            pending_extinf = parseExtinf(raw);
            continue;
        }

        if (looksLikeUrlLine(raw)) {
            commitToUrl(raw);
            continue;
        }
    }

    // Kết quả: loại bỏ kênh rỗng hoặc chỉ toàn comment
    const groups = Array.from(groupsMap.values()).map((g) => ({
        ...g,
        channels: g.channels.filter(
            (ch) =>
                Array.isArray(ch.sources) &&
                ch.sources.length > 0 &&
                !isNoiseText(ch.id) &&
                !isNoiseText(ch.name)
        ),
    }));
    for (const g of groups) {
        for (const ch of g.channels) {
            ch.sources.sort((a, b) => {
                const tw = (s) => (s?.type === "hls" ? 2 : s?.type === "dash" ? 1 : 0);
                const ta = tw(a),
                    tb = tw(b);
                if (tb !== ta) return tb - ta; // ưu tiên HLS > DASH > khác
                if ((b.rank || 0) !== (a.rank || 0)) return (b.rank || 0) - (a.rank || 0);
                return (b.bitrateKbps || 0) - (a.bitrateKbps || 0);
            });
        }
    }
    return groups;
}

// Parse M3U text -> [{ groupName, channels: [{id,name,logo,url}] }]
async function parseM3U(m3uText) {
    const groups = parseOttNavigationFast(m3uText);

    return groups.map((g, gi) => ({
        name: g.name || "",
        logo: g.logo || "",
        sortOrder: gi + 1,
        channels: g.channels.map((ch) => ({
            id: ch.id || "",
            name: ch.name || "",
            logo: ch.logo || "",
            sources: Array.isArray(ch.sources) ? ch.sources : [],
            tags: [],
        })),
    }));
}

/* =========================
 * NORMALIZE & DEDUPE
 * ========================= */

function toArr(v) {
    return Array.isArray(v) ? v : [];
}

function slugifyId(s) {
    if (!s) return "";
    return s
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "") // bỏ dấu
        .replace(/[^a-z0-9]+/g, "")
        .slice(0, 64);
}

// Chuẩn hoá group: gộp chanel+channels, map id/name/logo 1 lần
function normalizeGroups(groups) {
    return toArr(groups).map((g) => {
        const items = toArr(g.chanel)
            .concat(toArr(g.channels))
            .map((c) => {
                const rawId = c?.id || c?.name || "";
                const mappedId = channelIdMapping(rawId || "") || slugifyId(rawId) || "";
                const finalName = channelNameMapping(mappedId) || c?.name || "";
                const finalLogo = c?.logo || "";
                const sources = Array.isArray(c?.sources) ? c.sources : []; // <— giữ sources
                const tags = Array.isArray(c?.tags) ? c.tags : []; // <— giữ tags
                return { id: mappedId, name: finalName, logo: finalLogo, sources, tags };
            });
        return { ...g, channels: items };
    });
}

// Dedupe O(n) theo id (giữ name/logo đầu tiên, merge URL)
function findExistedChannel(seen, c0) {
    const norm = (s) => (s || "").toLowerCase().trim();

    const id = norm(c0.id);
    const name = norm(c0.name);
    const tags = new Set((c0.tags || []).map(norm));

    // --- Fast path: tra trực tiếp bằng key trong Map (O(1))
    if (id && seen.has(id)) return seen.get(id);
    for (const a of tags) {
        if (seen.has(a)) return seen.get(a);
    }

    // --- Fallback: duyệt 1 vòng qua values (O(n))
    for (const ch of seen.values()) {
        const chId = norm(ch.id);
        if (id && chId === id) return ch; // id ↔ ch.id
        if (tags.has(chId)) return ch; // tags (c0) ↔ ch.id

        // ch.tags có chứa id/name/tags của c0?
        const chTagIds = ch.tags ? ch.tags : [];
        for (let i = 0; i < chTagIds.length; i++) {
            const v = norm(chTagIds[i]);
            if (id && v === id) return ch; // ch.tags ↔ id
            if (tags.has(v)) return ch; // ch.tags ↔ tags (c0)
        }

        // So tên
        const chName = norm(ch.name);
        if (name && chName === name) return ch; // name ↔ ch.name
        if (tags.has(chName)) return ch; // tags (c0) ↔ ch.name

        const chTagNames = ch.tags ? ch.tags : [];
        for (let i = 0; i < chTagNames.length; i++) {
            const v = norm(chTagNames[i]);
            if (name && v === name) return ch; // ch.altNames ↔ name
            if (tags.has(v)) return ch; // ch.altNames ↔ tags (c0)
        }
    }

    return null;
}

function moveDuplicateChannels(groups, { maxUrlsPerChannel = 120 } = {}) {
    const out = [];
    const seen = new Map(); // id(lowercase) -> firstChannel

    const toArray = (x) => (Array.isArray(x) ? x : x ? [x] : []);
    const normStr = (s) => (s || "").trim();
    const uniq = (arr) => [...new Set(toArray(arr).map(normStr).filter(Boolean))];
    const uniqLower = (arr) => [
        ...new Set(
            toArray(arr)
                .map((s) => normStr(s).toLowerCase())
                .filter(Boolean)
        ),
    ];

    const makeChannel = (c0, sources) => {
        return {
            id: normStr(c0.id).toLowerCase(),
            name: normStr(c0.name),
            logo: normStr(c0.logo),
            sources: sources,
            tags: uniq([...(c0.tags || []), normStr(c0.id), normStr(c0.name)]),
        };
    };

    const mergeInto = (existed, c0, sources) => {
        // Sources: gộp duy nhất, giới hạn max
        existed.sources = [...toArray(existed.sources || []), ...toArray(sources || [])];

        // Logo/Name chỉ bổ sung khi thiếu
        if (!existed.logo && c0.logo) existed.logo = normStr(c0.logo);
        if (!existed.name && c0.name) existed.name = normStr(c0.name);

        // Tags: gộp duy nhất
        existed.tags = uniq([...(existed.tags || []), ...(c0.tags || [])]);
    };

    for (const g of toArray(groups)) {
        const merged = [];
        debugger;
        for (const c0 of toArray(g.channels)) {
            if (!c0) continue;
            const idNew = normStr(c0.id).toLowerCase();
            if (!idNew) continue;

            // Chuẩn hoá URL -> array
            const sources = [
                ...(c0.sources || []),
                ...(Array.isArray(c0.url)
                    ? uniq(c0.url)
                    : typeof c0.url === "string"
                    ? uniq(c0.url.split(","))
                    : []),
            ];
            debugger;
            // Tìm kênh đã có (theo logic của mày)
            const existed = findExistedChannel(seen, c0);

            if (!existed) {
                const first = makeChannel(c0, sources);
                // nếu chưa có trong seen theo idNew thì set
                if (!seen.has(idNew)) seen.set(idNew, first);
                merged.push(first);
                continue;
            }

            // —— Gate merge theo rule —— //
            const idOld = normStr(existed.id).toLowerCase();
            const nameNew = normStr(c0.name);

            const tags = uniq(existed.tags);

            const condSameId = idNew && idOld && idNew === idOld;
            const condNameInAltNamesOld = !!nameNew && tags.includes(nameNew);
            const condIdInAltIdsOld = !!idNew && tags.includes(idNew);

            const canMerge = condSameId || condNameInAltNamesOld || condIdInAltIdsOld;

            if (canMerge) {
                mergeInto(existed, c0, sources);
            } else {
                // Không merge: tạo kênh mới độc lập theo idNew (nếu chưa có seed cùng id)
                if (!seen.has(idNew)) {
                    const first = makeChannel(c0, sources);
                    seen.set(idNew, first);
                    merged.push(first);
                } else {
                    // Đã có seed với idNew (trường hợp hiếm) -> merge vào seed idNew
                    const seed = seen.get(idNew);
                    mergeInto(seed, c0, urls);
                }
            }
        }

        out.push({ ...g, channels: merged });
    }

    return out.filter((g) => Array.isArray(g.channels) && g.channels.length > 0);
}

/* =========================
 * STREAM M3U8 (TIẾT KIỆM RAM/CPU)
 * ========================= */

function streamM3U(data, epgs = []) {
    // ==== Helpers cực cơ bản (đủ xài, dễ bảo trì) ====
    const toArr = (x) => (Array.isArray(x) ? x : x ? [x] : []);
    const avatar = (name) =>
        `https://ui-avatars.com/api/?size=256&format=png&rounded=true&background=random&length=2&name=${encodeURIComponent(
            name
        )}`;

    // ==== Bắt đầu build ====
    let out = "";
    out += `#EXTM3U${epgs.length ? ` url-tvg="${epgs.join(",")}"` : ""}\n`;
    out += `# Generated: ${new Date().toISOString()}\n`;

    for (const group of toArr(data)) {
        const groupTitle = groupNameMapping(group?.name);
        const groupLogo = logoProxy(group?.logo || avatar(groupTitle));

        const channels = toArr(group?.channels);
        if (!groupTitle || channels.length === 0) continue;

        out += `\n#▽ ================================= ${groupTitle} =================================\n\n`;

        for (let i = 0; i < channels.length; i++) {
            const ch = channels[i];
            if (!ch) continue;

            const sources = toArr(ch?.sources);
            if (sources.length === 0) continue;

            // Logo kênh (có thì xài, không thì dùng avatar)
            let logo = (ch.logo = logoProxy(ch.logo) || avatar(ch?.name || ch?.id || ""));

            // Nếu group chứa "radio" → thêm (Radio)
            const isRadio = groupTitle.toLowerCase().includes("radio");
            let displayName = (
                isRadio ? `${ch?.name || ch?.id || ""} (Radio)` : ch?.name || ch?.id || ""
            ).toUpperCase();

            for (const src of sources) {
                // group-logo chỉ cho kênh đầu (i === 0)
                const groupLogoStr =
                    i === 0 && groupLogo && sources.indexOf(src) === 0
                        ? ` group-logo="${groupLogo}"`
                        : "";

                //   if(src.quality){
                //     displayName += ` ${src.quality}`;
                //   }

                // 1) Dòng EXTINF
                out += `#EXTINF:-1 tvg-id="${ch?.id}" group-title="${groupTitle}" tvg-logo="${logo}"${groupLogoStr},${displayName}\n`;

                // 2) VLC headers (tuỳ chọn)
                const ua = src?.headers?.userAgent;
                const ref = src?.headers?.referer || src?.headers?.referrer;
                if (ua) out += `#EXTVLCOPT:http-user-agent=${ua}\n`;
                if (ref) out += `#EXTVLCOPT:http-referrer=${ref}\n`;

                // 3) DRM cho Kodi (tuỳ chọn)
                const drm = src?.drm;
                if (drm) {
                    const licenseType = drm.licenseType;
                    if (licenseType) {
                        out += `#KODIPROP:inputstream.adaptive.license_type=${licenseType}\n`;
                    }

                    // ClearKey: danh sách { kid, key }
                    const keys = toArr(drm.keys);
                    for (const k of keys) {
                        const kid = k?.kid;
                        const key = k?.key;
                        if (kid && key) {
                            out += `#KODIPROP:inputstream.adaptive.license_key=${kid}:${key}\n`;
                        }
                    }

                    // Widevine license server (có thể kèm header dạng url|H1=..|H2=..|R{SSM}|)
                    const licenseServer = drm.licenseServer;
                    if (licenseServer) {
                        out += `#KODIPROP:inputstream.adaptive.license_key=${licenseServer}\n`;
                    }
                }

                // 4) URL nguồn
                const url = src?.url;
                if (!url) continue; // bỏ dòng rỗng
                out += `${url}\n`;
            }

            out += `\n`;
        }

        out += `#△ ================================= ${groupTitle} =================================\n`;
    }

    return out;
}

/* =========================
 * TIỆN ÍCH KHÁC
 * ========================= */

function extractClearKey(channel) {
    try {
        if (channel?.clearKey?.drm?.clearKeys) {
            const keys = channel.clearKey.drm.clearKeys;
            const keyId = Object.keys(keys)[0];
            return { keyId, keyVal: keys[keyId] };
        }
        if (Array.isArray(channel?.clearKey?.keys) && channel.clearKey.keys.length) {
            const first = channel.clearKey.keys[0];
            const b64toHex = (b64) => {
                const raw = atob(b64.replace(/-/g, "+").replace(/_/g, "/"));
                return [...raw].map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
            };
            return { keyId: b64toHex(first.kid), keyVal: b64toHex(first.k) };
        }
    } catch (e) {}
    return { keyId: "", keyVal: "" };
}

function logoProxy(url, cache = false) {
    // cache=false;
    const clean = (url || "").trim();
    if (!clean) return "";

    if (url.includes("imgur")) {
        return clean;
    } else if (cache) {
        // Giữ nguyên để cache
        return `https://images.weserv.nl/?w=256&h=256&fit=contain&url=${encodeURIComponent(
            clean
        )}&maxage=1d`;
    } else {
        // Thêm timestamp để tránh cache
        return `https://images.weserv.nl/?w=256&h=256&fit=contain&url=${encodeURIComponent(
            clean
        )}&maxage=1d&t=${Date.now()}`;
    }
}

function normalizeGroupTitle(s) {
    s = groupNameMapping(s);
    s = removeEmoji(s);
    return (s || "").replace("Kênh", "").trim().toUpperCase();
}

/* =========================
 * MAPPINGS (DETERMINISTIC)
 * ========================= */

function channelIdMapping(id) {
    if (!id) return "";
    const mapping = {
        // Ví dụ đổi tên chuẩn
        vtv6hd: "vtvcantho",

        // VTVcab -> On channels
        vtvcab1hd: "onviegiaitri",
        vtvcab2hd: "onphimviet",
        vtvcab3hd: "onsports",
        vtvcab4hd: "onmovies",
        vtvcab5hd: "onechannel",
        vtvcab6hd: "onsportsplus",
        vtvcab7hd: "ono2tv",
        vtvcab8hd: "onbibi",
        vtvcab9hd: "oninfotv",
        vtvcab10hd: "oncine",
        vtvcab12hd: "onstyle",
        vtvcab15hd: "onmusic",
        vtvcab16hd: "onfootball",
        vtvcab17hd: "ontrending",
        vtvcab18hd: "onsportsnews",
        vtvcab19hd: "onviedramas",
        vtvcab20hd: "onvfamily",
        vtvcab21hd: "onkids",
        vtvcab22hd: "onlife",
        vtvcab23hd: "ongolf",

        // TV360+
        "tv360.sk1": "tv360plus1",
        "tv360.sk2": "tv360plus2",
        "tv360.sk3": "tv360plus3",
        "tv360.sk4": "tv360plus4",
        "tv360.sk5": "tv360plus5",
        "tv360.sk6": "tv360plus6",
        "tv360.sk7": "tv360plus7",
        "tv360.sk8": "tv360plus8",
        "tv360.sk9": "tv360plus9",

        // HTV
        htv4: "htvkey",
    };
    return mapping[id] || id;
}

function channelNameMapping(id) {
    const mapping = { htvkey: "HTV Key" };
    return mapping[id];
}

/* =========================
 * (Optional) NÉN GZIP THẬT (nếu muốn)
 * =========================
function gzipReadable(readable) {
  // readable: ReadableStream<Uint8Array>
  return readable.pipeThrough(new CompressionStream('gzip'));
}
*/

function groupNameMapping(name) {
    var mapping = {
        "🇰🇷| Hàn Quốc": "Hàn Quốc",
        "🇹🇭| Thái Lan": "Thái Lan",
        "🇰🇭| Campuchia": "Campuchia",
        "HÓNG TIN CHIẾN SỰ": "Thời Sự Thế Giới",
        "🇷🇺 Nga và khối SNG": "Nga",
        "🇺🇦 UKRAINA": "Ukraina",
        "Trung Cộng": "Trung Quốc",
        "🇰🇵 Triều Tiên": "Triều Tiên",
        "🇰🇷 Hàn Quốc": "Hàn Quốc",
        "Thái Lẻn": "Thái Lan",
        "Truyền hình chích điện siêu phê": "Campuchia",
        Sing: "Singapore",
        "⚽| Thể thao quốc tế": "THỂ THAO QUỐC TẾ",
    };
    return mapping[name] || name;
}

function removeEmoji(str) {
    return str.replace(
        /([\u2700-\u27BF]|[\uE000-\uF8FF]|\uD83C[\uDC00-\uDFFF]|\uD83D[\uDC00-\uDFFF]|\uD83E[\uDD00-\uDDFF])/g,
        ""
    );
}

function cleanGroupName(name) {
    return (name || "")
        .replace(/^\|+|\|+$/g, "") // bỏ dấu | ở đầu/cuối
        .trim(); // bỏ khoảng trắng dư
}
