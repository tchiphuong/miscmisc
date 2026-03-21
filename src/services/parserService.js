/**
 * IPTV PARSER SERVICE (Enhanced)
 * Cung cấp logic phân tích cú pháp M3U8 nâng cao, hỗ trợ DRM, Headers, và gộp kênh.
 * Logic được tích hợp từ main1.js
 */
(function (window) {
    // --- Cấu hình & Constants ---
    const BANNED_CHANNELS = [
        "đỗ viết sỹ",
        "kubo",
        "nino",
        "oni",
        "event plus",
        "sgevents",
        "socolive",
    ];

    // --- Helper Functions ---
    const trim = (s) => (s && s.trim()) || "";
    const unq = (s) => (s && s[0] === '"' && s[s.length - 1] === '"' ? s.slice(1, -1) : s);
    const lc = (s) => (s ? s.toLowerCase() : s);

    function slugifyId(s) {
        if (!s) return "";
        return s
            .toLowerCase()
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 64);
    }

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
            lower.startsWith("rtsps://") ||
            lower.startsWith("rtp://")
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
        return "hls";
    };

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
            if (k === "user-agent" || k === "useragent") headers["userAgent"] = v;
            else if (k === "referer" || k === "referrer") headers["referer"] = v;
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

        if (attrPart.startsWith("#EXTINF:") || attrPart.startsWith("EXTINF:")) i = 8;
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

    function toHex(buf) {
        return Array.from(buf)
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("");
    }

    function fromBase64ToHex(b64) {
        try {
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

    // --- Core Parser Logic ---

    function parseOttNavigationFast(m3uText) {
        const groupsMap = new Map();
        const channelIndex = new Map();

        let lastGroup = "Khác";
        let pending_extinf = null;
        let pending_kodi = Object.create(null);
        let pending_vlc = Object.create(null);

        function ensureGroup(name) {
            let g = groupsMap.get(name);
            if (!g) {
                g = { name, channels: [], sortOrder: 999 };
                groupsMap.set(name, g);
            }
            return g;
        }

        function commitToUrl(url) {
            if (isCommentishLine(url)) {
                pending_extinf = null;
                pending_kodi = Object.create(null);
                pending_vlc = Object.create(null);
                return;
            }
            const at = (pending_extinf && pending_extinf.attrs) || {};
            const groupName = at["group-title"] ? unq(at["group-title"]) : lastGroup;

            if (BANNED_CHANNELS.includes(groupName.toLowerCase())) return;

            const group = ensureGroup(groupName);
            const tvgName = at["tvg-name"] ? unq(at["tvg-name"]) : "";
            const tvgLogo = at["tvg-logo"] ? unq(at["tvg-logo"]) : "";
            const display = (pending_extinf && pending_extinf.displayName) || tvgName || url;
            const tvgId = at["tvg-id"] ? unq(at["tvg-id"]) : slugifyId(tvgName || display);

            const key = `${groupName}\u0001${tvgId}`;
            let ch = channelIndex.get(key);
            if (!ch) {
                ch = {
                    id: tvgId,
                    name: tvgName || display,
                    logo: tvgLogo || undefined,
                    sources: [],
                };
                group.channels.push(ch);
                channelIndex.set(key, ch);
            } else if (tvgLogo && !ch.logo) {
                ch.logo = tvgLogo;
            }

            const { cleanUrl, headers: pipeHeaders } = splitPipeHeaders(url);
            let typeGuess = detectType(cleanUrl);
            if (pending_kodi["inputstream.adaptive.license_type"]) {
                const lt = lc(pending_kodi["inputstream.adaptive.license_type"]);
                typeGuess = lt.includes("apple.fps") ? "hls" : "dash";
            }

            const src = { url: cleanUrl, type: typeGuess };

            // Bitrate & Quality
            const br = extractBitrate(display) || extractBitrate(cleanUrl);
            if (br) {
                src.bitrateKbps = br;
                const mbps = br / 1000;
                if (mbps >= 8) {
                    src.quality = "UHD";
                    src.rank = 4;
                } else if (mbps >= 3) {
                    src.quality = "FHD";
                    src.rank = 3;
                } else if (mbps >= 1.5) {
                    src.quality = "HD";
                    src.rank = 2;
                } else {
                    src.quality = "SD";
                    src.rank = 1;
                }
            }

            // DRM
            const ltRaw = pending_kodi["inputstream.adaptive.license_type"];
            const lkRaw = pending_kodi["inputstream.adaptive.license_key"];
            if (ltRaw) {
                src.drm = { licenseType: ltRaw };
                if (/clearkey|org\.w3\.clearkey/i.test(ltRaw) && lkRaw) {
                    const parsed = parseClearKey(lkRaw);
                    if (parsed.keys) src.drm.keys = parsed.keys;
                    if (parsed.licenseServer) src.drm.licenseServer = parsed.licenseServer;
                    if (!parsed.keys && !parsed.licenseServer) src.drm.licenseKey = lkRaw;
                } else if (lkRaw) {
                    if (/^https?:\/\//i.test(lkRaw)) src.drm.licenseServer = lkRaw;
                    else src.drm.licenseKey = lkRaw;
                }
            }

            // Headers
            if (pipeHeaders || Object.keys(pending_vlc).length) {
                const h = Object.create(null);
                if (pipeHeaders) Object.assign(h, pipeHeaders);
                for (const k in pending_vlc) {
                    const lk = k.toLowerCase();
                    if (lk === "http-user-agent" || lk === "user-agent")
                        h["userAgent"] = pending_vlc[k];
                    else if (lk === "http-referrer" || lk === "http-referer" || lk === "referer")
                        h["referer"] = pending_vlc[k];
                    else h[lk] = pending_vlc[k];
                }
                if (Object.keys(h).length) src.headers = h;
            }

            if (!ch.sources.some((x) => x.url === src.url)) ch.sources.push(src);

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
            if (raw.startsWith("#EXTINF:") || raw.startsWith("EXTINF:")) {
                pending_extinf = parseExtinf(raw);
                continue;
            }
            if (looksLikeUrlLine(raw)) {
                commitToUrl(raw);
                continue;
            }
        }

        // Cleanup empty groups/channels
        return Array.from(groupsMap.values())
            .map((g) => ({
                ...g,
                channels: g.channels.filter(
                    (ch) => ch.sources.length > 0 && !isNoiseText(ch.id) && !isNoiseText(ch.name),
                ),
            }))
            .filter((g) => g.channels.length > 0);
    }

    // --- Exported Methods ---

    /**
     * Chuyển đổi dữ liệu JSON sang M3U8 string
     */
    async function serializeToM3U(groups) {
        let out = "#EXTM3U\n";
        groups.forEach((group) => {
            out += `\n# --- ${group.name} ---\n`;
            group.channels.forEach((ch) => {
                // Lấy danh sách sources từ ch.sources hoặc ch.url
                let sources = toArr(ch.sources);
                if (sources.length === 0 && ch.url) {
                    const urls = typeof ch.url === "string" ? ch.url.split(",") : toArr(ch.url);
                    sources = urls.map((u) => ({ url: u.trim(), type: "hls" }));
                }

                sources.forEach((src) => {
                    out += `#EXTINF:-1 tvg-id="${ch.id}" group-title="${group.name}" tvg-logo="${ch.logo || ""}",${ch.name}\n`;

                    // Headers
                    if (src.headers) {
                        if (src.headers.userAgent)
                            out += `#EXTVLCOPT:http-user-agent=${src.headers.userAgent}\n`;
                        if (src.headers.referer)
                            out += `#EXTVLCOPT:http-referrer=${src.headers.referer}\n`;
                    }

                    // DRM
                    const drm = src.drm;
                    if (drm) {
                        if (drm.licenseType)
                            out += `#KODIPROP:inputstream.adaptive.license_type=${drm.licenseType}\n`;
                        if (drm.keys && drm.keys.length) {
                            drm.keys.forEach((k) => {
                                if (k.kid && k.key)
                                    out += `#KODIPROP:inputstream.adaptive.license_key=${k.kid}:${k.key}\n`;
                            });
                        } else if (drm.licenseServer) {
                            out += `#KODIPROP:inputstream.adaptive.license_key=${drm.licenseServer}\n`;
                        } else if (drm.licenseKey) {
                            out += `#KODIPROP:inputstream.adaptive.license_key=${drm.licenseKey}\n`;
                        }
                    }

                    out += `${src.url}\n`;
                });
            });
        });
        return out;
    }

    // --- Global Export ---
    window._CORE_ENGINE_ = {
        parse: parseM3U,
        serialize: serializeToM3U,
    };

    /**
     * Phân tích nội dung M3U sang JSON (Quy trình hoàn chỉnh)
     */
    function parseM3U(input, options = {}) {
        // 1) Parse raw M3U
        let groups = parseOttNavigationFast(input);

        // 2) Chuẩn hóa & Gộp kênh (Dedupe)
        groups = normalizeGroups(groups);
        groups = moveDuplicateChannels(groups);

        // 3) Mở rộng RTP sources (nếu có)
        expandRtpSources(groups);

        // 4) Gom nhóm theo mapping cuối cùng
        groups = getGroupedData(groups);

        // 5) Xử lý tùy chọn Parse Source Detail (Ẩn/Hiện field chi tiết)
        if (!options.parseSources) {
            groups.forEach((g) => {
                g.channels.forEach((ch) => {
                    // Nếu không parse chi tiết, xóa hoàn toàn thông tin liên quan đến link stream
                    delete ch.sources;
                    delete ch.url;
                    delete ch.tags;
                    delete ch.enabled;
                });
            });
        }

        return groups;
    }

    // --- Logic Chuẩn hóa & Dedupe ---

    function toArr(v) {
        return Array.isArray(v) ? v : v ? [v] : [];
    }

    function normalizeGroups(groups) {
        return toArr(groups).map((g) => {
            const items = toArr(g.channels || g.chanel).map((c) => {
                const rawId = c?.id || c?.name || "";
                const mappedId = channelIdMapping(rawId || "") || slugifyId(rawId) || "";
                const finalName = channelNameMapping(mappedId) || c?.name || "";

                // Đảm bảo lấy sources từ cả c.sources hoặc c.url (split nếu cần)
                let sources = toArr(c?.sources);
                if (sources.length === 0 && c?.url) {
                    const urls = typeof c.url === "string" ? c.url.split(",") : toArr(c.url);
                    sources = urls.map((u) => ({ url: u.trim(), type: "hls" }));
                }

                return {
                    id: mappedId,
                    name: finalName,
                    logo: c?.logo || "",
                    sources: sources,
                    tags: toArr(c?.tags),
                    sortOrder: c?.sortOrder,
                    enabled: c?.enabled,
                };
            });
            return { ...g, channels: items };
        });
    }

    function moveDuplicateChannels(groups) {
        const seenById = new Map();
        const seenByName = new Map();
        const seenByTag = new Map();

        const toArray = (x) => (Array.isArray(x) ? x : x ? [x] : []);
        const normStr = (s) => (s || "").trim();
        const uniq = (arr) => [...new Set(toArray(arr).map(normStr).filter(Boolean))];

        const registerChannel = (ch) => {
            const id = normStr(ch.id).toLowerCase();
            const name = normStr(ch.name).toLowerCase();
            if (id && !seenById.has(id)) seenById.set(id, ch);
            if (name && !seenByName.has(name)) seenByName.set(name, ch);
            for (const t of ch.tags || []) {
                const tl = normStr(t).toLowerCase();
                if (tl && !seenByTag.has(tl)) seenByTag.set(tl, ch);
            }
        };

        const findExistedFast = (c0) => {
            const id = normStr(c0.id).toLowerCase();
            const name = normStr(c0.name).toLowerCase();
            const tags = (c0.tags || []).map((t) => normStr(t).toLowerCase());

            for (const t of tags) {
                if (t && seenByTag.has(t)) return seenByTag.get(t);
                if (t && seenById.has(t)) return seenById.get(t);
                if (t && seenByName.has(t)) return seenByName.get(t);
            }
            if (id) {
                if (seenById.has(id)) return seenById.get(id);
                if (seenByTag.has(id)) return seenByTag.get(id);
                if (seenByName.has(id)) return seenByName.get(id);
            }
            if (name) {
                if (seenByName.has(name)) return seenByName.get(name);
                if (seenById.has(name)) return seenById.get(name);
                if (seenByTag.has(name)) return seenByTag.get(name);
            }
            return null;
        };

        const makeChannel = (c0, sources) => ({
            id: normStr(c0.id).toLowerCase(),
            name: normStr(c0.name),
            logo: normStr(c0.logo),
            sources: sources,
            tags: uniq([...(c0.tags || []), normStr(c0.id), normStr(c0.name)]),
            sortOrder: c0.sortOrder,
            enabled: c0.enabled,
        });

        const mergeInto = (existed, c0, sources) => {
            existed.sources = [...toArray(existed.sources || []), ...toArray(sources || [])];
            if (!existed.logo && c0.logo) existed.logo = normStr(c0.logo);
            if (!existed.name && c0.name) existed.name = normStr(c0.name);
            existed.tags = uniq([...(existed.tags || []), ...(c0.tags || [])]);
            if (existed.sortOrder == null) existed.sortOrder = c0.sortOrder;
            registerChannel(existed);
        };

        const out = [];
        for (const g of toArray(groups)) {
            const merged = [];
            for (const c0 of toArray(g.channels)) {
                if (!c0 || !c0.id) continue;
                const sources = [...(c0.sources || [])];
                const existed = findExistedFast(c0);

                if (!existed) {
                    const first = makeChannel(c0, sources);
                    registerChannel(first);
                    merged.push(first);
                } else {
                    mergeInto(existed, c0, sources);
                }
            }
            out.push({ ...g, channels: merged });
        }
        return out.filter((g) => g.channels.length > 0);
    }

    function expandRtpSources(groups) {
        const RTP_SRC = [
            "/rtp/232.84.1.117:10254",
            "/rtp/232.84.3.247:11404",
            "/rtp/232.84.1.27:8136",
        ];
        const rtpHosts = new Set();
        for (const g of groups) {
            for (const ch of g.channels || []) {
                for (const src of ch.sources || []) {
                    if (!src.url) continue;
                    try {
                        const u = new URL(src.url);
                        if (RTP_SRC.includes(u.pathname)) rtpHosts.add(`${u.protocol}//${u.host}`);
                    } catch {}
                }
            }
        }
        if (rtpHosts.size === 0) return;
        for (const g of groups) {
            for (const ch of g.channels || []) {
                const expanded = [];
                for (const src of ch.sources || []) {
                    if (src.url && /^rtp:\/\/@/.test(src.url)) {
                        const rtpPath = src.url.replace(/^rtp:\/\/@/, "");
                        for (const host of rtpHosts)
                            expanded.push({ ...src, url: `${host}/rtp/${rtpPath}` });
                    } else expanded.push(src);
                }
                ch.sources = expanded;
            }
        }
    }

    function getGroupedData(data) {
        const groups = Object.values(
            toArr(data).reduce((acc, currentItem) => {
                const key = groupNameMapping(currentItem?.name);
                if (!key) return acc;
                if (!acc[key]) {
                    acc[key] = { ...currentItem, name: key, channels: toArr(currentItem.channels) };
                } else {
                    acc[key].channels = acc[key].channels.concat(toArr(currentItem.channels));
                }
                return acc;
            }, {}),
        ).sort((a, b) => (a.sortOrder || 999) - (b.sortOrder || 999));

        for (const group of groups) {
            group.channels = group.channels
                .filter(
                    (ch) => !BANNED_CHANNELS.some((x) => (ch.name || "").toLowerCase().includes(x)),
                )
                .map((ch) => ({ ...ch, sources: toArr(ch.sources) }))
                .filter((ch) => ch.sources.length > 0);

            group.channels.sort((a, b) => {
                if (a.sortOrder != null && b.sortOrder != null) return a.sortOrder - b.sortOrder;
                return (a.name || "").localeCompare(b.name || "", "vi", { numeric: true });
            });
        }
        return groups.filter((g) => g.channels.length > 0);
    }

    // --- Mappings ---

    function channelIdMapping(id) {
        const mapping = {
            vtv6hd: "vtvcantho",
            vtvcab1hd: "onviegiaitri",
            vtvcab2hd: "onphimviet",
            vtvcab3hd: "onsports",
            vtvcab16hd: "onfootball",
        };
        return mapping[id] || id;
    }

    function channelNameMapping(id) {
        const mapping = { htvkey: "HTV Key" };
        return mapping[id];
    }

    function groupNameMapping(name) {
        const mapping = {
            "🇰🇷| Hàn Quốc": "Hàn Quốc",
            "🇹🇭| Thái Lan": "Thái Lan",
            "🇰🇭| Campuchia": "Campuchia",
            "THỂ THAO QUỐC TẾ": "Thể Thao",
            "📻 | Radio": "Radio",
            "🇻🇳 Vietnam Radio": "Radio",
        };
        if (mapping[name]) return mapping[name];
        const n = (name || "").toLowerCase();
        if (n.includes("sport")) return "Thể Thao";
        if (n.includes("quốc tế")) return "Quốc Tế";
        if (n.includes("địa phương")) return "Trong nước";
        return name;
    }
})(window);
