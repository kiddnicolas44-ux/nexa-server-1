const http  = require("http")
const https = require("https")
const PORT   = process.env.PORT || 3002
const SECRET = process.env.API_SECRET || "ae55e3445f7e585c6295c103f0f5c245fa7275aa4bea8b9bfbffbf6e7ca6e719"
const GAME_ID = process.env.GAME_ID || "109983668079237"

// ── AUTH ─────────────────────────────────────────────────────
function auth(req, res) {
    if (req.headers["x-api-secret"] !== SECRET) {
        send(res, 401, { error: "Unauthorized" }); return false
    }
    return true
}

// ── HELPERS ──────────────────────────────────────────────────
function send(res, code, obj) {
    const b = JSON.stringify(obj)
    res.writeHead(code, { "Content-Type": "application/json" })
    res.end(b)
}

function readBody(req) {
    return new Promise(resolve => {
        let d = ""
        req.on("data", c => d += c)
        req.on("end", () => { try { resolve(JSON.parse(d)) } catch { resolve({}) } })
    })
}

// ── ROBLOX SERVER LIST FETCHER ────────────────────────────────
// Railway has a different IP than the bots — Roblox rate limits per IP
// so fetching from here never affects the bots at all
function fetchServers(cursor = "") {
    return new Promise((resolve) => {
        const path = `/v1/games/${GAME_ID}/servers/Public?sortOrder=Asc&limit=100` +
                     (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "")
        const options = {
            hostname: "games.roblox.com",
            path,
            method: "GET",
            headers: {
                "Accept":     "application/json",
                "User-Agent": "Mozilla/5.0",
            },
            timeout: 12000,
        }
        const req = https.request(options, (resp) => {
            let data = ""
            resp.on("data", c => data += c)
            resp.on("end", () => {
                try {
                    const json = JSON.parse(data)
                    resolve({ ok: true, data: json })
                } catch {
                    resolve({ ok: false, error: "JSON parse error", status: resp.statusCode })
                }
            })
        })
        req.on("error", e => resolve({ ok: false, error: e.message }))
        req.on("timeout", () => { req.destroy(); resolve({ ok: false, error: "Timeout" }) })
        req.end()
    })
}

// ── SERVER POOL ───────────────────────────────────────────────
// Fetched servers cached here — refreshed every 30s automatically
// Bots call /get-server to pop one off the list
let serverPool    = []   // { id, playing, maxPlayers }
let poolCursor    = ""
let lastFetch     = 0
let fetchingNow   = false
const CACHE_MS    = 20_000   // refresh pool every 20s (15 bots chew through servers fast)
const STALE_MS    = 120_000  // remove servers not refreshed in 2min

// Track which servers bots are currently in so we don't send them back there
const claimedServers = new Map()  // jobId → { botName, claimedAt }
const CLAIM_TTL      = 45_000     // claim expires after 45s

function purgeClaims() {
    const now = Date.now()
    for (const [id, c] of claimedServers) {
        if (now - c.claimedAt > CLAIM_TTL) claimedServers.delete(id)
    }
}

async function refreshPool() {
    if (fetchingNow) return
    fetchingNow = true
    console.log("[pool] Refreshing server list...")

    const fresh = []
    let cursor  = ""
    let pages   = 0

    // 1 page = 100 servers, plenty for 15 bots
    while (pages < 1) {
        const result = await fetchServers(cursor)
        if (!result.ok || !result.data || !result.data.data) {
            console.log("[pool] Fetch failed:", result.error || result.status)
            break
        }
        for (const s of result.data.data) {
            if (s.id && typeof s.playing === "number" && typeof s.maxPlayers === "number") {
                fresh.push({ id: s.id, playing: s.playing, maxPlayers: s.maxPlayers, addedAt: Date.now() })
            }
        }
        cursor = result.data.nextPageCursor || ""
        pages++
        if (!cursor) break
        await new Promise(r => setTimeout(r, 300))  // small delay between pages
    }

    // Shuffle so multiple bots don't all grab index 0
    for (let i = fresh.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [fresh[i], fresh[j]] = [fresh[j], fresh[i]]
    }

    serverPool = fresh
    lastFetch  = Date.now()
    fetchingNow = false
    console.log(`[pool] ${serverPool.length} servers cached`)
}

// Auto-refresh every 30s
refreshPool()
setInterval(refreshPool, CACHE_MS)

// ── HTTP SERVER ───────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
    const url    = req.url.split("?")[0]
    const params = Object.fromEntries(new URLSearchParams((req.url.split("?")[1] || "")))

    if (!auth(req, res)) return

    // GET /get-server?exclude=JOB_ID&botName=NAME
    // Returns one server the bot hasn't visited, that isn't claimed by another bot
    // Marks it as claimed so other bots skip it
    if (req.method === "GET" && url === "/get-server") {
        purgeClaims()
        const exclude = params.exclude || ""
        const botName = params.botName || "unknown"

        // Trigger refresh if pool is stale or empty
        if (serverPool.length === 0 || Date.now() - lastFetch > CACHE_MS) {
            if (!fetchingNow) refreshPool()
        }

        // Find first server that: isn't excluded, isn't claimed, isn't full
        const picked = serverPool.find(s =>
            s.id !== exclude &&
            !claimedServers.has(s.id) &&
            s.playing < s.maxPlayers
        )

        if (!picked) {
            // All non-full servers claimed — try including claimed ones as fallback
            const fallback = serverPool.find(s => s.id !== exclude)
            if (!fallback) return send(res, 404, { error: "No servers available — pool refreshing" })
            claimedServers.set(fallback.id, { botName, claimedAt: Date.now() })
            console.log(`[hop] ${botName} → ${fallback.id} (fallback, pool: ${serverPool.length})`)
            return send(res, 200, { job_id: fallback.id, playing: fallback.playing, maxPlayers: fallback.maxPlayers })
        }

        claimedServers.set(picked.id, { botName, claimedAt: Date.now() })
        console.log(`[hop] ${botName} → ${picked.id} (${picked.playing}/${picked.maxPlayers}, pool: ${serverPool.length})`)
        return send(res, 200, { job_id: picked.id, playing: picked.playing, maxPlayers: picked.maxPlayers })
    }

    // POST /claim  { jobId, botName }
    // Bot calls this when it joins a server — prevents others hopping there
    if (req.method === "POST" && url === "/claim") {
        const body = await readBody(req)
        if (!body.jobId) return send(res, 400, { error: "jobId required" })
        claimedServers.set(body.jobId, { botName: body.botName || "?", claimedAt: Date.now() })
        console.log(`[claim] ${body.botName || "?"} claimed ${body.jobId}`)
        return send(res, 200, { ok: true })
    }

    // POST /unclaim  { jobId }
    // Bot calls this when leaving — frees the server for others
    if (req.method === "POST" && url === "/unclaim") {
        const body = await readBody(req)
        if (body.jobId) claimedServers.delete(body.jobId)
        return send(res, 200, { ok: true })
    }

    // GET /status
    if (req.method === "GET" && (url === "/status" || url === "/")) {
        return send(res, 200, {
            ok:          true,
            pool:        serverPool.length,
            claimed:     claimedServers.size,
            lastRefresh: Math.floor((Date.now() - lastFetch) / 1000) + "s ago",
            uptime:      Math.floor(process.uptime()) + "s",
        })
    }

    send(res, 404, { error: "Not found" })
})

server.listen(PORT, "0.0.0.0", () => {
    console.log("╔══════════════════════════════════════╗")
    console.log(`║  NEXA SERVER HOP — port ${PORT}         ║`)
    console.log("╠══════════════════════════════════════╣")
    console.log(`║  GET  /get-server?exclude=&botName= ║`)
    console.log(`║  POST /claim    { jobId, botName }  ║`)
    console.log(`║  POST /unclaim  { jobId }           ║`)
    console.log(`║  GET  /status                       ║`)
    console.log("╚══════════════════════════════════════╝")
    console.log(`Game ID: ${GAME_ID}`)
})
