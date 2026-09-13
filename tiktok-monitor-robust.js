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
  // Microlink free tier: 25 req/jour
  // On cache les followers 3h → ~8 requêtes/jour
  followersCacheMs: 3 * 60 * 60 * 1000,
};

// ======================================================
// ÉTAT GLOBAL
// ======================================================

let consecutiveFailures = 0;
let intervalId = null;
let client = null;

let knownVideoIds = new Set();
let cachedFollowers = null;
let cachedLikes = null;
let followersTimestamp = 0;
let fetchInProgress = false;

// ======================================================
// CHARGEMENT / SAUVEGARDE DES IDs
// ======================================================

function loadKnownIds() {
  try {
    if (fs.existsSync(CONFIG.knownIdsFile)) {
      const data = JSON.parse(fs.readFileSync(CONFIG.knownIdsFile, "utf8"));
      knownVideoIds = new Set(data);
      console.log(
        `[TikTok Monitor] ${knownVideoIds.size} IDs déjà connus chargés`
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
// UTILITAIRE — Requête avec retry et timeout
// ======================================================

async function fetchWithRetry(url, options = {}, maxRetries = 2, baseDelay = 2000) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        options.timeout || 30000
      );
      const res = await fetch(url, {
        ...options,
        signal: controller.signal,
      });
      clearTimeout(timeout);
      return res;
    } catch (e) {
      if (attempt < maxRetries) {
        const delay = baseDelay * Math.pow(2, attempt);
        console.log(
          `[TikTok Monitor] Tentative ${attempt + 1}/${maxRetries + 1} échouée pour ${url.substring(0, 80)} — retry dans ${delay}ms: ${e.message}`
        );
        await new Promise((r) => setTimeout(r, delay));
      } else {
        throw e;
      }
    }
  }
}

// ======================================================
// V6 — STRATÉGIE
//
// VIDÉOS :
//  1) hub.slarker.me JSON Feed (?format=json)
//     → plus facile à parser que le RSS XML
//     → 30s timeout + 2 retries
//  2) hub.slarker.me RSS XML (backup)
//  3) Autres instances RSSHub (dernier recours)
//
// FOLLOWERS :
//  1) Microlink API (api.microlink.io)
//     → Service gratuit qui charge TikTok
//       depuis ses propres serveurs (pas bloqué
//       par Cloudflare depuis Render)
//     → Retourne "N Followers" dans le
//       champ description
//     → 25 requêtes/jour (gratuit) → cache 3h
//  2) Microlink sur /embed/ (backup format)
//  3) Embed direct TikTok (backup, souvent bloqué)
//
// ======================================================

// ======================================================
// VIDÉOS — JSON Feed (hub.slarker.me)
// ======================================================

async function fetchVideoIdsFromJsonFeed(instance) {
  const jsonUrl = `${instance}/tiktok/user/@${CONFIG.username}?format=json`;
  console.log(`[TikTok Monitor] Essai JSON Feed: ${jsonUrl.substring(0, 70)}...`);

  try {
    const res = await fetchWithRetry(
      jsonUrl,
      {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; TikTokMonitor/6.0)",
          Accept: "application/json",
        },
        timeout: 30000,
      },
      2
    );

    if (res.ok) {
      const data = await res.json();
      if (data && data.items && data.items.length > 0) {
        const ids = new Set();
        for (const item of data.items) {
          const urlMatch = (item.url || "").match(/video\/(\d{15,20})/);
          if (urlMatch) ids.add(urlMatch[1]);
          if (item.id) {
            const idMatch = String(item.id).match(/video\/(\d{15,20})/);
            if (idMatch) ids.add(idMatch[1]);
          }
        }
        if (ids.size > 0) {
          console.log(
            `[TikTok Monitor] JSON Feed OK — ${ids.size} vidéo(s)`
          );
          return { videoIds: ids, source: `jsonfeed-${instance}` };
        }
      }
    } else {
      console.log(
        `[TikTok Monitor] JSON Feed — HTTP ${res.status}`
      );
    }
  } catch (e) {
    console.log(`[TikTok Monitor] JSON Feed — erreur: ${e.message}`);
  }

  return null;
}

// ======================================================
// VIDÉOS — RSS XML (hub.slarker.me + backup)
// ======================================================

const RSSHUB_INSTANCES = [
  "https://hub.slarker.me",
  "https://rsshub.app",
  "https://rsshub.rssforever.com",
];

async function fetchVideoIdsFromRss(instance) {
  const rssUrl = `${instance}/tiktok/user/@${CONFIG.username}`;
  console.log(`[TikTok Monitor] Essai RSS XML: ${rssUrl.substring(0, 70)}...`);

  try {
    const res = await fetchWithRetry(
      rssUrl,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (compatible; TikTokMonitor/6.0)",
          Accept: "application/rss+xml, application/xml, text/xml",
        },
        timeout: 30000,
      },
      1
    );

    if (res.ok) {
      const xml = await res.text();
      const ids = parseRssXml(xml);
      if (ids.size > 0) {
        console.log(
          `[TikTok Monitor] RSS XML OK — ${ids.size} vidéo(s)`
        );
        return { videoIds: ids, source: `rss-${instance}` };
      }
    } else {
      console.log(`[TikTok Monitor] RSS XML — HTTP ${res.status}`);
    }
  } catch (e) {
    console.log(`[TikTok Monitor] RSS XML — erreur: ${e.message}`);
  }

  return null;
}

function parseRssXml(xml) {
  const ids = new Set();

  // <link> contenant video/ID
  const linkMatches = xml.match(
    /<link>[^<]*video\/(\d{15,20})[^<]*<\/link>/g
  );
  if (linkMatches) {
    for (const m of linkMatches) {
      const id = m.match(/video\/(\d{15,20})/);
      if (id) ids.add(id[1]);
    }
  }

  // <guid> contenant video/ID
  const guidMatches = xml.match(
    /<guid[^>]*>[^<]*video\/(\d{15,20})[^<]*<\/guid>/g
  );
  if (guidMatches) {
    for (const m of guidMatches) {
      const id = m.match(/video\/(\d{15,20})/);
      if (id) ids.add(id[1]);
    }
  }

  // Regex générique fallback
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
// VIDÉOS — Fonction principale
// ======================================================

async function fetchVideoIds() {
  // SOURCE 1 : hub.slarker.me JSON Feed (plus facile à parser)
  const jsonResult = await fetchVideoIdsFromJsonFeed(
    "https://hub.slarker.me"
  );
  if (jsonResult && jsonResult.videoIds.size > 0) {
    return jsonResult;
  }

  // SOURCE 2 : hub.slarker.me RSS XML
  const rssResult = await fetchVideoIdsFromRss("https://hub.slarker.me");
  if (rssResult && rssResult.videoIds.size > 0) {
    return rssResult;
  }

  // SOURCE 3 : Autres instances RSSHub (dernier recours)
  for (const instance of RSSHUB_INSTANCES.slice(1)) {
    const result = await fetchVideoIdsFromRss(instance);
    if (result && result.videoIds.size > 0) {
      return result;
    }
  }

  return null;
}

// ======================================================
// FOLLOWERS — Microlink API
//
// Microlink charge TikTok depuis ses propres
// serveurs (headless browser). TikTok ne bloque
// pas Microlink car c'est un service légitime.
// 
// Format de retour :
//   description: "... | 177 Likes. 28 Followers. ..."
//   ou (embed): "Following28Followers177Likes"
//
// Limite gratuite : 25 requêtes/jour
// → Cache de 3h → ~8 requêtes/jour
// ======================================================

async function fetchFollowersFromMicrolink() {
  // SOURCE 1a : Page profil TikTok (format propre)
  try {
    const url = `https://api.microlink.io/?url=https://www.tiktok.com/@${CONFIG.username}`;
    console.log(`[TikTok Monitor] Essai followers via Microlink (profil)`);
    const res = await fetchWithRetry(
      url,
      { headers: { "User-Agent": "Mozilla/5.0" }, timeout: 20000 },
      1
    );

    if (res.ok) {
      const data = await res.json();
      if (data.status === "success" && data.data) {
        const desc = data.data.description || "";
        // Format : "... | 177 Likes. 28 Followers. ..."
        const followerMatch = desc.match(
          /(\d[\d,]*)\s+Followers/i
        );
        const likesMatch = desc.match(
          /(\d[\d,]*)\s+Likes/i
        );
        if (followerMatch) {
          const followers = parseInt(
            followerMatch[1].replace(/,/g, ""),
            10
          );
          const likes = likesMatch
            ? parseInt(likesMatch[1].replace(/,/g, ""), 10)
            : null;
          console.log(
            `[TikTok Monitor] Microlink profil OK — ${followers} followers, ${likes} likes`
          );
          return { followers, likes };
        }
      }
    } else {
      console.log(`[TikTok Monitor] Microlink profil — HTTP ${res.status}`);
    }
  } catch (e) {
    console.log(`[TikTok Monitor] Microlink profil — erreur: ${e.message}`);
  }

  // SOURCE 1b : Page embed TikTok (format compact)
  try {
    const url = `https://api.microlink.io/?url=https://www.tiktok.com/embed/@${CONFIG.username}`;
    console.log(`[TikTok Monitor] Essai followers via Microlink (embed)`);
    const res = await fetchWithRetry(
      url,
      { headers: { "User-Agent": "Mozilla/5.0" }, timeout: 20000 },
      1
    );

    if (res.ok) {
      const data = await res.json();
      if (data.status === "success" && data.data) {
        const desc = data.data.description || "";
        // Format : "Following28Followers177Likes"
        const followerMatch = desc.match(/(\d+)Followers/);
        const likesMatch = desc.match(/(\d+)Likes/);
        if (followerMatch) {
          const followers = parseInt(followerMatch[1], 10);
          const likes = likesMatch
            ? parseInt(likesMatch[1], 10)
            : null;
          console.log(
            `[TikTok Monitor] Microlink embed OK — ${followers} followers, ${likes} likes`
          );
          return { followers, likes };
        }
      }
    } else {
      console.log(`[TikTok Monitor] Microlink embed — HTTP ${res.status}`);
    }
  } catch (e) {
    console.log(`[TikTok Monitor] Microlink embed — erreur: ${e.message}`);
  }

  return null;
}

// ======================================================
// FOLLOWERS — Embed direct TikTok (backup)
//
// Le endpoint /embed/ de TikTok contient le
// followerCount dans le JSON HTML embarqué.
// Depuis Render, Cloudflare bloque souvent,
// mais ça peut marcher parfois.
// ======================================================

async function fetchFollowersFromEmbed() {
  const embedUrl = `https://www.tiktok.com/embed/@${CONFIG.username}`;

  try {
    console.log(`[TikTok Monitor] Essai followers via Embed (direct)`);
    const res = await fetchWithRetry(
      embedUrl,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
          Accept: "text/html",
        },
        timeout: 15000,
      },
      0
    );

    if (res.ok) {
      const html = await res.text();
      const result = extractFollowerDataFromHtml(html);
      if (result) {
        console.log(
          `[TikTok Monitor] Embed direct OK — ${result.followers} followers`
        );
        return result;
      }
    } else {
      console.log(`[TikTok Monitor] Embed direct — HTTP ${res.status}`);
    }
  } catch (e) {
    console.log(`[TikTok Monitor] Embed direct — erreur: ${e.message}`);
  }

  return null;
}

function extractFollowerDataFromHtml(html) {
  if (!html || html.length < 500) return null;

  // Vérifier que c'est pas une page Cloudflare
  const challengeSigns = [
    "Just a moment",
    "cf-challenge",
    "Checking your browser",
    "Attention Required",
    "challenge-platform",
  ];
  if (
    challengeSigns.some((s) => html.includes(s)) &&
    html.length < 80000
  ) {
    return null;
  }

  // Regex : "followerCount":28 dans le HTML
  const followerMatch = html.match(/"followerCount"\s*:\s*(\d+)/);
  const likesMatch = html.match(/"heartCount"\s*:\s*(\d+)/);

  if (followerMatch) {
    return {
      followers: parseInt(followerMatch[1], 10),
      likes: likesMatch ? parseInt(likesMatch[1], 10) : null,
    };
  }

  // Fallback : __FRONTITY_CONNECT_STATE__
  try {
    const frontityMatch = html.match(
      /<script\s+id="__FRONTITY_CONNECT_STATE__"[^>]*>([\s\S]*?)<\/script>/
    );
    if (frontityMatch) {
      const data = JSON.parse(frontityMatch[1]);
      return deepFindFollowerData(data, 0);
    }
  } catch (e) {}

  // Fallback : __UNIVERSAL_DATA_FOR_REHYDRATION__
  try {
    const universalMatch = html.match(
      /<script\s+id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>\s*([\s\S]*?)\s*<\/script>/
    );
    if (universalMatch) {
      const data = JSON.parse(universalMatch[1]);
      return deepFindFollowerData(data, 0);
    }
  } catch (e) {}

  return null;
}

function deepFindFollowerData(obj, depth) {
  if (depth > 20 || !obj || typeof obj !== "object") return null;

  if (Array.isArray(obj)) {
    for (const item of obj) {
      const r = deepFindFollowerData(item, depth + 1);
      if (r !== null) return r;
    }
    return null;
  }

  let followers = null;
  let likes = null;
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (key === "followerCount" && typeof val === "number" && val >= 0) {
      followers = val;
    }
    if (key === "heartCount" && typeof val === "number" && val >= 0) {
      likes = val;
    }
  }
  if (followers !== null) {
    return { followers, likes };
  }

  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (val && typeof val === "object") {
      const r = deepFindFollowerData(val, depth + 1);
      if (r !== null) return r;
    }
  }
  return null;
}

// ======================================================
// FOLLOWERS — Fonction principale
// ======================================================

async function fetchFollowers() {
  // Cache : ne pas re-demander si récent
  if (
    cachedFollowers !== null &&
    Date.now() - followersTimestamp < CONFIG.followersCacheMs
  ) {
    console.log(
      `[TikTok Monitor] Followers en cache: ${cachedFollowers} abonnés, ${cachedLikes} likes`
    );
    return { followers: cachedFollowers, likes: cachedLikes };
  }

  // SOURCE 1 : Microlink API (fiable, fonctionne depuis Render)
  const microlinkResult = await fetchFollowersFromMicrolink();
  if (microlinkResult !== null) {
    cachedFollowers = microlinkResult.followers;
    cachedLikes = microlinkResult.likes;
    followersTimestamp = Date.now();
    return microlinkResult;
  }

  // SOURCE 2 : Embed direct TikTok (peut marcher parfois)
  const embedResult = await fetchFollowersFromEmbed();
  if (embedResult !== null) {
    cachedFollowers = embedResult.followers;
    cachedLikes = embedResult.likes;
    followersTimestamp = Date.now();
    return embedResult;
  }

  // Aucune source n'a fonctionné
  console.log(
    `[TikTok Monitor] Followers: aucune source n'a fonctionné — N/A`
  );
  return null;
}

// ======================================================
// NOTIFICATION DISCORD
// ======================================================

async function sendVideoNotification(guild, videoId) {
  const videoUrl = `https://www.tiktok.com/@${CONFIG.username}/video/${videoId}`;

  // Récupérer les followers pour l'embed
  const followerData = await fetchFollowers();
  const followerText =
    followerData && followerData.followers !== null
      ? `${followerData.followers} abonnés`
      : "";
  const likesText =
    followerData && followerData.likes !== null
      ? `${followerData.likes} likes`
      : "";

  const statsLine =
    followerText || likesText
      ? `\n\n📊 **${followerText}${followerText && likesText ? " • " : ""}${likesText}**`
      : "";

  if (CONFIG.webhookUrl) {
    try {
      const embed = {
        title: "🎬 Nouvelle vidéo TikTok !",
        url: videoUrl,
        color: 0x00f2ea,
        description:
          `**@${CONFIG.username}** vient de poster une nouvelle vidéo !\n` +
          `Va la regarder 🔥` +
          statsLine,
        timestamp: new Date().toISOString(),
        footer: {
          text: "TikTok Monitor v6",
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
        `[TikTok Monitor] Notification webhook envoyée ! Vidéo: ${videoId}`
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
    .setTitle("🎬 Nouvelle vidéo TikTok !")
    .setURL(videoUrl)
    .setColor(0x00f2ea)
    .setDescription(
      `**@${CONFIG.username}** vient de poster une nouvelle vidéo !\n` +
        `Va la regarder 🔥` +
        statsLine
    )
    .setTimestamp()
    .setFooter({ text: "TikTok Monitor v6" });

  try {
    await channel.send({
      content: `@everyone **Nouvelle vidéo TikTok !** @${CONFIG.username} vient de poster !\n${videoUrl}`,
      embeds: [embed],
    });
    console.log(
      `[TikTok Monitor] Notification bot envoyée ! Vidéo: ${videoId}`
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
    // 1) Chercher les vidéos
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
        // Premier lancement : enregistrer tout sans notifier
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
            `[TikTok Monitor] 🎬 Nouvelle vidéo détectée ! ID: ${id}`
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
    // (seulement si le cache est expiré)
    try {
      const followerData = await fetchFollowers();
      if (followerData) {
        console.log(
          `[TikTok Monitor] Compteur: ${followerData.followers} abonnés, ${followerData.likes || "?"} likes`
        );
      }
    } catch (e) {
      console.log(
        `[TikTok Monitor] Mise à jour followers échouée: ${e.message}`
      );
    }
  } catch (e) {
    console.error(`[TikTok Monitor] Erreur boucle: ${e.message}`);
  }
}

// ======================================================
// COMMANDE DISCORD !followers
// ======================================================

async function handleFollowersCommand(interaction) {
  // Pour la commande, on force un refresh (pas de cache)
  // mais on utilise Microlink directement pour ne pas
  // gaspiller les requêtes gratuites
  try {
    const url = `https://api.microlink.io/?url=https://www.tiktok.com/@${CONFIG.username}`;
    const res = await fetchWithRetry(
      url,
      { headers: { "User-Agent": "Mozilla/5.0" }, timeout: 15000 },
      1
    );
    if (res.ok) {
      const data = await res.json();
      if (data.status === "success" && data.data) {
        const desc = data.data.description || "";
        const followerMatch = desc.match(
          /(\d[\d,]*)\s+Followers/i
        );
        const likesMatch = desc.match(
          /(\d[\d,]*)\s+Likes/i
        );
        if (followerMatch) {
          const followers = parseInt(
            followerMatch[1].replace(/,/g, ""),
            10
          );
          const likes = likesMatch
            ? parseInt(likesMatch[1].replace(/,/g, ""), 10)
            : null;
          // Mettre à jour le cache aussi
          cachedFollowers = followers;
          cachedLikes = likes;
          followersTimestamp = Date.now();

          const text =
            `📊 **@${CONFIG.username}** a actuellement **${followers}** abonnés sur TikTok !` +
            (likes !== null ? ` (${likes} likes au total)` : "");
          if (interaction) {
            await interaction.reply(text).catch(() => {});
          }
          return text;
        }
      }
    }
  } catch (e) {
    console.log(`[TikTok Monitor] !followers erreur Microlink: ${e.message}`);
  }

  // Fallback : utiliser le cache si disponible
  if (cachedFollowers !== null) {
    const text =
      `📊 **@${CONFIG.username}** a actuellement **${cachedFollowers}** abonnés sur TikTok !` +
      (cachedLikes !== null ? ` (${cachedLikes} likes au total)` : "") +
      ` _(données en cache)_`;
    if (interaction) {
      await interaction.reply(text).catch(() => {});
    }
    return text;
  }

  const text =
    "❌ Impossible de récupérer le nombre d'abonnés pour le moment. Toutes les sources ont échoué.";
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
    `[TikTok Monitor v6] Démarré — vérification toutes les ${
      CONFIG.checkIntervalMs / 1000
    }s`
  );
}

module.exports = {
  startTikTokMonitor,
  checkFollowers: fetchFollowers,
  handleFollowersCommand,
};
