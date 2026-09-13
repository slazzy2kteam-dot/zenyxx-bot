const fetch = require("node-fetch");
const { EmbedBuilder } = require("discord.js");
const fs = require("fs");
const path = require("path");

// ======================================================
// CONFIGURATION
// ======================================================

const CONFIG = {
  username: "aetherofficiel",
  channelId: "1548231185015120054", // 📺・tiktok
  webhookUrl:
    "https://discord.com/api/webhooks/1548544268371623996/syygwOcpQdd2GLszvp4JHEjB3_lRS60lMEMbRnMvhWdXBYHZ2hl9As0A4tAm0JuPg5XB",
  checkIntervalMs: 2 * 60 * 1000, // 2 minutes
  maxFailures: 10,
  knownIdsFile: path.join(__dirname, "tiktok-known-ids.json"),
};

// ======================================================
// ÉTAT
// ======================================================

let consecutiveFailures = 0;
let intervalId = null;
let client = null;

// Set des IDs de vidéos déjà notifiées
let knownVideoIds = new Set();

// Cache HTML partagé — vidéo + followers utilisent le même HTML
let cachedHtml = null;
let cachedHtmlTime = 0;
const HTML_CACHE_TTL = 100 * 1000; // 100 secondes

// Derniers followers connus (pour le compteur)
let cachedFollowers = null;

// Verrou anti-concurrence : une seule requête TikTok à la fois
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
        `[TikTok Monitor] 📂 ${knownVideoIds.size} IDs déjà connus chargés`
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
// HEADERS — plusieurs User-Agent réalistes, tirés au sort
// à chaque requête pour ressembler à un vrai navigateur.
// ======================================================

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0",
];

function buildHeaders() {
  return {
    "User-Agent":
      USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9,fr;q=0.8",
    Referer: "https://www.tiktok.com/",
  };
}

// ======================================================
// EXTRACTION — TikTok HTML (tous les IDs + followers)
// ======================================================

function extractAllVideosFromTikTokHtml(html) {
  const ids = new Set();

  const urlMatches = html.match(/video\/(\d{10,})/g);
  if (urlMatches) {
    for (const m of urlMatches) {
      const id = m.match(/video\/(\d{10,})/);
      if (id) ids.add(id[1]);
    }
  }

  const idMatches = html.match(/"id":"(\d{15,})"/g);
  if (idMatches) {
    for (const m of idMatches) {
      const id = m.match(/"id":"(\d{15,})"/);
      if (id) ids.add(id[1]);
    }
  }

  return ids.size > 0 ? ids : null;
}

function extractFollowersFromTikTokHtml(html) {
  const match = html.match(/"followerCount":(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

// ======================================================
// VALIDATION DE PAGE
// ======================================================

function isValidPage(html) {
  if (!html || html.length < 500) return false;
  if (html.length > 50000) return true;
  if (html.includes("Just a moment") && html.length < 10000) return false;
  if (html.includes("cf-challenge") && html.length < 10000) return false;
  return true;
}

// ======================================================
// SOURCES — ordre de priorité.
// Direct en premier (gratuit, rapide, marche parfois), puis
// plusieurs proxys de secours différents : si l'un est en
// panne/rate-limited, les suivants prennent le relais.
// ======================================================

const TIKTOK_SOURCES = [
  {
    name: "embed-direct",
    buildUrl: (u) => `https://www.tiktok.com/embed/@${u}`,
    useProxy: false,
  },
  {
    name: "embed-codetabs",
    buildUrl: (u) => `https://www.tiktok.com/embed/@${u}`,
    useProxy: true,
    proxyUrl: (url) =>
      `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
  },
  {
    name: "embed-allorigins",
    buildUrl: (u) => `https://www.tiktok.com/embed/@${u}`,
    useProxy: true,
    proxyUrl: (url) =>
      `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  },
  {
    name: "embed-corsproxy",
    buildUrl: (u) => `https://www.tiktok.com/embed/@${u}`,
    useProxy: true,
    proxyUrl: (url) =>
      `https://corsproxy.io/?url=${encodeURIComponent(url)}`,
  },
];

// ======================================================
// FETCH — direct en priorité, proxys en secours
// ======================================================

async function fetchHtml(url, useProxy, proxyUrlFn, sourceName) {
  const targetUrl = useProxy ? proxyUrlFn(url) : url;
  const timeoutMs = useProxy ? 25000 : 20000;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(targetUrl, {
      headers: buildHeaders(),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (res.ok) {
      const html = await res.text();
      if (isValidPage(html)) {
        return html;
      }
      console.log(
        `[TikTok Monitor] ${sourceName} — réponse invalide/trop courte (${html.length} chars)`
      );
      return null;
    }

    console.log(`[TikTok Monitor] ${sourceName} — HTTP ${res.status}`);
  } catch (e) {
    console.log(`[TikTok Monitor] ${sourceName} — erreur: ${e.message}`);
  }
  return null;
}

// ======================================================
// FETCH GLOBAL — avec cache + verrou anti-concurrence
// ======================================================

async function fetchTikTokPage() {
  // Verrou anti-concurrence : si une requête est déjà en cours,
  // on attend le même résultat au lieu d'en lancer une autre
  if (fetchInProgress && fetchPromise) {
    console.log(
      `[TikTok Monitor] ⏳ Requête déjà en cours — on attend le résultat`
    );
    return fetchPromise;
  }

  // Vérifier le cache
  if (cachedHtml && Date.now() - cachedHtmlTime < HTML_CACHE_TTL) {
    console.log(
      `[TikTok Monitor] ♻️ Cache HTML (${Math.round(
        (Date.now() - cachedHtmlTime) / 1000
      )}s)`
    );
    return cachedHtml;
  }

  // Lancer la requête
  fetchInProgress = true;
  fetchPromise = _doFetchTikTokPage();

  try {
    const result = await fetchPromise;
    return result;
  } finally {
    fetchInProgress = false;
    fetchPromise = null;
  }
}

async function _doFetchTikTokPage() {
  for (const source of TIKTOK_SOURCES) {
    const url = source.buildUrl(CONFIG.username);
    console.log(`[TikTok Monitor] 🔄 Source: ${source.name}`);
    const html = await fetchHtml(
      url,
      source.useProxy,
      source.proxyUrl,
      source.name
    );
    if (html) {
      console.log(
        `[TikTok Monitor] ✅ ${source.name} — ${html.length} chars`
      );
      // Mettre en cache
      cachedHtml = html;
      cachedHtmlTime = Date.now();
      // Extraire les followers aussi pendant qu'on a le HTML
      cachedFollowers = extractFollowersFromTikTokHtml(html);
      return html;
    }
  }
  return null;
}

// ======================================================
// VÉRIFICATION VIDÉO + FOLLOWERS — partagent le même HTML
// ======================================================

async function checkLatestVideos() {
  const html = await fetchTikTokPage();
  if (!html) return null;

  const videoIds = extractAllVideosFromTikTokHtml(html);
  if (videoIds) {
    console.log(`[TikTok Monitor] ✅ ${videoIds.size} vidéo(s) trouvée(s)`);
  }
  return videoIds;
}

async function checkFollowers() {
  // Si on a les followers en cache, les retourner directement
  if (cachedFollowers !== null) {
    console.log(
      `[TikTok Monitor] ♻️ Followers en cache: ${cachedFollowers}`
    );
    return cachedFollowers;
  }

  // Sinon, faire une requête (partagée via verrou)
  const html = await fetchTikTokPage();
  if (!html) return null;

  return extractFollowersFromTikTokHtml(html);
}

// ======================================================
// NOTIFICATION DISCORD
// ======================================================

async function sendVideoNotification(guild, videoId) {
  const videoUrl = `https://www.tiktok.com/@${CONFIG.username}/video/${videoId}`;

  if (CONFIG.webhookUrl) {
    try {
      const embed = {
        title: "🎬 Nouvelle vidéo TikTok !",
        url: videoUrl,
        color: 0x00f2ea,
        description: `**@${CONFIG.username}** vient de poster une nouvelle vidéo !\nVa la regarder 🔥`,
        timestamp: new Date().toISOString(),
      };

      await fetch(CONFIG.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: "𝒁𝒆𝒏𝒚𝑿𝒙 Tiktok",
          avatar_url: "<<url_7:png>>",
          content: `@everyone **Nouvelle vidéo TikTok !** @${CONFIG.username} vient de poster !\n${videoUrl}`,
          embeds: [embed],
        }),
      });
      console.log(
        `[TikTok Monitor] 📢 Notification webhook envoyée ! Vidéo: ${videoId}`
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
        `Va la regarder 🔥`
    )
    .setTimestamp();

  try {
    await channel.send({
      content: `@everyone **Nouvelle vidéo TikTok !** @${CONFIG.username} vient de poster !\n${videoUrl}`,
      embeds: [embed],
    });
    console.log(
      `[TikTok Monitor] 📢 Notification bot envoyée ! Vidéo: ${videoId}`
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
    const videoIds = await checkLatestVideos();

    if (videoIds) {
      consecutiveFailures = 0;

      const newIds = [];
      for (const id of videoIds) {
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
        // Vraies nouvelles vidéos
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
        `[TikTok Monitor] ❌ Échec (${consecutiveFailures}/${CONFIG.maxFailures})`
      );

      if (consecutiveFailures >= CONFIG.maxFailures) {
        const guild = client.guilds.cache.values().next().value;
        if (guild) {
          const channel = guild.channels.cache.get(CONFIG.channelId);
          if (channel) {
            await channel
              .send(
                "⚠️ Le moniteur TikTok n'arrive pas à récupérer les données depuis un moment. Tous les proxies ont échoué."
              )
              .catch(() => {});
          }
        }
        consecutiveFailures = 0;
      }
    }
  } catch (e) {
    console.error(`[TikTok Monitor] Erreur boucle: ${e.message}`);
  }
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
    `[TikTok Monitor] Démarré — vérification toutes les ${
      CONFIG.checkIntervalMs / 1000
    }s`
  );
}

module.exports = { startTikTokMonitor, checkFollowers };
