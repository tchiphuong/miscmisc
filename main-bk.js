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
export default {
    async fetch(request, env, ctx) {
        return handleRequest(request, env, ctx);
    },
};

/* =========================
 * HÀM XỬ LÝ CHÍNH
 * ========================= */
async function handleRequest(request, env, ctx) {
    try {
        // Edge cache theo URL
        const cache = caches.default;
        const cacheKey = new Request(new URL(request.url).toString(), request);

        // ⬇️ ép refresh nếu có query refresh=1
        const url = new URL(request.url);
        const forceRefresh = url.searchParams.get("refresh") === "1" || true;

        if (!forceRefresh) {
            const cached = await cache.match(cacheKey);
            if (cached) return cached;
        }

        // 1) LẤY DỮ LIỆU NGUỒN (đã tách riêng)
        const {
            hlsOrg,
            hlsMerge,
            mpdData,
            kplusText,
            klplusText,
            vmtText,
            daklakText,
            aceStremaText,
        } = await fetchAllSources();

        // 2) PARSE M3U (đã tách parse riêng) + GOM NGUỒN
        const [kchannel, klchannel, vchannel, dchannel, aceStremaChannel] = await Promise.all([
            parseM3U(kplusText),
            parseM3U(klplusText),
            parseM3U(vmtText),
            parseM3U(daklakText),
            parseM3U(aceStremaText),
            //parseM3U(sportText),
        ]);

        let merged = [
            ...toArr(hlsOrg),
            ...toArr(klchannel),
            ...toArr(kchannel),
            ...toArr(vchannel),
            ...toArr(dchannel),
            ...toArr(aceStremaChannel),
            ...toArr(hlsMerge),
            //...toArr(sportChannel),
        ];

        // 3) CHUẨN HÓA + DEDUPE (O(n))
        merged = normalizeGroups(merged);
        merged = moveDuplicateChannels(merged);

        // console.log(merged);

        // 4) STREAM M3U8
        const body = streamM3U(merged, mpdData);
        const headers = {
            "Content-Type": "text/plain; charset=utf-8",
            //'Content-Disposition': `inline; filename="playlist_${new Date().toISOString()}.m3u8"`,
            //'Cache-Control': 'max-age=60',  // cache ngắn để cập nhật kịp
            "Access-Control-Allow-Origin": "*",
        };

        const resp = new Response(body, { status: 200, headers });

        // 5) CACHE (không chặn trả về)
        ctx.waitUntil(cache.put(cacheKey, resp.clone()));
        return resp;
    } catch (err) {
        console.error("Worker error:", err);
        return new Response("Lỗi khi tạo HLS output", {
            status: 500,
            headers: {
                "Content-Type": "text/plain; charset=utf-8",
                "Access-Control-Allow-Origin": "*",
            },
        });
    }
}

/* =========================
 * FETCH LAYER (TÁCH RIÊNG)
 * ========================= */

// Gọi tất cả nguồn (song song, có timeout + retry)
async function fetchAllSources() {
    const [hlsOrg, hlsMerge, mpdData, klplusText, kplusText, vmtText, daklakText, aceStremaText] =
        await Promise.all([
            fetchJsonWithPolicy(SRC.HLS_ORG),
            fetchJsonWithPolicy(SRC.HLS_MERGE),
            fetchJsonWithPolicy(SRC.MPD),
            fetchTextWithPolicy(SRC.KLINH),
            fetchTextWithPolicy(SRC.KPLUS),
            fetchTextWithPolicy(SRC.VMTTV),
            fetchTextWithPolicy(SRC.DAKLAK),
            fetchTextWithPolicy(SRC.ACESTREAM),
            //fetchTextWithPolicy(SRC.SPORT),
        ]);

    return { hlsOrg, hlsMerge, mpdData, klplusText, kplusText, vmtText, daklakText, aceStremaText };
}

// fetch JSON có timeout + retry
async function fetchJsonWithPolicy(
    url,
    { timeoutMs = FETCH_TIMEOUT_MS, retry = FETCH_RETRY } = {}
) {
    for (let attempt = 0; attempt <= retry; attempt++) {
        try {
            const res = await fetchWithTimeout(url, { timeoutMs });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.json();
        } catch (e) {
            if (attempt === retry) throw e;
        }
    }
}

// fetch TEXT có timeout + retry
async function fetchTextWithPolicy(
    url,
    { timeoutMs = FETCH_TIMEOUT_MS, retry = FETCH_RETRY } = {}
) {
    for (let attempt = 0; attempt <= retry; attempt++) {
        try {
            const res = await fetchWithTimeout(url, { timeoutMs });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.text();
        } catch (e) {
            if (attempt === retry) throw e;
        }
    }
}

// fetch có timeout qua AbortController
async function fetchWithTimeout(url, { timeoutMs }) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort("timeout"), timeoutMs);
    try {
        return await fetch(url, { signal: ctrl.signal });
    } finally {
        clearTimeout(timer);
    }
}

/* =========================
 * PARSER & BUILDERS
 * ========================= */

// Parse M3U text -> [{ groupName, channels: [{id,name,logo,url}] }]
async function parseM3U(m3uText) {
    const text = (m3uText || "").replace(/\r/g, "");
    const lines = text.split("\n");
    const groups = {};

    for (let i = 0; i < lines.length; i++) {
        const line = (lines[i] || "").trim();
        if (!line.startsWith("#EXTINF")) continue;

        // Parse attributes
        const attrs = {};
        const attrRegex = /(\w[\w-]*)="([^"]*)"/g;
        let m;
        while ((m = attrRegex.exec(line))) {
            attrs[m[1]] = m[2];
        }

        let name = line.split(",").pop()?.trim() || "Unnamed";

        // Lấy URL ở dòng kế tiếp (bỏ comment/empty)
        let streamUrl = null;
        let j = i + 1;
        while (j < lines.length && (!lines[j] || lines[j].trim().startsWith("#"))) j++;
        if (j < lines.length) streamUrl = (lines[j] || "").trim();

        let groupName = attrs["group-title"] || "Khác";
        groupName = groupNameMapping(groupName);
        groupName = cleanGroupName(groupName);

        if (streamUrl.includes("/cbrlig.php") || streamUrl.includes("/nero.php")) {
            name = `[${groupName}] ${name}`;
            groupName = "THỂ THAO QUỐC TẾ";
        }
        if (!groups[groupName]) groups[groupName] = [];

        if (streamUrl) {
            groups[groupName].push({
                id: attrs["tvg-id"] || "", // để rỗng → normalize sẽ lo
                url: streamUrl,
                logo: attrs["tvg-logo"] || "", // rỗng nếu không có
                name: name.toUpperCase(),
            });
        }
    }

    return Object.entries(groups).map(([groupName, channels]) => ({ groupName, channels }));
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
                const url = c?.url || "";
                return {
                    id: mappedId,
                    name: finalName,
                    logo: finalLogo,
                    url,
                    altIds: c?.altIds,
                    altNames: c?.altNames,
                };
            });
        return { ...g, channels: items };
    });
}

// Dedupe O(n) theo id (giữ name/logo đầu tiên, merge URL)
function findExistedChannel(seen, c0) {
    const norm = (s) => (s || "").toLowerCase().trim();

    const id = norm(c0.id);
    const name = norm(c0.name);
    const altIds = new Set((c0.altIds || []).map(norm));
    const altNames = new Set((c0.altNames || []).map(norm));

    // --- Fast path: tra trực tiếp bằng key trong Map (O(1))
    if (id && seen.has(id)) return seen.get(id);
    for (const a of altIds) {
        if (seen.has(a)) return seen.get(a);
    }

    // --- Fallback: duyệt 1 vòng qua values (O(n))
    for (const ch of seen.values()) {
        const chId = norm(ch.id);
        if (id && chId === id) return ch; // id ↔ ch.id
        if (altIds.has(chId)) return ch; // altIds (c0) ↔ ch.id

        // ch.altIds có chứa id/altId của c0?
        const chAltIds = ch.altIds ? ch.altIds : [];
        for (let i = 0; i < chAltIds.length; i++) {
            const v = norm(chAltIds[i]);
            if (id && v === id) return ch; // ch.altIds ↔ id
            if (altIds.has(v)) return ch; // ch.altIds ↔ altIds (c0)
        }

        // So tên
        const chName = norm(ch.name);
        if (name && chName === name) return ch; // name ↔ ch.name
        if (altNames.has(chName)) return ch; // altNames (c0) ↔ ch.name

        const chAltNames = ch.altNames ? ch.altNames : [];
        for (let i = 0; i < chAltNames.length; i++) {
            const v = norm(chAltNames[i]);
            if (name && v === name) return ch; // ch.altNames ↔ name
            if (altNames.has(v)) return ch; // ch.altNames ↔ altNames (c0)
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

    const makeChannel = (c0, urls) => {
        const firstUrls = uniq(urls);
        if (maxUrlsPerChannel && firstUrls.length > maxUrlsPerChannel)
            firstUrls.length = maxUrlsPerChannel;
        return {
            id: normStr(c0.id).toLowerCase(),
            altIds: uniq(c0.altIds),
            name: normStr(c0.name),
            altNames: uniq(c0.altNames),
            logo: normStr(c0.logo),
            url: firstUrls,
        };
    };

    const mergeInto = (existed, c0, urls) => {
        // URL
        if (urls.length) {
            const mergedSet = new Set([...(existed.url || []), ...urls.map(normStr)]);
            let mergedUrls = [...mergedSet].filter(Boolean);
            if (maxUrlsPerChannel && mergedUrls.length > maxUrlsPerChannel)
                mergedUrls.length = maxUrlsPerChannel;
            existed.url = mergedUrls;
        }
        // Logo/Name chỉ bổ sung khi thiếu
        if (!existed.logo && c0.logo) existed.logo = normStr(c0.logo);
        if (!existed.name && c0.name) existed.name = normStr(c0.name);

        // altIds / altNames
        existed.altIds = uniq([...(existed.altIds || []), ...(c0.altIds || [])]);
        existed.altNames = uniq([...(existed.altNames || []), ...(c0.altNames || [])]);
    };

    for (const g of toArray(groups)) {
        const merged = [];

        for (const c0 of toArray(g.channels)) {
            if (!c0) continue;
            const idNew = normStr(c0.id).toLowerCase();
            if (!idNew) continue;

            // Chuẩn hoá URL -> array
            const urls = Array.isArray(c0.url)
                ? uniq(c0.url)
                : typeof c0.url === "string"
                ? uniq(c0.url.split(","))
                : [];

            // Tìm kênh đã có (theo logic của mày)
            const existed = findExistedChannel(seen, c0);

            if (!existed) {
                const first = makeChannel(c0, urls);
                // nếu chưa có trong seen theo idNew thì set
                if (!seen.has(idNew)) seen.set(idNew, first);
                merged.push(first);
                continue;
            }

            // —— Gate merge theo rule —— //
            const idOld = normStr(existed.id).toLowerCase();
            const nameNew = normStr(c0.name);

            const altNamesOld = uniq(existed.altNames);
            const altIdsOldLower = uniqLower(existed.altIds);

            const condSameId = idNew && idOld && idNew === idOld;
            const condNameInAltNamesOld = !!nameNew && altNamesOld.includes(nameNew);
            const condIdInAltIdsOld = !!idNew && altIdsOldLower.includes(idNew);

            const canMerge = condSameId || condNameInAltNamesOld || condIdInAltIdsOld;

            if (canMerge) {
                mergeInto(existed, c0, urls);
            } else {
                // Không merge: tạo kênh mới độc lập theo idNew (nếu chưa có seed cùng id)
                if (!seen.has(idNew)) {
                    const first = makeChannel(c0, urls);
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

function streamM3U(hlsGroups, mpdData) {
    const ts = new TransformStream();
    const writer = ts.writable.getWriter();
    const enc = new TextEncoder();

    (async () => {
        const write = (s) => writer.write(enc.encode(s + "\n"));

        await write(
            `#EXTM3U url-tvg="https://vnepg.site/epg.xml,https://lichphatsong.site/schedule/epg.xml,https://cdn.jsdelivr.net/gh/BurningC4/Chinese-IPTV@master/guide.xml,https://epgshare01.online/epgshare01/epg_ripper_ALL_SOURCES1.xml.gz"`
        );
        await write(`#${new Date().toISOString()}`);

        // console.log(hlsGroups)
        for (const group of toArr(hlsGroups)) {
            const list = toArr(group.channels);
            if (!list.length) continue;
            const groupTitle = normalizeGroupTitle(group.groupName);

            await write("");
            await write(
                `#▽ ================================= ${groupTitle} =================================`
            );
            await write("");

            // console.log(list)
            for (const ch of list) {
                let logo = logoProxy(ch.logo, true);
                if (!logo || logo.includes("imgur")) {
                    logo = `https://ui-avatars.com/api/?format=png&rounded=true&background=random&length=2&size=256&name=${encodeURI(
                        ch.name
                    )}`;
                }
                let channelName = groupTitle.toLowerCase().includes("radio")
                    ? `${ch.name} (Radio)`
                    : ch.name;
                channelName = channelName.toUpperCase();

                for (const u0 of ch.url) {
                    let url = u0;

                    /*
            // thay domain nếu cần
            // if (url.includes('https://xem.TruyenHinh.Click')) {
            //   url = url.replace('https://xem.TruyenHinh.Click', 'https://xem.hoiquan.click');
            // }
  
            // Nhân bản TV360 sk1 -> sk1..sk9
            // if (url.includes('tv360.sk1')) {
            //   for (let i = 1; i <= 9; i++) {
            //     const newUrl = url.replace('tv360.sk1', `tv360.sk${i}`);
            //     const mappedId = `tv360plus${i}`;
            //     const newName = `TV360+ ${i}`;
            //     const newLogo = logoProxy(ch.logo);
  
            //     await write(`#EXTINF:-1 group-title="${groupTitle}" group-logo="${group.groupLogo}" tvg-id="${mappedId}" tvg-logo="${newLogo}",${newName}`);
            //     await write(`#EXTVLCOPT:http-user-agent=Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36`);
            //     await write(newUrl);
            //   }
            // }
            */

                    // Ghi bản gốc
                    if (list.indexOf(ch) == 0) {
                        await write(
                            `#EXTINF:-1 tvg-id="${
                                ch.id
                            }" group-title="${groupTitle}" tvg-logo="${logo}" group-logo="${logoProxy(
                                group.groupLogo,
                                true
                            )}",${channelName}`
                        );
                    } else {
                        await write(
                            `#EXTINF:-1 tvg-id="${ch.id}" group-title="${groupTitle}" tvg-logo="${logo}",${channelName}`
                        );
                    }
                    // await write(`#EXTVLCOPT:http-user-agent=Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36`);
                    await write(url);
                }
                // await write('');
            }

            await write("");
            await write(
                `#△ ================================= ${groupTitle} =================================`
            );
            await write("");
        }

        // MPD ClearKey
        // await write('');
        // await write(`#================================= MPEG-DASH DRM (ClearKey) =================================`);
        // await write('');

        // for (const channel of toArr(mpdData)) {
        //   const { keyId, keyVal } = extractClearKey(channel);
        //   if (!keyId || !keyVal) continue;

        //   let url = channel.url || '';
        //   // if (url.includes('https://live2onsport.vtvcab.vn/onplus')) {
        //   //   url = url.replace('https://live2onsport.vtvcab.vn/onplus', 'https://cdnet-cdn-01.onsports.vn/onplus/');
        //   // }

        //   const logo = logoProxy(channel.logo || '');
        //   const name = channel.name || 'MPD';
        //   const nameId = name.replace(/\s+/g, '');

        //   await write(`#EXTINF:-1 tvg-id="${nameId}" group-title="Kênh MPD" tvg-logo="${logo}",${name}`);
        //   await write(`#EXTVLCOPT:http-user-agent=Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36`);
        //   await write(`#KODIPROP:inputstream.adaptive.license_type=org.w3.clearkey`);
        //   await write(`#KODIPROP:inputstream.adaptive.license_key=${keyId}:${keyVal}`);
        //   await write(url);
        //   await write('');
        // }

        await writer.close();
    })();

    return ts.readable;
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
