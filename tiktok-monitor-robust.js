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
  webhookUrl: "https://discord.com/api/webhooks/1548544268371623996/syygwOcpQdd2GLszvp4JHEjB3_lRS60lMEMbRnMvhWdXBYHZ2hl9As0A4tAm0JuPg5XB",
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

// Set des IDs de vidéos déjà notifiées (survit aux redémarrages via fichier)
let knownVideoIds = new Set();

// Charger les IDs connus depuis le fichier
function loadKnownIds() {
  try {
    if (fs.existsSync(CONFIG.knownIdsFile)) {
      const data = JSON.parse(fs.readFileSync(CONFIG.knownIdsFile, "utf8"));
      knownVideoIds = new Set(data);
      console.log(`[TikTok Monitor] 📂 ${knownVideoIds.size} IDs déjà connus chargés`);
    }
  } catch (e) {
    console.error(`[TikTok Monitor] Erreur chargement IDs: ${e.message}`);
  }
}

// Sauvegarder les IDs connus dans le fichier
function saveKnownIds() {
  try {
    fs.writeFileSync(CONFIG.knownIdsFile, JSON.stringify([...knownVideoIds]), "utf8");
  } catch (e) {
    console.error(`[TikTok Monitor] Erreur sauvegarde IDs: ${e.message}`);
  }
}

// ======================================================
// PROXIES + SOURCES
// ======================================================

const PROXIES = [
  {
    name: "allorigins",
    buildUrl: (url) =>
      `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  },
  {
    name: "corsproxy",
    buildUrl: (url) =>
      `https://corsproxy.io/?${encodeURIComponent(url)}`,
  },
  {
    name: "codetabs",
    buildUrl: (url) =>
      `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
  },
];

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

// Sources TikTok — on essaie dans l'ordre
const TIKTOK_SOURCES = [
  {
    name: "embed",
    buildUrl: (u) => `https://www.tiktok.com/embed/@${u}`,
    extractVideos: extractAllVideosFromTikTokHtml,
    extractFollowers: extractFollowersFromTikTokHtml,
  },
  {
    name: "profile",
    buildUrl: (u) => `https://www.tiktok.com/@${u}`,
    extractVideos: extractAllVideosFromTikTokHtml,
    extractFollowers: extractFollowersFromTikTokHtml,
  },
  // urlebird = site tiers qui affiche les profils TikTok
  // souvent pas bloqué depuis les datacenters
  {
    name: "urlebird",
    buildUrl: (u) => `https://urlebird.com/user/${u}/`,
    extractVideos: extractAllVideosFromUrlebird,
    extractFollowers: null, // pas fiable sur urlebird
  },
];

// ======================================================
// EXTRACTION — TikTok HTML (tous les IDs)
// ======================================================

function extractAllVideosFromTikTokHtml(html) {
  const ids = new Set();

  // Méthode 1 : video/7684717468039908631 dans les URLs
  const urlMatches = html.match(/video\/(\d{10,})/g);
  if (urlMatches) {
    for (const m of urlMatches) {
      const id = m.match(/video\/(\d{10,})/);
      if (id) ids.add(id[1]);
    }
  }

  // Méthode 2 : "id":"7684717468039908631" dans le JSON
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
// EXTRACTION — Urlebird HTML (tous les IDs)
// ======================================================

function extractAllVideosFromUrlebird(html) {
  const ids = new Set();
  const matches = html.match(/video\/(\d{10,})/g);
  if (matches) {
    for (const m of matches) {
      const id = m.match(/video\/(\d{10,})/);
      if (id) ids.add(id[1]);
    }
  }
  return ids.size > 0 ? ids : null;
}

// ======================================================
// FETCH VIA PROXY — avec validation intelligente
// ======================================================

function isValidPage(html) {
  if (!html || html.length < 500) return false;
  // Les pages CAPTCHA font généralement < 20KB
  // Si la page fait > 50KB, c'est presque certainement du vrai contenu
  if (html.length > 50000) return true;
  // Pour les pages plus petites, vérifier les signes de CAPTCHA
  if (html.includes("Just a moment") && html.length < 10000) return false;
  if (html.includes("cf-challenge") && html.length < 10000) return false;
  return true;
}

async function fetchViaProxy(targetUrl) {
  for (const proxy of PROXIES) {
    try {
      const proxyUrl = proxy.buildUrl(targetUrl);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);

      const res = await fetch(proxyUrl, {
        headers: HEADERS,
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (res.ok) {
        const html = await res.text();
        if (isValidPage(html)) {
          console.log(
            `[TikTok Monitor] ✅ Proxy ${proxy.name} — ${html.length} chars`
          );
          return html;
        }
        console.log(
          `[TikTok Monitor] Proxy ${proxy.name} — page invalide (${html.length} chars)`
        );
      } else {
        console.log(`[TikTok Monitor] Proxy ${proxy.name} — HTTP ${res.status}`);
      }
    } catch (e) {
      console.log(`[TikTok Monitor] Proxy ${proxy.name} — erreur: ${e.message}`);
    }
  }

  // Dernier recours : requête directe
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(targetUrl, { headers: HEADERS, signal: controller.signal });
    clearTimeout(timeout);
    if (res.ok) {
      const html = await res.text();
      if (isValidPage(html)) {
        console.log(`[TikTok Monitor] ✅ Direct — ${html.length} chars`);
        return html;
      }
    }
    console.log(`[TikTok Monitor] Direct — HTTP ${res.status}`);
  } catch (e) {
    console.log(`[TikTok Monitor] Direct échoué: ${e.message}`);
  }

  return null;
}

// ======================================================
// VÉRIFICATION MULTI-SOURCE
// ======================================================

async function checkLatestVideos() {
  for (const source of TIKTOK_SOURCES) {
    const url = source.buildUrl(CONFIG.username);
    console.log(`[TikTok Monitor] 🔄 Source: ${source.name}`);
    const html = await fetchViaProxy(url);
    if (html) {
      const videoIds = source.extractVideos(html);
      if (videoIds) {
        console.log(
          `[TikTok Monitor] ✅ ${videoIds.size} vidéo(s) trouvée(s) via ${source.name}`
        );
        return videoIds;
      }
      // Page valide mais pas de vidéo trouvée — debug
      console.log(
        `[TikTok Monitor] Source ${source.name} — page OK mais pas d'ID vidéo`
      );
    }
  }
  return null;
}

// Garder pour compatibilité (checkFollowers utilisé par index.js)
async function checkFollowers() {
  for (const source of TIKTOK_SOURCES) {
    if (!source.extractFollowers) continue;
    const url = source.buildUrl(CONFIG.username);
    const html = await fetchViaProxy(url);
    if (html) {
      const count = source.extractFollowers(html);
      if (count !== null) {
        console.log(
          `[TikTok Monitor] ✅ Followers via ${source.name}: ${count}`
        );
        return count;
      }
    }
  }
  return null;
}

// ======================================================
// NOTIFICATION DISCORD
// ======================================================

async function sendVideoNotification(guild, videoId) {
  const videoUrl = `https://www.tiktok.com/@${CONFIG.username}/video/${videoId}`;

  // Utiliser le webhook pour un look "TikTok" propre
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
          avatar_url: "https://storage.googleapis.com/ot-pt/present_files/2026-09-13/anonymous/default/1f018aec17fb44529f0310067b3fae75_.png?Expires=1791870576&GoogleAccessId=gcs-owner%40oreateai-434511.iam.gserviceaccount.com&Signature=NnzB%2BlSUAh%2Brwa2jmyg4LCmZmtQ3AOdKGYnaXmqzbSPQ8cDRyfpGnyFdeBD08t1IrfdqdHbT%2Bb1Fksn8jYKIOUVtMPo1cm5gdDL5S0%2B81Eq%2BFtzDK8MquOBkAtX6v1QAea6MsiCy8sowlveYZOrui0tp4pegRpr1DZidLHJQL9pqE2r1Pw8jLBVp9W4ezXyAUAoJxv4Dm5FUL9nM79mLhCMfAD5rXGyINXW6zH94tw5sQRTYMKJB5qcNnDEa5vNVoTzndKVVUhJLdbReKJcthydUy4vuTZBzRnRLk5%2B%2Focq5TVkihzgcExvof28qLSSoaBisMLdG45%2BJ0VDnsVO1iA%3D%3D",
          content: `@everyone **Nouvelle vidéo TikTok !** @${CONFIG.username} vient de poster !\n${videoUrl}`,
          embeds: [embed],
        }),
      });
      console.log(`[TikTok Monitor] 📢 Notification webhook envoyée ! Vidéo: ${videoId}`);
      return;
    } catch (err) {
      console.error(`[TikTok Monitor] Erreur webhook: ${err.message} — fallback via bot`);
    }
  }

  // Fallback : envoyer via le bot si le webhook échoue
  const channel = guild.channels.cache.get(CONFIG.channelId);
  if (!channel) {
    console.error(`[TikTok Monitor] Salon introuvable — ID: ${CONFIG.channelId}`);
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
    console.log(`[TikTok Monitor] 📢 Notification bot envoyée ! Vidéo: ${videoId}`);
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

      // Trouver les NOUVEAUX IDs qu'on a jamais vus
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
        // Des vraies nouvelles vidéos !
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
    }s via proxy + urlebird`
  );
}

module.exports = { startTikTokMonitor, checkFollowers };
