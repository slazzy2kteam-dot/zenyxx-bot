const fetch = require("node-fetch");
const { EmbedBuilder } = require("discord.js");

// ======================================================
// CONFIGURATION
// ======================================================

const CONFIG = {
  username: "aetherofficiel",
  channelId: "1548231185015120054", // 📺・tiktok
  checkIntervalMs: 2 * 60 * 1000, // 2 minutes
  maxFailures: 10, // alerte Discord après 10 échecs consécutifs
};

// ======================================================
// ÉTAT
// ======================================================

let lastVideoId = null;
let consecutiveFailures = 0;
let intervalId = null;
let client = null;

// ======================================================
// PROXY GRATUITS — Pas de compte, pas de carte bancaire
// ======================================================
//
// TikTok bloque les requêtes depuis les datacenters (Render, Railway…)
// On passe par des services de proxy CORS gratuits qui relaisent
// la requête depuis leurs propres serveurs.
//
// Si un proxy est down ou bloqué, on essaie le suivant.
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

// ======================================================
// FETCH VIA PROXY
// ======================================================

async function fetchViaProxy(targetUrl) {
  // Essayer chaque proxy dans l'ordre
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
        // Vérifier que la réponse est valide (pas une page CAPTCHA)
        if (
          html &&
          html.length > 500 &&
          !html.includes("Just a moment") &&
          !html.includes("captcha") &&
          !html.includes("cf-challenge")
        ) {
          console.log(`[TikTok Monitor] ✅ Proxy ${proxy.name} — OK`);
          return html;
        }
        console.log(
          `[TikTok Monitor] Proxy ${proxy.name} — réponse invalide (${html.length} chars, possible CAPTCHA)`
        );
      } else {
        console.log(
          `[TikTok Monitor] Proxy ${proxy.name} — HTTP ${res.status}`
        );
      }
    } catch (e) {
      console.log(`[TikTok Monitor] Proxy ${proxy.name} — erreur: ${e.message}`);
    }
  }

  // Dernier recours : requête directe (fonctionne en local, pas depuis Render)
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const res = await fetch(targetUrl, {
      headers: HEADERS,
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (res.ok) {
      const html = await res.text();
      if (html && html.length > 500) {
        console.log("[TikTok Monitor] ✅ Requête directe OK");
        return html;
      }
    }
    console.log(
      `[TikTok Monitor] Requête directe — HTTP ${res.status}`
    );
  } catch (e) {
    console.log(`[TikTok Monitor] Requête directe échouée: ${e.message}`);
  }

  return null;
}

// ======================================================
// EXTRACTION DES DONNÉES
// ======================================================

function extractLatestVideoId(html) {
  // Chercher les IDs dans les URLs : video/7684717468039908631
  const matches = html.match(/video\/(\d{10,})/g);
  if (matches && matches.length > 0) {
    const idMatch = matches[0].match(/video\/(\d{10,})/);
    return idMatch ? idMatch[1] : null;
  }
  return null;
}

function extractFollowerCount(html) {
  const match = html.match(/"followerCount":(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

// ======================================================
// VÉRIFICATION VIDÉO + FOLLOWERS
// ======================================================

async function checkLatestVideo() {
  const embedUrl = `https://www.tiktok.com/embed/@${CONFIG.username}`;
  const html = await fetchViaProxy(embedUrl);
  return html ? extractLatestVideoId(html) : null;
}

async function checkFollowers() {
  const profileUrl = `https://www.tiktok.com/@${CONFIG.username}`;
  const html = await fetchViaProxy(profileUrl);
  return html ? extractFollowerCount(html) : null;
}

// ======================================================
// NOTIFICATION DISCORD
// ======================================================

async function sendVideoNotification(guild, videoId) {
  const channel = guild.channels.cache.get(CONFIG.channelId);
  if (!channel) {
    console.error(
      `[TikTok Monitor] Salon introuvable — ID: ${CONFIG.channelId}`
    );
    return;
  }

  const videoUrl = `https://www.tiktok.com/@${CONFIG.username}/video/${videoId}`;

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
      `[TikTok Monitor] 📢 Notification envoyée ! Vidéo: ${videoId}`
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

  for (const guild of client.guilds.cache.values()) {
    try {
      // --- Vérification nouvelle vidéo ---
      const videoId = await checkLatestVideo();

      if (videoId) {
        consecutiveFailures = 0;

        if (lastVideoId === null) {
          // Premier lancement : stocker l'ID sans notifier
          lastVideoId = videoId;
          console.log(
            `[TikTok Monitor] Premier lancement — ID initial: ${videoId}`
          );
        } else if (videoId !== lastVideoId) {
          // Nouvelle vidéo détectée !
          console.log(
            `[TikTok Monitor] 🎬 Nouvelle vidéo détectée ! ID: ${videoId}`
          );
          lastVideoId = videoId;
          await sendVideoNotification(guild, videoId);
        } else {
          console.log("[TikTok Monitor] Pas de nouvelle vidéo");
        }
      } else {
        consecutiveFailures++;
        console.error(
          `[TikTok Monitor] ❌ Échec (${consecutiveFailures}/${CONFIG.maxFailures})`
        );

        if (consecutiveFailures >= CONFIG.maxFailures) {
          const channel = guild.channels.cache.get(CONFIG.channelId);
          if (channel) {
            await channel
              .send(
                "⚠️ Le moniteur TikTok n'arrive pas à récupérer les données depuis un moment. Tous les proxies ont échoué."
              )
              .catch(() => {});
          }
          consecutiveFailures = 0; // Reset pour éviter le spam
        }
      }
    } catch (e) {
      console.error(`[TikTok Monitor] Erreur boucle: ${e.message}`);
    }
  }
}

// ======================================================
// DÉMARRAGE
// ======================================================

function startTikTokMonitor(discordClient) {
  client = discordClient;
  monitorLoop();
  intervalId = setInterval(monitorLoop, CONFIG.checkIntervalMs);
  console.log(
    `[TikTok Monitor] Démarré — vérification toutes les ${
      CONFIG.checkIntervalMs / 1000
    }s via proxy gratuit`
  );
}

// ======================================================
// EXPORTS
// ======================================================

module.exports = { startTikTokMonitor, checkFollowers };
