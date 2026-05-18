require("dotenv").config();
const axios = require("axios");

const BOT_TOKEN = process.env.DISCORD_TOKEN;

// tier channels by gen value
const CH_LOW  = "1497874973405220895";  // $1M  – $50M
const CH_MID  = "1497874234444087397";  // $51M – $300M
const CH_HIGH = "1497874147605217340";  // $300M+
const SB_URL     = process.env.SUPABASE_URL || "https://tpvkoxypysixinlehpzr.supabase.co";
const SB_KEY     = process.env.SUPABASE_KEY || "sb_publishable_9DMVAYYzxdA-5LVp1WcKTw_it9fD825";
const POLL_MS    = parseInt(process.env.POLL_MS) || 3000;

const IMAGE_BASE   = "https://cdn.lura.blue/sab/";
const DRAGON_EMOJI = "<:logo:1497938082035662988>";

const sbHeaders = {
    apikey:         SB_KEY,
    Authorization:  `Bearer ${SB_KEY}`,
    "Content-Type": "application/json",
};

function timestamp() {
    return new Date().toLocaleString("en-US", {
        month: "short", day: "numeric", year: "numeric",
        hour: "numeric", minute: "2-digit", hour12: true,
    });
}

function parseGenVal(price) {
    if (!price) return 0;
    const m = price.replace(/,/g, "").match(/([\d.]+)\s*([KkMmBbTt]?)/);
    if (!m) return 0;
    const n = parseFloat(m[1]);
    const s = m[2].toUpperCase();
    const mult = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 }[s] || 1;
    return n * mult;
}

function pickChannel(price) {
    const v = parseGenVal(price);
    if (v >= 300e6) return CH_HIGH;
    if (v >= 51e6)  return CH_MID;
    return CH_LOW;
}

function imageUrl(name) {
    return IMAGE_BASE + encodeURIComponent(name.replace(/ /g, "_")) + ".png";
}

async function sendToDiscord(name, price) {
    if (!BOT_TOKEN) {
        console.log("[warn] DISCORD_TOKEN missing");
        return;
    }
    const channelId = pickChannel(price);

    const payload = {
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
                {
                    type: 10,
                    content: `-# Dragon Notifier • ${timestamp()}`,
                },
            ],
        }],
        allowed_mentions: { parse: [] },
    };

    try {
        const res = await axios.post(
            `https://discord.com/api/v10/channels/${channelId}/messages`,
            payload,
            { headers: { Authorization: `Bot ${BOT_TOKEN}`, "Content-Type": "application/json" } }
        );
        console.log(`[sent] ${name} | ${price} | ch=${channelId} | ${res.status}`);
    } catch (err) {
        console.log("[error]", err.response ? JSON.stringify(err.response.data) : err.message);
    }
}

async function poll(lastTs) {
    try {
        const res = await axios.get(
            `${SB_URL}/rest/v1/finds?timestamp=gt.${lastTs}&order=timestamp.asc&limit=50`,
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
            await new Promise(r => setTimeout(r, 500));
        }
        return newTs;
    } catch (err) {
        console.log("[poll error]", err.message);
        return lastTs;
    }
}

async function main() {
    console.log("Dragon Notifier — Supabase → Discord");
    if (!BOT_TOKEN)  console.log("[warn] DISCORD_TOKEN not set");

    let lastTs = Math.floor(Date.now() / 1000) - 30;
    console.log(`[ready] polling every ${POLL_MS / 1000}s from ts=${lastTs}`);

    while (true) {
        lastTs = await poll(lastTs);
        await new Promise(r => setTimeout(r, POLL_MS));
    }
}

main();
