require("dotenv").config();
const axios = require("axios");

// ── PASTE YOUR WEBHOOK URLS HERE ──────────────────────────────
const WH_LOW  = "https://discord.com/api/webhooks/1507662157561466992/GmNRfTgZAQ0Z2KbbCQ_u1taBCDg1nq1FfnWrVQKO2nkFNJWwFV8JKGMwFqZCJZwpSCg9";
const WH_MID  = "https://discord.com/api/webhooks/1507662016171606197/ITTSMowtHHontu_EBj-ujn6FZrc6D91c8ZMFZ8DTWVCVSJOr_m3CZJKxhcWC8VUxrknl";
const WH_HIGH = "https://discord.com/api/webhooks/1507661812844462150/8bb18tkXVaTFnRVq_yJ6egnQnH_8YX60UI782UHqoDM476Vfqsf0FMgfPx_zaCFMbx7d";

const SB_URL  = "https://tpvkoxypysixinlehpzr.supabase.co";
const SB_KEY  = "sb_publishable_9DMVAYYzxdA-5LVp1WcKTw_it9fD825";
const POLL_MS = 3000;

const IMAGE_BASE   = "https://cdn.lura.blue/sab/";
const DRAGON_EMOJI = "<:logo:1497938082035662988>";

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
        console.log(`[wh error]`, err.response?.data?.message || err.message);
        return 0;
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

// ── SUPABASE POLL (old logs + live) ──────────────────────────
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
            const name  = row.name     || "";
            const price = row.gen_text || "";
            const ts    = row.timestamp || 0;
            if (!name || !price) continue;

            await sendToDiscord(name, price);
            if (ts > newTs) newTs = ts;

            // same pace as old logs — 1s between each send
            await new Promise(r => setTimeout(r, 1000));
        }
        return newTs;
    } catch (err) {
        console.log("[poll error]", err.message);
        return lastTs;
    }
}

async function main() {
    console.log("Dragon Notifier — fetching old logs then going live");
    console.log(`  HIGH: ${HIGHLIGHTS.size} brainrots | MID: ${MIDLIGHTS.size} | LOW: ${LOWLIGHTS.size} + fallback\n`);

    let lastTs = 0;  // start from beginning — fetches ALL rows

    while (true) {
        lastTs = await poll(lastTs);
        await new Promise(r => setTimeout(r, POLL_MS));
    }
}

main();
