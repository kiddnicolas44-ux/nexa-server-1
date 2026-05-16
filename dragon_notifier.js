require("dotenv").config();
const axios = require("axios");
const WebSocket = require("ws");

const BOT_TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const WS_URL = "wss://dexfreewss-production.up.railway.app/ws";

const IMAGE_BASE = "https://cdn.lura.blue/sab/";
const DRAGON_EMOJI = "<:logo:1497938082035662988>";

async function getImageUrl(name) {
    const primary = IMAGE_BASE + encodeURIComponent(name.replace(/ /g, "_")) + ".png";
    try {
        const check = await axios.head(primary, { timeout: 3000 });
        if (check.status === 200) return primary;
    } catch {}

    try {
        const wiki = await axios.get(
            `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(name)}`,
            { timeout: 4000 }
        );
        if (wiki.data?.thumbnail?.source) return wiki.data.thumbnail.source;
    } catch {}

    return primary;
}

function timestamp() {
    return new Date().toLocaleString("en-US", {
        month: "short", day: "numeric", year: "numeric",
        hour: "numeric", minute: "2-digit", hour12: true
    });
}

async function sendDragonNotifier(name, money, players, jobId) {
    if (!BOT_TOKEN) return console.log("Missing DISCORD_TOKEN in .env");
    if (!CHANNEL_ID) return console.log("Missing CHANNEL_ID in .env");

    const payload = {
        flags: 32768,
        components: [
            {
                type: 17,
                components: [
                    {
                        type: 9,
                        components: [
                            {
                                type: 10,
                                content: `## ${DRAGON_EMOJI} Dragon Notifier\n\n# ${name}\n## ${money}/s`
                            }
                        ],
                        accessory: {
                            type: 11,
                            media: { url: await getImageUrl(name) },
                            description: name
                        }
                    },
                    { type: 14, divider: true, spacing: 1 },
                    {
                        type: 10,
                        content: `### Server Info\n\n**Players:** \`${players}/8\`\n\n**Job ID:**\n\`\`\`\n${jobId}\n\`\`\``
                    },
                    { type: 14, divider: true, spacing: 1 },
                    {
                        type: 10,
                        content: `-# Dragon Notifier • ${timestamp()}`
                    }
                ]
            }
        ],
        allowed_mentions: { parse: [] }
    };

    try {
        const res = await axios.post(
            `https://discord.com/api/v10/channels/${CHANNEL_ID}/messages`,
            payload,
            { headers: { Authorization: `Bot ${BOT_TOKEN}`, "Content-Type": "application/json" } }
        );
        console.log(`[sent] ${name} | ${money}/s | ${players}/8 | ${res.status}`);
        return true;
    } catch (error) {
        console.log("[error]", error.response ? JSON.stringify(error.response.data) : error.message);
        return false;
    }
}

function connect() {
    console.log(`[${new Date().toLocaleTimeString()}] Connecting to dexfreewss...`);
    const ws = new WebSocket(WS_URL);

    ws.on("open", () => console.log(`[${new Date().toLocaleTimeString()}] Connected`));

    ws.on("message", (data) => {
        const msg = data.toString().trim();
        console.log(`[msg] ${msg}`);
        const parts = msg.split("|").map(p => p.trim());
        if (parts.length >= 4) {
            const [name, money, players, jobId] = parts;
            sendDragonNotifier(name, money, players, jobId);
        }
    });

    ws.on("error", (e) => console.error(`[error] ${e.message}`));

    ws.on("close", () => {
        console.log(`[${new Date().toLocaleTimeString()}] Disconnected — reconnecting in 3s...`);
        setTimeout(connect, 3000);
    });
}

connect();

module.exports = { sendDragonNotifier };
