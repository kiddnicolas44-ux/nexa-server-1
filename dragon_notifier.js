require("dotenv").config();
const axios = require("axios");

const BOT_TOKEN = process.env.DISCORD_TOKEN;

const WH_LOW  = process.env.WH_LOW  || "";   // lowlights
const WH_MID  = process.env.WH_MID  || "";   // midlights
const WH_HIGH = process.env.WH_HIGH || "";   // highlights

const SB_URL  = process.env.SUPABASE_URL || "https://tpvkoxypysixinlehpzr.supabase.co";
const SB_KEY  = process.env.SUPABASE_KEY || "sb_publishable_9DMVAYYzxdA-5LVp1WcKTw_it9fD825";
const POLL_MS = parseInt(process.env.POLL_MS) || 3000;

const IMAGE_BASE   = "https://cdn.lura.blue/sab/";
const DRAGON_EMOJI = "<:logo:1497938082035662988>";

// ── MUTATION PREFIXES (strip to get base brainrot name) ───────
const MUTATIONS = new Set([
    "Gold","Diamond","Rainbow","Divine","Crystal","Radioactive",
    "Shadow","Cursed","Lava","Bloodrot","Galaxy","Cyber",
    "YinYang","Candy","Yin","Yang"
    // NOTE: "Hydra" is NOT a mutation — it's part of brainrot names
]);

function baseName(name) {
    const parts = name.split(" ");
    if (parts.length > 1 && MUTATIONS.has(parts[0])) {
        return parts.slice(1).join(" ");
    }
    return name;
}

// ── TIER LISTS (from your channel logs) ──────────────────────
// Highlights — Dragon Cannelloni server brainrots
const HIGHLIGHTS = new Set([
    "Dragon Cannelloni",
    "Hydra Dragon Cannelloni",
    "Foxini Lanternini",
    "La Casa Boo",
    "Ketupat Bros",
    "Quackini Snackini",
    "Hydra Bunny",
    "Dug dug dug",
]);

// Midlights — mid-tier brainrots
const MIDLIGHTS = new Set([
    "Tang Tang Keletang",
    "Garama and Madundung",
    "La Easter Grande",
    "Tictac Sahur",
    "Ketchuru And Musturu",
    "Los Bros",
    "Ketupat Kepat",
    "Nuclearo Dinossauro",
    "Capitano Moby",
    "La Secret Combinasion",
    "Spooky and Pumpky",
    "Burguro And Fryuro",
    "Money Money Bros",
    "Mieteteira Bicicleteira",
    "La Ginger Sekolah",
    "La Lucky Grande",
    "Nacho Spyder",
    "Lavadorito Spinito",
]);

// Lowlights — standard brainrots (always lowlights only unless value pushes them up)
const LOWLIGHTS = new Set([
    "Money Money Puggy",
    "Spaghetti Tualetti",
    "Esok Sekolah",
    "Cigno Fulgoro",
    "Bacuru and Egguru",
    "DJ Panda",
    "Eviledon",
    "Baskito",
    "Churrito Bunnito",
    "Los Candies",
    "Spinny Hammy",
    "Bananito",
    "Snailo Clovero",
    "Ventoliero Pavonero",
    "Tacorillo Crocodillo",
    "La Jolly Grande",
    "Swaggy Bros",
    "Los Puggies",
    "Los Chicleteiras",
]);

// ── ROUTING ───────────────────────────────────────────────────
const _M = {K:1e3, M:1e6, B:1e9, T:1e12};
function parseGenVal(price) {
    if (!price) return 0;
    const m = price.replace(/[$,\/s\s]/g,"").match(/^([\d.]+)([KkMmBbTt]?)$/);
    if (!m) return 0;
    return parseFloat(m[1]) * (_M[m[2].toUpperCase()] || 1);
}

function getChannels(name, price) {
    const base = baseName(name);
    const v    = parseGenVal(price);

    // Name-based routing takes priority over value
    if (HIGHLIGHTS.has(base)) return [WH_LOW, WH_MID, WH_HIGH].filter(Boolean);
    if (MIDLIGHTS.has(base))  return [WH_LOW, WH_MID].filter(Boolean);

    // Known lowlight brainrots stay lowlights regardless of value
    // (unless massive — over 1B still upgrades them)
    if (LOWLIGHTS.has(base)) {
        if (v >= 1e9)   return [WH_LOW, WH_MID, WH_HIGH].filter(Boolean);
        return [WH_LOW].filter(Boolean);
    }

    // Unknown brainrot — route by value
    if (v >= 1e9)   return [WH_LOW, WH_MID, WH_HIGH].filter(Boolean);
    if (v >= 350e6) return [WH_LOW, WH_MID].filter(Boolean);
    return [WH_LOW].filter(Boolean);
}

// ── HELPERS ───────────────────────────────────────────────────
const sbHeaders = {
    apikey:         SB_KEY,
    Authorization:  `Bearer ${SB_KEY}`,
    "Content-Type": "application/json",
};

function timestamp() {
    return new Date().toLocaleString("en-US", {
        month:"short", day:"numeric", year:"numeric",
        hour:"numeric", minute:"2-digit", hour12:true,
    });
}

function imageUrl(name) {
    return IMAGE_BASE + encodeURIComponent(name.replace(/ /g,"_")) + ".png";
}

function buildPayload(name, price) {
    return {
        username: "Dragon Notifier",
        flags: 32768,
        components: [{
            type: 17,
            components: [
                {
                    type: 9,
                    components: [{
                        type: 10,
                        content: `## ${DRAGON_EMOJI} Dragon Notifier\n\n# ${name}\n## ${price}`,
                    }],
                    accessory: {
                        type: 11,
                        media: { url: imageUrl(name) },
                        description: name,
                    },
                },
                { type: 14, divider: true, spacing: 1 },
                { type: 10, content: `-# Dragon Notifier • ${timestamp()}` },
            ],
        }],
        allowed_mentions: { parse: [] },
    };
}

async function postWebhook(url, payload) {
    try {
        const res = await axios.post(url, payload, {
            headers: { "Content-Type": "application/json" },
        });
        return res.status;
    } catch (err) {
        console.log(`[error]`, err.response ? JSON.stringify(err.response.data) : err.message);
        return 0;
    }
}

async function sendToDiscord(name, price) {
    const channels = getChannels(name, price);
    const payload  = buildPayload(name, price);
    const base     = baseName(name);
    const tier     = HIGHLIGHTS.has(base) ? "HIGH" : MIDLIGHTS.has(base) ? "MID" : "LOW";

    console.log(`[send] [${tier}] ${name} | ${price} → ${channels.length} ch`);

    for (const wh of channels) {
        const code = await postWebhook(wh, payload);
        console.log(`  → ${code}`);
        if (channels.length > 1) await new Promise(r => setTimeout(r, 500));
    }
}

// ── SUPABASE POLL ─────────────────────────────────────────────
async function poll(lastTs) {
    try {
        const res = await axios.get(
            `${SB_URL}/rest/v1/finds?timestamp=gt.${lastTs}&order=timestamp.asc&limit=500`,
            { headers: sbHeaders, timeout: 10000 }
        );

        const rows = res.data;
        if (!Array.isArray(rows) || rows.length === 0) return lastTs;
        console.log(`[poll] ${rows.length} new row(s)`);

        let newTs = lastTs;
        for (const row of rows) {
            const name  = row.name     || "";
            const price = row.gen_text || "";
            const ts    = row.timestamp || 0;
            if (!name || !price) continue;
            await sendToDiscord(name, price);
            if (ts > newTs) newTs = ts;
            await new Promise(r => setTimeout(r, 800));
        }
        return newTs;
    } catch (err) {
        console.log("[poll error]", err.message);
        return lastTs;
    }
}

async function main() {
    console.log("Dragon Notifier");
    console.log(`  highlights: ${HIGHLIGHTS.size} brainrots + $1B+`);
    console.log(`  midlights:  ${MIDLIGHTS.size} brainrots + $350M+`);
    console.log(`  lowlights:  ${LOWLIGHTS.size} brainrots + everything else`);
    if (!WH_LOW)  console.log("[warn] WH_LOW not set");
    if (!WH_MID)  console.log("[warn] WH_MID not set");
    if (!WH_HIGH) console.log("[warn] WH_HIGH not set");

    let lastTs = 0;  // fetch ALL existing rows first, then stay live
    console.log(`[ready] fetching all historical rows then polling every ${POLL_MS / 1000}s\n`);

    while (true) {
        lastTs = await poll(lastTs);
        await new Promise(r => setTimeout(r, POLL_MS));
    }
}

main();
