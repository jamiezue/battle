export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/ws") {
      const code = url.searchParams.get("code") || "";
      if (!env.FRIENDS_CODE || code !== env.FRIENDS_CODE) {
        return new Response("Unauthorized: invalid friend code", { status: 401 });
      }

      const roomName = url.searchParams.get("room") || "friends-main";
      const id = env.ARENA_ROOM.idFromName(roomName);
      const stub = env.ARENA_ROOM.get(id);
      return stub.fetch(request);
    }

    return env.ASSETS.fetch(request);
  }
};

const RAID_POOL = ["footman", "archer", "ram", "cavalry"];

export class ArenaRoomObject {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Set();
    this.players = {}; // playerId -> { alias, points, barracksCount, basePieces }
    this.raidTimer = null;
  }

  async ensureLoaded() {
    if (Object.keys(this.players).length === 0) {
      const saved = await this.state.storage.get("players");
      if (saved) this.players = saved;
    }
    if (!this.raidTimer) {
      this.scheduleNextRaid();
    }
  }

  scheduleNextRaid() {
    if (this.raidTimer) clearTimeout(this.raidTimer);
    const delayMs = (35 + Math.random() * 55) * 1000; // 35–90s random AI raid
    this.raidTimer = setTimeout(async () => {
      await this.triggerAiRaid();
      this.scheduleNextRaid();
    }, delayMs);
  }

  async triggerAiRaid() {
    const playerIds = Object.keys(this.players);
    if (playerIds.length === 0) return;

    const targetPlayerId = playerIds[Math.floor(Math.random() * playerIds.length)];
    const waveSize = 1 + Math.floor(Math.random() * 3);
    const wave = Array.from({ length: waveSize }, () =>
      RAID_POOL[Math.floor(Math.random() * RAID_POOL.length)]
    );

    this.broadcast({
      type: "ai_raid",
      targetPlayerId,
      wave,
      ts: Date.now()
    });
  }

  broadcast(payload, excludeWs = null) {
    const msg = JSON.stringify(payload);
    for (const ws of this.sessions) {
      if (ws !== excludeWs && ws.readyState === 1) {
        try {
          ws.send(msg);
        } catch (_) {}
      }
    }
  }

  async fetch(request) {
    await this.ensureLoaded();

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    this.sessions.add(server);

    // Send current player bases & points (only game state—no IPs or personal info)
    server.send(JSON.stringify({
      type: "init_state",
      players: this.players
    }));

    server.addEventListener("message", async (event) => {
      let data;
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }

      // Sanitize player ID & nickname (no email/IP/real name stored)
      const safeId = String(data.playerId || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 24);
      if (!safeId) return;

      const safeAlias = String(data.alias || "Commander").replace(/[<>]/g, "").slice(0, 20);

      if (!this.players[safeId]) {
        this.players[safeId] = {
          id: safeId,
          alias: safeAlias,
          points: 0,
          barracksCount: 0,
          pieces: []
        };
      } else {
        this.players[safeId].alias = safeAlias;
      }

      if (data.type === "sync_base" && Array.isArray(data.pieces)) {
        // Cap piece count to prevent payload abuse
        const trimmed = data.pieces.slice(0, 120).map(p => ({
          x: Number(p.x) || 0,
          y: Number(p.y) || 0,
          z: Number(p.z) || 0,
          w: Number(p.w) || 1,
          h: Number(p.h) || 1,
          d: Number(p.d) || 1,
          shape: String(p.shape || "box").slice(0, 16),
          material: String(p.material || "wood").slice(0, 16)
        }));
        this.players[safeId].pieces = trimmed;
        this.players[safeId].barracksCount = trimmed.filter(p => p.material === "barracks").length;
        await this.state.storage.put("players", this.players);
        this.broadcast({ type: "base_updated", player: this.players[safeId] }, server);
      }

      if (data.type === "barracks_attack") {
        // Award bounded points when a player hits or destroys an enemy Barracks
        const ptsDelta = data.destroyed ? 120 : 10;
        this.players[safeId].points = Math.max(0, (this.players[safeId].points || 0) + ptsDelta);
        await this.state.storage.put("players", this.players);
        this.broadcast({
          type: "points_updated",
          playerId: safeId,
          alias: safeAlias,
          points: this.players[safeId].points,
          awarded: ptsDelta,
          destroyed: Boolean(data.destroyed)
        });
      }
    });

    server.addEventListener("close", () => {
      this.sessions.delete(server);
    });

    return new Response(null, { status: 101, webSocket: client });
  }
}