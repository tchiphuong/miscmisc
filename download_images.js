// download_images.js
const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const { pipeline } = require("stream");
const { promisify } = require("util");

const streamPipeline = promisify(pipeline);

const hlsData = require("./hls.json");
const outputDir = path.join(__dirname, "iptv", "img");

// ensure output directory
fs.mkdirSync(outputDir, { recursive: true });

// map content-type -> extension
const EXT_BY_TYPE = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/webp": ".webp",
    "image/svg+xml": ".svg",
    "image/gif": ".gif",
    "image/x-icon": ".ico",
    "image/vnd.microsoft.icon": ".ico",
};

// simple concurrency limit
function pLimit(max) {
    const queue = [];
    let active = 0;
    const next = () => {
        if (active >= max || queue.length === 0) return;
        active++;
        const { fn, resolve, reject } = queue.shift();
        fn()
            .then((v) => {
                active--;
                resolve(v);
                next();
            })
            .catch((e) => {
                active--;
                reject(e);
                next();
            });
    };
    return (fn) =>
        new Promise((resolve, reject) => {
            queue.push({ fn, resolve, reject });
            next();
        });
}

const limit = pLimit(8); // tải tối đa 8 ảnh cùng lúc

function pickModule(u) {
    return u.startsWith("https:") ? https : http;
}

function guessExtFromUrl(u) {
    try {
        const p = new URL(u).pathname;
        const ext = path.extname(p).toLowerCase();
        return ext || "";
    } catch {
        return "";
    }
}

function pickExt(contentType, fallbackUrl) {
    if (contentType) {
        const ct = contentType.split(";")[0].trim().toLowerCase();
        if (EXT_BY_TYPE[ct]) return EXT_BY_TYPE[ct];
    }
    const extFromUrl = guessExtFromUrl(fallbackUrl);
    if (
        extFromUrl &&
        [".png", ".jpg", ".jpeg", ".webp", ".svg", ".gif", ".ico"].includes(extFromUrl)
    )
        return extFromUrl === ".jpeg" ? ".jpg" : extFromUrl;
    return ".png"; // default
}

async function headOrGet(u, method = "GET", redirectsLeft = 5) {
    return new Promise((resolve, reject) => {
        const mod = pickModule(u);
        const req = mod.request(
            u,
            {
                method,
                headers: {
                    "User-Agent": "Mozilla/5.0 (compatible; ImageFetcher/1.0)",
                    Accept: "image/*,*/*;q=0.8",
                    "Accept-Encoding": "identity",
                    Connection: "close",
                },
                timeout: 15000, // 15s
            },
            (res) => {
                const { statusCode, headers } = res;
                // handle redirects
                if ([301, 302, 303, 307, 308].includes(statusCode)) {
                    res.resume(); // drain
                    if (redirectsLeft <= 0) return reject(new Error(`Too many redirects for ${u}`));
                    const loc = headers.location;
                    if (!loc) return reject(new Error(`Redirect without Location for ${u}`));
                    const nextUrl = new URL(loc, u).toString();
                    return headOrGet(nextUrl, method, redirectsLeft - 1)
                        .then(resolve)
                        .catch(reject);
                }
                resolve({ res, url: u });
            }
        );

        req.on("timeout", () => req.destroy(new Error(`Timeout after 15s for ${u}`)));
        req.on("error", reject);
        req.end();
    });
}

async function downloadImage(imageUrl, outBasePath, retries = 2) {
    try {
        // First GET to read headers & stream body (headOrGet already opens response)
        const { res, url: finalUrl } = await headOrGet(imageUrl, "GET");
        if (res.statusCode !== 200) {
            res.resume();
            throw new Error(`HTTP ${res.statusCode}`);
        }

        const ext = pickExt(res.headers["content-type"], finalUrl);
        const outPath = outBasePath + ext;
        const tmpPath = outPath + ".tmp";

        // If file exists and size > 0, skip
        if (fs.existsSync(outPath)) {
            const stat = fs.statSync(outPath);
            if (stat.size > 0) {
                res.resume();
                return { outPath, skipped: true };
            }
        }

        // write to tmp then rename
        const fileStream = fs.createWriteStream(tmpPath, { flags: "w" });
        await streamPipeline(res, fileStream);
        fs.renameSync(tmpPath, outPath);

        return { outPath, skipped: false };
    } catch (err) {
        if (retries > 0) {
            // small backoff
            await new Promise((r) => setTimeout(r, 500));
            return downloadImage(imageUrl, outBasePath, retries - 1);
        }
        throw err;
    }
}

function safeBaseName(text, fallback) {
    // dùng id làm base name — giữ nguyên chữ/số, thay ký tự khác bằng '-'
    const safe = String(text || "")
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");
    return safe || fallback || "unknown";
}

async function processImages() {
    const processed = new Set(); // dedupe theo URL gốc
    const tasks = [];

    for (const group of hlsData || []) {
        for (const channel of group.channels || []) {
            const logo = channel.logo;
            if (!logo || processed.has(logo)) continue;

            const base = safeBaseName(channel.id, channel.name);
            const outBasePath = path.join(outputDir, base);

            tasks.push(
                limit(async () => {
                    try {
                        console.log(`⬇️  ${logo}`);
                        const { outPath, skipped } = await downloadImage(logo, outBasePath);
                        console.log(
                            skipped
                                ? `⏭️  Skipped (exists): ${path.basename(outPath)}`
                                : `✅ Saved: ${path.basename(outPath)}`
                        );
                    } catch (e) {
                        console.error(`❌ Failed: ${logo} -> ${base}`, e.message);
                    }
                })
            );

            processed.add(logo);
        }
    }

    await Promise.all(tasks);
}

processImages()
    .then(() => console.log("🎉 Download complete!"))
    .catch((e) => console.error("💥 Error:", e));

// RUN: node download_images.js
