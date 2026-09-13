const fetch = require("node-fetch");
const { EmbedBuilder } = require("discord.js");
const fs = require("fs");
const path = require("path");

// ======================================================
// CONFIGURATION
// ======================================================

const CONFIG = {
  username: "aetherofficiel",
  channelId: "1548231185015120054",
  webhookUrl:
    "https://discord.com/api/webhooks/1548544268371623996/syygwOcpQdd2GLszvp4JHEjB3_lRS60lMEMbRnMvhWdXBYHZ2hl9As0A4tAm0JuPg5XB",
  checkIntervalMs: 3 * 60 * 1000,
  maxFailures: 10,
  knownIdsFile: path.join(__dirname, "tiktok-known-ids.json"),
};

// ======================================================
// ÉTAT
// ======================================================

let consecutiveFailures = 0;
let intervalId = null;
let client = null;

let knownVideoIds = new Set();
let cachedFollowers = null;
let followersTimestamp = 0;
const FOLLOWERS_TTL = 5 * 60 * 1000;

let fetchInProgress = false;
let fetchPromise = null;

// ======================================================
// CHARGEMENT / SAUVEGARDE DES IDs
// ======================================================

function loadKnownIds() {
  try {
    if (fs.existsSync(CONFIG.knownIdsFile)) {
      const data = JSON.parse(fs.readFileSync(CONFIG.knownIdsFile, "utf8"));
      knownVideoIds = new Set(data);
      console.log(
        `[TikTok Monitor] ${knownVideoIds.size} IDs deja connus charges`
      );
    }
  } catch (e) {
    console.error(`[TikTok Monitor] Erreur chargement IDs: ${e.message}`);
  }
}

function saveKnownIds() {
  try {
    fs.writeFileSync(
      CONFIG.knownIdsFile,
      JSON.stringify([...knownVideoIds]),
      "utf8"
    );
  } catch (e) {
    console.error(`[TikTok Monitor] Erreur sauvegarde IDs: ${e.message}`);
  }
}

// ======================================================
// STRATÉGIE V5 — Vidéos + Followers séparés
//
// V4 avait un bug : quand RSSHub trouvait des vidéos,
// il ne cherchait les followers QUE sur Urlebird
// (qui est bloqué par Render). Il n'essayait jamais
// le endpoint /embed/ de TikTok pour les followers.
//
// V5 sépare la logique :
// - VIDÉOS : RSSHub RSS (hub.slarker.me fonctionne)
// - FOLLOWERS : TikTok /embed/@user (contient
//   followerCount, heartCount, etc. dans le HTML)
//   Si bloqué → CORS proxy → Urlebird → "N/A"
//
// Le endpoint /embed/ est le moins protégé par
// Cloudflare car il est conçu pour les iframes externes.
// ======================================================

// ======================================================
// VIDÉOS — RSSHub instances publiques (RSS XML)
// ======================================================

const RSSHUB_INSTANCES = [
  "https://hub.slarker.me",
  "https://rsshub.app",
  "https://rsshub.rssforever.com",
];

async function fetchVideoIds() {
  for (const instance of RSSHUB_INSTANCES) {
    // Essayer le RSS (XML) — c'est ce qui a marché en V4
    try {
      console.log(`[TikTok Monitor] Essai RSSHub RSS: ${instance}`);
      const rssUrl = `${instance}/tiktok/user/@${CONFIG.username}`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      const res = await fetch(rssUrl, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (compatible; TikTokMonitor/5.0)",
          Accept: "application/rss+xml, application/xml, text/xml",
        },
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (res.ok) {
        const xml = await res.text();
        const ids = parseRssXml(xml);
        if (ids.size > 0) {
          console.log(
            `[TikTok Monitor] RSSHub RSS (${instance}) OK — ${ids.size} video(s)`
          );
          return { videoIds: ids, source: `rsshub-rss-${instance}` };
        }
      } else {
        console.log(
          `[TikTok Monitor] RSSHub RSS (${instance}) — HTTP ${res.status}`
        );
      }
    } catch (e) {
      console.log(
        `[TikTok Monitor] RSSHub RSS (${instance}) — erreur: ${e.message}`
      );
    }

    // Essayer aussi le JSON (API RSSHub)
    try {
      console.log(`[TikTok Monitor] Essai RSSHub JSON: ${instance}`);
      const jsonUrl = `${instance}/api/tiktok/user/@${CONFIG.username}`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      const res = await fetch(jsonUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0",
          Accept: "application/json",
        },
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (res.ok) {
        const data = await res.json();
        if (data && data.items && data.items.length > 0) {
          const ids = new Set();
          for (const item of data.items) {
            const urlMatch = (item.url || item.link || "").match(
              /video\/(\d{15,20})/
            );
            if (urlMatch) ids.add(urlMatch[1]);
            if (item.id) {
              const idMatch = String(item.id).match(/video\/(\d{15,20})/);
              if (idMatch) ids.add(idMatch[1]);
            }
          }
          if (ids.size > 0) {
            console.log(
              `[TikTok Monitor] RSSHub JSON (${instance}) OK — ${ids.size} video(s)`
            );
            return { videoIds: ids, source: `rsshub-json-${instance}` };
          }
        }
      } else {
        console.log(
          `[TikTok Monitor] RSSHub JSON (${instance}) — HTTP ${res.status}`
        );
      }
    } catch (e) {
      console.log(
        `[TikTok Monitor] RSSHub JSON (${instance}) — erreur: ${e.message}`
      );
    }
  }

  return null;
}

function parseRssXml(xml) {
  const ids = new Set();

  // Parser les IDs depuis les balises <link> et <guid>
  const linkMatches = xml.match(/<link>[^<]*video\/(\d{15,20})[^<]*<\/link>/g);
  if (linkMatches) {
    for (const m of linkMatches) {
      const id = m.match(/video\/(\d{15,20})/);
      if (id) ids.add(id[1]);
    }
  }

  const guidMatches = xml.match(
    /<guid[^>]*>[^<]*video\/(\d{15,20})[^<]*<\/guid>/g
  );
  if (guidMatches) {
    for (const m of guidMatches) {
      const id = m.match(/video\/(\d{15,20})/);
      if (id) ids.add(id[1]);
    }
  }

  // Regex generique fallback
  const allVideoUrls = xml.match(/video\/(\d{15,20})/g);
  if (allVideoUrls) {
    for (const m of allVideoUrls) {
      const id = m.match(/video\/(\d{15,20})/);
      if (id) ids.add(id[1]);
    }
  }

  return ids;
}

// ======================================================
// FOLLOWERS — TikTok Embed + alternatives
//
// Le endpoint /embed/@user de TikTok contient
// un bloc JSON avec : followerCount, heartCount,
// followingCount, uniqueId, nickname, etc.
// C'est la source la plus fiable car elle est
// conçue pour être chargée depuis l'extérieur.
//
// Si Cloudflare bloque depuis Render, on essaye
// via des proxies CORS gratuits.
// ======================================================

async function fetchFollowers() {
  // Cache : ne pas re-demander si récent
  if (
    cachedFollowers !== null &&
    Date.now() - followersTimestamp < FOLLOWERS_TTL
  ) {
    console.log(`[TikTok Monitor] Followers en cache: ${cachedFollowers}`);
    return cachedFollowers;
  }

  // SOURCE 1 : TikTok Embed (direct)
  const embedResult = await fetchFollowersFromEmbed();
  if (embedResult !== null) {
    cachedFollowers = embedResult;
    followersTimestamp = Date.now();
    console.log(
      `[TikTok Monitor] Followers: ${embedResult} (via embed)`
    );
    return embedResult;
  }

  // SOURCE 2 : TikTok Embed via proxy CORS
  const proxyResult = await fetchFollowersFromEmbedProxy();
  if (proxyResult !== null) {
    cachedFollowers = proxyResult;
    followersTimestamp = Date.now();
    console.log(
      `[TikTok Monitor] Followers: ${proxyResult} (via proxy)`
    );
    return proxyResult;
  }

  // SOURCE 3 : Urlebird (probablement bloqué sur Render)
  const urlebirdResult = await fetchFollowersFromUrlebird();
  if (urlebirdResult !== null) {
    cachedFollowers = urlebirdResult;
    followersTimestamp = Date.now();
    console.log(
      `[TikTok Monitor] Followers: ${urlebirdResult} (via urlebird)`
    );
    return urlebirdResult;
  }

  // SOURCE 4 : Extraire depuis le RSS si disponible
  // (RSSHub RSS ne contient généralement pas de followers, mais au cas où)
  console.log(
    `[TikTok Monitor] Followers: aucune source n'a fonctionné — N/A`
  );
  return null;
}

async function fetchFollowersFromEmbed() {
  const embedUrl = `https://www.tiktok.com/embed/@${CONFIG.username}`;

  try {
    console.log(`[TikTok Monitor] Essai followers via Embed (direct)`);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(embedUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
        Accept: "text/html",
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (res.ok) {
      const html = await res.text();
      const followers = extractFollowerCountFromHtml(html);
      if (followers !== null) {
        console.log(
          `[TikTok Monitor] Embed direct OK — followers: ${followers}`
        );
        return followers;
      } else {
        console.log(
          `[TikTok Monitor] Embed direct — page chargée mais followerCount non trouvé (possible page Cloudflare)`
        );
      }
    } else {
      console.log(
        `[TikTok Monitor] Embed direct — HTTP ${res.status}`
      );
    }
  } catch (e) {
    console.log(`[TikTok Monitor] Embed direct — erreur: ${e.message}`);
  }

  return null;
}

async function fetchFollowersFromEmbedProxy() {
  const embedUrl = `https://www.tiktok.com/embed/@${CONFIG.username}`;

  const proxies = [
    {
      name: "allorigins",
      url: (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
    },
    {
      name: "corsproxy",
      url: (u) => `https://corsproxy.io/?${encodeURIComponent(u)}`,
    },
    {
      name: "codetabs",
      url: (u) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}`,
    },
  ];

  for (const proxy of proxies) {
    try {
      console.log(
        `[TikTok Monitor] Essai followers via Embed proxy: ${proxy.name}`
      );
      const proxyUrl = proxy.url(embedUrl);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20000);
      const res = await fetch(proxyUrl, {
        headers: { "User-Agent": "Mozilla/5.0" },
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (res.ok) {
        const html = await res.text();
        const followers = extractFollowerCountFromHtml(html);
        if (followers !== null) {
          console.log(
            `[TikTok Monitor] Embed proxy ${proxy.name} OK — followers: ${followers}`
          );
          return followers;
        }
      } else {
        console.log(
          `[TikTok Monitor] Embed proxy ${proxy.name} — HTTP ${res.status}`
        );
      }
    } catch (e) {
      console.log(
        `[TikTok Monitor] Embed proxy ${proxy.name} — erreur: ${e.message}`
      );
    }
  }

  return null;
}

async function fetchFollowersFromUrlebird() {
  const profileUrl = `https://urlebird.com/user/${CONFIG.username}/`;

  try {
    console.log(`[TikTok Monitor] Essai followers via Urlebird`);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(profileUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
        Accept: "text/html",
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (res.ok) {
      const html = await res.text();
      if (html.length < 500) return null;

      // Chercher les followers dans le HTML
      const followerMatch = html.match(
        /(\d[\d,.]*\d*)\s*(?:followers|abonnes|subscribers)/i
      );
      if (followerMatch) {
        return parseInt(followerMatch[1].replace(/[,.]/g, ""), 10);
      }
    } else {
      console.log(`[TikTok Monitor] Urlebird — HTTP ${res.status}`);
    }
  } catch (e) {
    console.log(`[TikTok Monitor] Urlebird — erreur: ${e.message}`);
  }

  return null;
}

function extractFollowerCountFromHtml(html) {
  if (!html || html.length < 500) return null;

  // Vérifier que c'est pas une page Cloudflare
  const challengeSigns = [
    "Just a moment",
    "cf-challenge",
    "Checking your browser",
    "Attention Required",
    "challenge-platform",
  ];
  if (challengeSigns.some((s) => html.includes(s)) && html.length < 80000) {
    return null;
  }

  // Regex : chercher "followerCount":28 dans le HTML
  const followerMatch = html.match(/"followerCount"\s*:\s*(\d+)/);
  if (followerMatch) {
    return parseInt(followerMatch[1], 10);
  }

  // Fallback : chercher dans le JSON embarqué
  // __UNIVERSAL_DATA_FOR_REHYDRATION__
  try {
    const universalMatch = html.match(
      /<script\s+id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>\s*([\s\S]*?)\s*<\/script>/
    );
    if (universalMatch) {
      const data = JSON.parse(universalMatch[1]);
      const fc = deepFindFollowerCount(data, 0);
      if (fc !== null) return fc;
    }
  } catch (e) {}

  // Fallback : __FRONTITY_CONNECT_STATE__
  try {
    const frontityMatch = html.match(
      /<script\s+id="__FRONTITY_CONNECT_STATE__"[^>]*>([\s\S]*?)<\/script>/
    );
    if (frontityMatch) {
      const data = JSON.parse(frontityMatch[1]);
      const fc = deepFindFollowerCount(data, 0);
      if (fc !== null) return fc;
    }
  } catch (e) {}

  return null;
}

function deepFindFollowerCount(obj, depth) {
  if (depth > 20 || !obj || typeof obj !== "object") return null;

  if (Array.isArray(obj)) {
    for (const item of obj) {
      const r = deepFindFollowerCount(item, depth + 1);
      if (r !== null) return r;
    }
    return null;
  }

  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (key === "followerCount" && typeof val === "number" && val >= 0) {
      return val;
    }
    if (val && typeof val === "object") {
      const r = deepFindFollowerCount(val, depth + 1);
      if (r !== null) return r;
    }
  }
  return null;
}

// ======================================================
// NOTIFICATION DISCORD
// ======================================================

async function sendVideoNotification(guild, videoId) {
  const videoUrl = `https://www.tiktok.com/@${CONFIG.username}/video/${videoId}`;

  // Récupérer les followers pour l'embed
  const followers = await fetchFollowers();
  const followerText =
    followers !== null ? `${followers} abonnés` : "";

  if (CONFIG.webhookUrl) {
    try {
      const embed = {
        title: "Nouvelle vidéo TikTok !",
        url: videoUrl,
        color: 0x00f2ea,
        description:
          `**@${CONFIG.username}** vient de poster une nouvelle vidéo !\n` +
          `Va la regarder 🔥` +
          (followerText ? `\n\n📊 **${followerText}**` : ""),
        timestamp: new Date().toISOString(),
        footer: {
          text: "TikTok Monitor v5",
        },
      };

      await fetch(CONFIG.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: "TikTok Monitor",
          content: `@everyone **Nouvelle vidéo TikTok !** @${CONFIG.username} vient de poster !\n${videoUrl}`,
          embeds: [embed],
        }),
      });
      console.log(
        `[TikTok Monitor] Notification webhook envoyee ! Video: ${videoId}`
      );
      return;
    } catch (err) {
      console.error(
        `[TikTok Monitor] Erreur webhook: ${err.message} — fallback via bot`
      );
    }
  }

  const channel = guild.channels.cache.get(CONFIG.channelId);
  if (!channel) {
    console.error(
      `[TikTok Monitor] Salon introuvable — ID: ${CONFIG.channelId}`
    );
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle("Nouvelle vidéo TikTok !")
    .setURL(videoUrl)
    .setColor(0x00f2ea)
    .setDescription(
      `**@${CONFIG.username}** vient de poster une nouvelle vidéo !\n` +
        `Va la regarder 🔥` +
        (followerText ? `\n\n📊 **${followerText}**` : "")
    )
    .setTimestamp()
    .setFooter({ text: "TikTok Monitor v5" });

  try {
    await channel.send({
      content: `@everyone **Nouvelle vidéo TikTok !** @${CONFIG.username} vient de poster !\n${videoUrl}`,
      embeds: [embed],
    });
    console.log(
      `[TikTok Monitor] Notification bot envoyee ! Video: ${videoId}`
    );
  } catch (err) {
    console.error(`[TikTok Monitor] Erreur envoi: ${err.message}`);
  }
}

// ======================================================
// BOUCLE PRINCIPALE
// ======================================================

async function monitorLoop() {
  if (!client) return;

  try {
    // 1) Chercher les vidéos via RSSHub
    const videoResult = await fetchVideoIds();

    if (videoResult && videoResult.videoIds.size > 0) {
      consecutiveFailures = 0;

      const newIds = [];
      for (const id of videoResult.videoIds) {
        if (!knownVideoIds.has(id)) {
          newIds.push(id);
        }
      }

      if (newIds.length === 0) {
        console.log("[TikTok Monitor] Pas de nouvelle vidéo");
      } else if (knownVideoIds.size === 0) {
        // Premier lancement : on enregistre tout sans notifier
        for (const id of newIds) {
          knownVideoIds.add(id);
        }
        saveKnownIds();
        console.log(
          `[TikTok Monitor] Premier lancement — ${newIds.length} IDs initiaux enregistrés (pas de notification)`
        );
      } else {
        // Vraies nouvelles vidéos !
        for (const id of newIds) {
          console.log(
            `[TikTok Monitor] Nouvelle vidéo détectée ! ID: ${id}`
          );
          knownVideoIds.add(id);
          const guild = client.guilds.cache.values().next().value;
          if (guild) await sendVideoNotification(guild, id);
        }
        saveKnownIds();
      }
    } else {
      consecutiveFailures++;
      console.error(
        `[TikTok Monitor] Échec vidéo (${consecutiveFailures}/${CONFIG.maxFailures})`
      );

      if (consecutiveFailures >= CONFIG.maxFailures) {
        const guild = client.guilds.cache.values().next().value;
        if (guild) {
          const channel = guild.channels.cache.get(CONFIG.channelId);
          if (channel) {
            await channel
              .send(
                "⚠️ Le moniteur TikTok n'arrive pas à récupérer les données depuis un moment. Toutes les sources ont échoué."
              )
              .catch(() => {});
          }
        }
        consecutiveFailures = 0;
      }
    }

    // 2) Mettre à jour les followers en arrière-plan
    // (même si pas de nouvelle vidéo, on garde le compteur à jour)
    try {
      const followers = await fetchFollowers();
      if (followers !== null) {
        console.log(
          `[TikTok Monitor] Compteur followers: ${followers}`
        );
      }
    } catch (e) {
      console.log(`[TikTok Monitor] Mise à jour followers échouée: ${e.message}`);
    }
  } catch (e) {
    console.error(`[TikTok Monitor] Erreur boucle: ${e.message}`);
  }
}

// ======================================================
// COMMANDE DISCORD !followers
// ======================================================

async function handleFollowersCommand(interaction) {
  const followers = await fetchFollowers();
  const text =
    followers !== null
      ? `📊 **@${CONFIG.username}** a actuellement **${followers}** abonnés sur TikTok !`
      : `❌ Impossible de récupérer le nombre d'abonnés pour le moment. Toutes les sources ont échoué.`;

  if (interaction) {
    await interaction.reply(text).catch(() => {});
  }
  return text;
}

// ======================================================
// DÉMARRAGE
// ======================================================

function startTikTokMonitor(discordClient) {
  client = discordClient;
  loadKnownIds();
  monitorLoop();
  intervalId = setInterval(monitorLoop, CONFIG.checkIntervalMs);
  console.log(
    `[TikTok Monitor v5] Démarré — vérification toutes les ${
      CONFIG.checkIntervalMs / 1000
    }s`
  );
}

module.exports = {
  startTikTokMonitor,
  checkFollowers: fetchFollowers,
  handleFollowersCommand,
};
