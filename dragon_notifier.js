require("dotenv").config();
const axios = require("axios");

const BOT_TOKEN  = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
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

function imageUrl(name) {
    return IMAGE_BASE + encodeURIComponent(name.replace(/ /g, "_")) + ".png";
}

async function sendToDiscord(name, price) {
    if (!BOT_TOKEN || !CHANNEL_ID) {
        console.log("[warn] DISCORD_TOKEN or CHANNEL_ID missing");
        return;
    }

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
            `https://discord.com/api/v10/channels/${CHANNEL_ID}/messages`,
            payload,
            { headers: { Authorization: `Bot ${BOT_TOKEN}`, "Content-Type": "application/json" } }
        );
        console.log(`[sent] ${name} | ${price} | ${res.status}`);
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
    if (!CHANNEL_ID) console.log("[warn] CHANNEL_ID not set");

    let lastTs = Math.floor(Date.now() / 1000) - 30;
    console.log(`[ready] polling every ${POLL_MS / 1000}s from ts=${lastTs}`);

    while (true) {
        lastTs = await poll(lastTs);
        await new Promise(r => setTimeout(r, POLL_MS));
    }
}

main();
