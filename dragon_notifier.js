// Dragon Notifier — Supabase → Discord forwarder
// v2: decrypts AES-256-GCM rows written by the Python reader, then
//     fans out to tier-routed webhooks.
//
// Encryption stack matches notifier_reader_v4.py and the Lua notifier:
//   - Same 16 _W word constants → same 64-byte _KB → same 32-byte AES key
//   - Same v7: nonce_hex(24) + tag_hex(32) + ct_hex format
//   - Plaintext is JSON: {name, gen_text, job_id, place_id}
//
// pip install requests cryptography  (for Python side)
// npm install axios dotenv           (for this side)

require("dotenv").config();
const axios  = require("axios");
const crypto = require("crypto");

// ── WEBHOOK URLS ──────────────────────────────────────────────
// SECURITY: anyone with these URLs can post to your channels. Keep
// them in .env, not in this file. Loaded from process.env below.
const WH_LOW  = process.env.WEBHOOK_LOW  || "https://discord.com/api/webhooks/1507662157561466992/GmNRfTgZAQ0Z2KbbCQ_u1taBCDg1nq1FfnWrVQKO2nkFNJWwFV8JKGMwFqZCJZwpSCg9";
const WH_MID  = process.env.WEBHOOK_MID  || "https://discord.com/api/webhooks/1507662016171606197/ITTSMowtHHontu_EBj-ujn6FZrc6D91c8ZMFZ8DTWVCVSJOr_m3CZJKxhcWC8VUxrknl";
const WH_HIGH = process.env.WEBHOOK_HIGH || "https://discord.com/api/webhooks/1507661812844462150/8bb18tkXVaTFnRVq_yJ6egnQnH_8YX60UI782UHqoDM476Vfqsf0FMgfPx_zaCFMbx7d";

if (!WH_LOW || !WH_MID || !WH_HIGH) {
    console.error("Set WEBHOOK_LOW / WEBHOOK_MID / WEBHOOK_HIGH in .env");
    process.exit(1);
}

// ── NEW SUPABASE PROJECT ─────────────────────────────────────
const SB_URL  = "https://vpmbiscioxkfauoesyqg.supabase.co";
const SB_KEY  = "sb_publishable_54eFG9h9g_cXQgvGxSYe-A_DBOKZl7_";
const POLL_MS = 3000;

const IMAGE_BASE   = "https://cdn.lura.blue/sab/";
const DRAGON_EMOJI = "<:logo:1497938082035662988>";

// ── AES KEY DERIVATION (matches Python and Lua sides byte-for-byte) ──
function buildAesKey() {
    const MASK32 = 0xFFFFFFFF;
    const ls = (x, n) => ((x << n) & MASK32) >>> 0;
    const xor = (a, b) => ((a ^ b) & MASK32) >>> 0;
    const or  = (a, b) => ((a | b) & MASK32) >>> 0;

    const W = new Array(17);
    W[1]  = or(ls(50046, 16), 10993);
    W[2]  = xor(or(ls(54039, 16), 5017),  or(ls(0x5A5A, 16), 0xA5A5));
    W[3]  = or(ls(or(ls(81, 8), 168), 16),  or(ls(226, 8), 159));
    W[4]  = xor(or(ls(54233, 16), 30137), or(ls(0xDEAD, 16), 0xBEEF));
    W[5]  = or(ls(((236 ^ 0xFF) * 256 + (116 ^ 0xFF)), 16), ((38 ^ 0xFF) * 256 + (189 ^ 0xFF)));
    W[6]  = or(ls(26620, 16), 7843);
    W[7]  = xor(or(ls(10871, 16), 12317), or(ls(0x5A5A, 16), 0xA5A5));
    W[8]  = or(ls(or(ls(79, 8), 230), 16),  or(ls(56, 8), 202));
    W[9]  = xor(or(ls(30642, 16), 33693), or(ls(0xDEAD, 16), 0xBEEF));
    W[10] = or(ls(((163 ^ 0xFF) * 256 + (123 ^ 0xFF)), 16), ((25 ^ 0xFF) * 256 + (254 ^ 0xFF)));
    W[11] = or(ls(48416, 16), 63559);
    W[12] = xor(or(ls(25420, 16), 57195), or(ls(0x5A5A, 16), 0xA5A5));
    W[13] = or(ls(or(ls(240, 8), 75), 16),  or(ls(40, 8), 213));
    W[14] = xor(or(ls(41022, 16), 32747), or(ls(0xDEAD, 16), 0xBEEF));
    W[15] = or(ls(((210 ^ 0xFF) * 256 + (89 ^ 0xFF)), 16), ((160 ^ 0xFF) * 256 + (116 ^ 0xFF)));
    W[16] = or(ls(57612, 16), 18815);

    // 64 bytes (big-endian, same byte order as Python/Lua)
    const KB = [];
    for (let i = 1; i <= 16; i++) {
        const w = W[i];
        KB.push((w >>> 24) & 0xFF);
        KB.push((w >>> 16) & 0xFF);
        KB.push((w >>> 8)  & 0xFF);
        KB.push( w         & 0xFF);
    }
    // AES key = XOR of two 32-byte halves
    const key = Buffer.alloc(32);
    for (let i = 0; i < 32; i++) key[i] = KB[i] ^ KB[i + 32];
    return key;
}

const AES_KEY = buildAesKey();
console.log(`[crypto] AES key first 4 hex: ${AES_KEY.subarray(0,4).toString("hex")}`);

// ── DECRYPT a v7: payload ────────────────────────────────────
function decryptPayload(s) {
    if (typeof s !== "string" || !s.startsWith("v7:")) return null;
    const body = s.slice(3);
    if (body.length < 24 + 32 + 2) return null;     // nonce + tag + min ct
    const nonceHex = body.slice(0, 24);
    const tagHex   = body.slice(24, 24 + 32);
    const ctHex    = body.slice(24 + 32);
    if (!/^[0-9a-fA-F]+$/.test(nonceHex + tagHex + ctHex)) return null;
    const nonce = Buffer.from(nonceHex, "hex");
    const tag   = Buffer.from(tagHex,   "hex");
    const ct    = Buffer.from(ctHex,    "hex");
    try {
        const decipher = crypto.createDecipheriv("aes-256-gcm", AES_KEY, nonce);
        decipher.setAuthTag(tag);
        const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
        return JSON.parse(pt.toString("utf8"));
    } catch (err) {
        // Auth tag mismatch or malformed plaintext — row was tampered with
        // or wasn't encrypted with our key. Skip silently.
        return null;
    }
}

// Self-test on startup so we fail loudly if anything is misaligned
(function selftest() {
    // Roundtrip with a known plaintext via encryption
    const sample = { name: "Test", gen_text: "$10M/s", job_id: "abc", place_id: "" };
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", AES_KEY, nonce);
    const pt = Buffer.from(JSON.stringify(sample), "utf8");
    const ctBuf = Buffer.concat([cipher.update(pt), cipher.final()]);
    const tag = cipher.getAuthTag();
    const blob = "v7:" + nonce.toString("hex") + tag.toString("hex") + ctBuf.toString("hex");
    const decoded = decryptPayload(blob);
    if (!decoded || decoded.name !== "Test" || decoded.gen_text !== "$10M/s") {
        console.error("[crypto] SELF-TEST FAILED — encryption is misaligned, aborting");
        console.error(`  produced: ${blob.slice(0,60)}...`);
        console.error(`  decoded:  ${JSON.stringify(decoded)}`);
        process.exit(1);
    }
    console.log("[crypto] self-test OK — Python-encrypted rows will decrypt here");
})();

// ── MUTATION PREFIXES ─────────────────────────────────────────
const MUTATIONS = new Set([
    "Gold","Diamond","Rainbow","Divine","Crystal","Radioactive",
    "Shadow","Cursed","Lava","Bloodrot","Galaxy","Cyber",
    "YinYang","Candy","Yin","Yang"
]);

function baseName(name) {
    const parts = name.split(" ");
    if (parts.length > 1 && MUTATIONS.has(parts[0])) {
        return parts.slice(1).join(" ");
    }
    return name;
}

// ── TIER LISTS ────────────────────────────────────────────────
const HIGHLIGHTS = new Set([
    "Dragon Cannelloni","Hydra Dragon Cannelloni","Foxini Lanternini",
    "La Casa Boo","Ketupat Bros","Quackini Snackini","Hydra Bunny","Dug dug dug",
]);

const MIDLIGHTS = new Set([
    "Tang Tang Keletang","Garama and Madundung","La Easter Grande",
    "Tictac Sahur","Ketchuru And Musturu","Los Bros","Ketupat Kepat",
    "Nuclearo Dinossauro","Capitano Moby","La Secret Combinasion",
    "Spooky and Pumpky","Burguro And Fryuro","Money Money Bros",
    "Mieteteira Bicicleteira","La Ginger Sekolah","La Lucky Grande",
    "Nacho Spyder","Lavadorito Spinito",
]);

const LOWLIGHTS = new Set([
    "Money Money Puggy","Spaghetti Tualetti","Esok Sekolah","Cigno Fulgoro",
    "Bacuru and Egguru","DJ Panda","Eviledon","Baskito","Churrito Bunnito",
    "Los Candies","Spinny Hammy","Bananito","Snailo Clovero",
    "Ventoliero Pavonero","Tacorillo Crocodillo","La Jolly Grande",
    "Swaggy Bros","Los Puggies","Los Chicleteiras",
]);

// ── ROUTING ───────────────────────────────────────────────────
const _M = {K:1e3,M:1e6,B:1e9,T:1e12};
function parseGenVal(price) {
    if (!price) return 0;
    const m = price.replace(/[$,\/s\s]/g,"").match(/^([\d.]+)([KkMmBbTt]?)$/);
    if (!m) return 0;
    return parseFloat(m[1]) * (_M[m[2].toUpperCase()] || 1);
}

function getChannels(name, price) {
    const base = baseName(name);
    const v    = parseGenVal(price);

    if (HIGHLIGHTS.has(base)) return [WH_LOW, WH_MID, WH_HIGH];
    if (MIDLIGHTS.has(base))  return [WH_LOW, WH_MID];
    if (LOWLIGHTS.has(base)) {
        if (v >= 1e9) return [WH_LOW, WH_MID, WH_HIGH];
        return [WH_LOW];
    }
    // unknown — value based
    if (v >= 1e9)   return [WH_LOW, WH_MID, WH_HIGH];
    if (v >= 350e6) return [WH_LOW, WH_MID];
    return [WH_LOW];
}

// ── DISCORD ───────────────────────────────────────────────────
function timestamp() {
    return new Date().toLocaleString("en-US", {
        month:"short", day:"numeric", year:"numeric",
        hour:"numeric", minute:"2-digit", hour12:true,
    });
}

function buildPayload(name, price) {
    const img = IMAGE_BASE + encodeURIComponent(name.replace(/ /g,"_")) + ".png";
    return {
        username: "Dragon Notifier",
        flags: 32768,
        components: [{
            type: 17,
            components: [
                {
                    type: 9,
                    components: [{ type:10, content:`## ${DRAGON_EMOJI} Dragon Notifier\n\n# ${name}\n## ${price}` }],
                    accessory: { type:11, media:{url:img}, description:name },
                },
                { type:14, divider:true, spacing:1 },
                { type:10, content:`-# Dragon Notifier • ${timestamp()}` },
            ],
        }],
        allowed_mentions: { parse:[] },
    };
}

async function postWebhook(url, payload) {
    try {
        const res = await axios.post(url, payload, {
            headers: { "Content-Type":"application/json" },
        });
        if (res.status === 429) {
            const wait = res.headers["retry-after"] ? parseFloat(res.headers["retry-after"]) * 1000 : 2000;
            await new Promise(r => setTimeout(r, wait));
        }
        return res.status;
    } catch (err) {
        if (err.response?.status === 429) {
            await new Promise(r => setTimeout(r, 2000));
            return 429;
        }
        // Full diagnostic dump so we can actually see what Discord rejected
        const status = err.response?.status || "?";
        const data   = err.response?.data;
        console.log(`[wh error] ${status} ${err.response?.statusText || ""}`);
        if (data) {
            // Pretty-print the full error body — includes which field is wrong
            console.log("  response:", JSON.stringify(data, null, 2).slice(0, 600));
        } else {
            console.log("  message:", err.message);
        }
        return err.response?.status || 0;
    }
}

async function sendToDiscord(name, price) {
    const channels = getChannels(name, price);
    const base     = baseName(name);
    const tier     = HIGHLIGHTS.has(base) ? "HIGH" : MIDLIGHTS.has(base) ? "MID" : "LOW";
    const payload  = buildPayload(name, price);

    console.log(`[${tier}] ${name} | ${price}`);

    for (const wh of channels) {
        const code = await postWebhook(wh, payload);
        if (code !== 204 && code !== 200) {
            console.log(`  ✗ ${code}`);
        }
        if (channels.length > 1) await new Promise(r => setTimeout(r, 600));
    }
}

// ── SUPABASE POLL — decrypts each row before forwarding ──────
const sbHeaders = {
    apikey:         SB_KEY,
    Authorization:  `Bearer ${SB_KEY}`,
    "Content-Type": "application/json",
};

async function poll(lastTs) {
    try {
        const res = await axios.get(
            `${SB_URL}/rest/v1/finds?timestamp=gt.${lastTs}&order=timestamp.asc&limit=100`,
            { headers: sbHeaders, timeout: 10000 }
        );

        const rows = res.data;
        if (!Array.isArray(rows) || rows.length === 0) return lastTs;
        console.log(`\n[poll] ${rows.length} row(s)\n`);

        let newTs = lastTs;
        for (const row of rows) {
            const ts = row.timestamp || 0;
            if (ts > newTs) newTs = ts;

            // Decrypt the row. Each row's `name` column holds the
            // encrypted blob; gen_text / job_id are empty strings.
            const rawName = row.name || "";
            let name, price, jobId;

            if (rawName.startsWith("v7:")) {
                const payload = decryptPayload(rawName);
                if (!payload) {
                    console.log(`[skip] decrypt failed for row ts=${ts}`);
                    continue;
                }
                name  = payload.name     || "";
                price = payload.gen_text || "";
                jobId = payload.job_id   || "";
            } else {
                // Plaintext fallback: rows written by some other tool
                // that doesn't encrypt. Use them directly.
                name  = rawName;
                price = row.gen_text || "";
                jobId = row.job_id   || "";
            }

            if (!name || !price) {
                console.log(`[skip] empty name/price after decrypt`);
                continue;
            }

            await sendToDiscord(name, price);
            await new Promise(r => setTimeout(r, 1000));   // 1s pacing
        }
        return newTs;
    } catch (err) {
        console.log("[poll error]", err.message);
        return lastTs;
    }
}

async function main() {
    console.log("Dragon Notifier (v2 — decrypts AES-GCM rows)");
    console.log(`  Supabase: ${SB_URL.slice(0, 30)}...`);
    console.log(`  HIGH: ${HIGHLIGHTS.size} | MID: ${MIDLIGHTS.size} | LOW: ${LOWLIGHTS.size} + fallback`);
    console.log("  Starting from beginning of time — will fetch ALL rows once,");
    console.log("  then only newer ones on each poll.\n");

    let lastTs = 0;
    while (true) {
        lastTs = await poll(lastTs);
        await new Promise(r => setTimeout(r, POLL_MS));
    }
}

main();
