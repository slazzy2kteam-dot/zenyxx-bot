/**
 * ============================================
 *   SYSTÈME TIKTOK — VERSION FIABLE & GRATUIT
 *   Multi-source + Webhook Discord + État persistant
 * ============================================
 *
 *   Fonctionne AVEC ou SANS le bot Discord connecté
 *   (utilise un webhook en fallback si le bot est down)
 *
 *   3 sources de vérification :
 *     1. Page embed TikTok (rapide, parfois bloqué)
 *     2. Page profil TikTok (plus complet, parfois bloqué)
 *     3. API non officielle TikAPI (fallback gratuit)
 *
 *   Installation :
 *     npm install node-fetch cheerio
 *
 *   Configuration à remplir ci-dessous ↓
 */

const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

// ──────────────────────────────────────────────
//  CONFIGURATION — À REMPLIR
// ──────────────────────────────────────────────

const CONFIG = {
  // Le compte TikTok à surveiller
  tiktokUsername: 'aetherofficiel',

  // Le salon Discord pour les notifications TikTok
  discordChannelId: '1548231185015120054',

  // Webhook Discord (CRÉE UN WEBHOOK dans les paramètres du salon)
  // Format : https://discord.com/api/webhooks/ID/TOKEN
  discordWebhookUrl: 'https://discord.com/api/webhooks/1548544268371623996/syygwOcpQdd2GLszvp4JHEjB3_lRS60lMEMbRnMvhWdXBYHZ2hl9As0A4tAm0JuPg5XB',

  // Intervalle de vérification (en ms) — 2 min = 120000
  checkIntervalMs: 120_000,

  // Nombre d'échecs consécutifs avant alerte
  maxConsecutiveFailures: 10,

  // Fichier pour sauvegarder l'état (survit aux redémarrages)
  stateFile: path.join(__dirname, 'tiktok-state.json'),

  // Clé API TikAPI (optionnel — gratuit jusqu'à 100 requêtes/jour)
  // Inscris-toi sur https://tikapi.io/ (gratuit)
  tikApiKey: '', // laisse vide si tu n'en as pas
};

// ──────────────────────────────────────────────
//  ÉTAT PERSISTANT
// ──────────────────────────────────────────────

function loadState() {
  try {
    if (fs.existsSync(CONFIG.stateFile)) {
      return JSON.parse(fs.readFileSync(CONFIG.stateFile, 'utf8'));
    }
  } catch (e) {
    console.error('[TikTok] Erreur lecture état:', e.message);
  }
  return {
    lastVideoId: null,
    notifiedVideos: [],    // Garde les 50 derniers IDs notifiés
    consecutiveFailures: 0,
    lastCheckTime: null,
  };
}

function saveState(state) {
  try {
    // Ne garder que les 50 derniers IDs notifiés
    if (state.notifiedVideos.length > 50) {
      state.notifiedVideos = state.notifiedVideos.slice(-50);
    }
    fs.writeFileSync(CONFIG.stateFile, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error('[TikTok] Erreur sauvegarde état:', e.message);
  }
}

// ──────────────────────────────────────────────
//  EN-TÊTES HTTP ANTI-BLOCAGE
// ──────────────────────────────────────────────

const HEADERS = [
  {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Accept':
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
  },
  {
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
    'Accept':
      'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'fr-FR,fr;q=0.9',
  },
  {
    // Googlebot — parfois TikTok le laisse passer
    'User-Agent':
      'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    'Accept': 'text/html',
  },
];

function randomHeaders() {
  return HEADERS[Math.floor(Math.random() * HEADERS.length)];
}

// ──────────────────────────────────────────────
//  SOURCE 1 : PAGE EMBED TIKTOK
// ──────────────────────────────────────────────

async function scrapeEmbedPage() {
  const url = `https://www.tiktok.com/embed/@${CONFIG.tiktokUsername}`;
  const res = await fetch(url, {
    headers: randomHeaders(),
    timeout: 15_000,
  });
  if (!res.ok) throw new Error(`Embed HTTP ${res.status}`);
  const html = await res.text();

  const videoIds = [];

  // Méthode A : regex sur les URLs vidéo
  const regex1 = /video\/(\d{10,})/g;
  let m;
  while ((m = regex1.exec(html)) !== null) {
    videoIds.push(m[1]);
  }

  // Méthode B : extraction depuis les données JSON embarquées
  try {
    const sigiMatch = html.match(/<script[^>]*id="SIGI_STATE"[^>]*>([\s\S]*?)<\/script>/);
    if (sigiMatch) {
      const data = JSON.parse(sigiMatch[1]);
      if (data.ItemModule) {
        for (const itemId of Object.keys(data.ItemModule)) {
          videoIds.push(itemId);
        }
      }
    }
  } catch (_) {}

  // Méthode C : __UNIVERSAL_DATA__
  try {
    const uniMatch = html.match(/<script[^>]*id="__UNIVERSAL_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (uniMatch) {
      const data = JSON.parse(uniMatch[1]);
      const items =
        data?.['__DEFAULT_SCOPE__']?.['webapp.user-detail']?.['userInfo']?.['itemList'];
      if (Array.isArray(items)) {
        for (const item of items) {
          if (item.id) videoIds.push(String(item.id));
        }
      }
    }
  } catch (_) {}

  // Dédupliquer
  const unique = [...new Set(videoIds)];
  if (unique.length === 0) throw new Error('Aucun ID trouvé sur embed page');

  // Trier par ordre décroissant (le + récent d'abord)
  unique.sort((a, b) => {
    if (a.length !== b.length) return b.length - a.length;
    return b.localeCompare(a);
  });

  return unique[0]; // ID le plus récent
}

// ──────────────────────────────────────────────
//  SOURCE 2 : PAGE PROFIL TIKTOK
// ──────────────────────────────────────────────

async function scrapeProfilePage() {
  const url = `https://www.tiktok.com/@${CONFIG.tiktokUsername}`;
  const res = await fetch(url, {
    headers: randomHeaders(),
    timeout: 15_000,
  });
  if (!res.ok) throw new Error(`Profile HTTP ${res.status}`);
  const html = await res.text();

  const videoIds = [];

  // Regex classique
  const regex = /video\/(\d{10,})/g;
  let m;
  while ((m = regex.exec(html)) !== null) {
    videoIds.push(m[1]);
  }

  // Données JSON SIGI_STATE
  try {
    const sigiMatch = html.match(/<script[^>]*id="SIGI_STATE"[^>]*>([\s\S]*?)<\/script>/);
    if (sigiMatch) {
      const data = JSON.parse(sigiMatch[1]);
      if (data.ItemModule) {
        for (const itemId of Object.keys(data.ItemModule)) {
          videoIds.push(itemId);
        }
      }
      if (data.ItemIds) {
        for (const id of data.ItemIds) {
          videoIds.push(String(id));
        }
      }
    }
  } catch (_) {}

  // __UNIVERSAL_DATA__
  try {
    const uniMatch = html.match(/<script[^>]*id="__UNIVERSAL_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (uniMatch) {
      const data = JSON.parse(uniMatch[1]);
      const items =
        data?.['__DEFAULT_SCOPE__']?.['webapp.user-detail']?.['userInfo']?.['itemList'];
      if (Array.isArray(items)) {
        for (const item of items) {
          if (item.id) videoIds.push(String(item.id));
        }
      }
    }
  } catch (_) {}

  const unique = [...new Set(videoIds)];
  if (unique.length === 0) throw new Error('Aucun ID trouvé sur profile page');

  unique.sort((a, b) => {
    if (a.length !== b.length) return b.length - a.length;
    return b.localeCompare(a);
  });

  return unique[0];
}

// ──────────────────────────────────────────────
//  SOURCE 3 : TIKAPI (gratuit, 100 req/jour)
// ──────────────────────────────────────────────

async function fetchTikApi() {
  if (!CONFIG.tikApiKey) throw new Error('Pas de clé TikAPI');

  const url = `https://api.tikapi.io/user/${CONFIG.tiktokUsername}`;
  const res = await fetch(url, {
    headers: {
      'X-API-KEY': CONFIG.tikApiKey,
      'Accept': 'application/json',
    },
    timeout: 10_000,
  });
  if (!res.ok) throw new Error(`TikAPI HTTP ${res.status}`);
  const data = await res.json();

  // La structure dépend de TikAPI — à adapter selon leur doc
  const videos = data?.content?.items || data?.items || [];
  if (videos.length === 0) throw new Error('TikAPI : aucune vidéo');

  return String(videos[0].id || videos[0].video_id);
}

// ──────────────────────────────────────────────
//  RÉCUPÉRER LES INFOS D'UNE VIDÉO
// ──────────────────────────────────────────────

async function getVideoInfo(videoId) {
  try {
    const url = `https://www.tiktok.com/embed/v2/${videoId}`;
    const res = await fetch(url, {
      headers: randomHeaders(),
      timeout: 10_000,
    });
    if (!res.ok) return null;
    const html = await res.text();

    // Extraire la description
    let description = '';
    const descMatch = html.match(
      /<meta\s+property="og:title"\s+content="([^"]*)"/
    );
    if (descMatch) description = descMatch[1];

    // Extraire la miniature
    let thumbnail = '';
    const thumbMatch = html.match(
      /<meta\s+property="og:image"\s+content="([^"]*)"/
    );
    if (thumbMatch) thumbnail = thumbMatch[1];

    return { description, thumbnail };
  } catch (_) {
    return null;
  }
}

// ──────────────────────────────────────────────
//  ENVOYER NOTIFICATION DISCORD (Webhook)
// ──────────────────────────────────────────────

async function sendDiscordWebhook(videoId, videoInfo) {
  const videoUrl = `https://www.tiktok.com/@${CONFIG.tiktokUsername}/video/${videoId}`;

  const payload = {
    content: '@everyone 🎬 Nouvelle vidéo TikTok !',
    embeds: [
      {
        title: 'Nouvelle vidéo de @' + CONFIG.tiktokUsername,
        url: videoUrl,
        description: videoInfo?.description
          ? videoInfo.description.slice(0, 300)
          : 'Nouvelle vidéo publiée !',
        color: 0xff0050, // Couleur TikTok
        image: videoInfo?.thumbnail
          ? { url: videoInfo.thumbnail }
          : undefined,
        footer: {
          text: 'TikTok Monitor • Multi-source',
        },
        timestamp: new Date().toISOString(),
      },
    ],
  };

  try {
    const res = await fetch(CONFIG.discordWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      timeout: 10_000,
    });
    if (!res.ok) throw new Error(`Webhook HTTP ${res.status}`);
    console.log('[TikTok] ✅ Notification envoyée via webhook');
    return true;
  } catch (e) {
    console.error('[TikTok] ❌ Erreur webhook:', e.message);
    return false;
  }
}

// ──────────────────────────────────────────────
//  ENVOYER NOTIFICATION VIA LE BOT (fallback)
// ──────────────────────────────────────────────

async function sendViaBot(client, videoId, videoInfo) {
  if (!client || !client.isReady()) return false;

  try {
    const channel = client.channels.cache.get(CONFIG.discordChannelId);
    if (!channel) return false;

    const videoUrl = `https://www.tiktok.com/@${CONFIG.tiktokUsername}/video/${videoId}`;

    const embed = {
      title: 'Nouvelle vidéo de @' + CONFIG.tiktokUsername,
      url: videoUrl,
      description: videoInfo?.description
        ? videoInfo.description.slice(0, 300)
        : 'Nouvelle vidéo publiée !',
      color: 0xff0050,
      image: videoInfo?.thumbnail
        ? { url: videoInfo.thumbnail }
        : undefined,
      footer: {
        text: 'TikTok Monitor • Multi-source',
      },
      timestamp: new Date().toISOString(),
    };

    await channel.send({
      content: '@everyone 🎬 Nouvelle vidéo TikTok !',
      embeds: [embed],
    });

    console.log('[TikTok] ✅ Notification envoyée via le bot');
    return true;
  } catch (e) {
    console.error('[TikTok] ❌ Erreur bot:', e.message);
    return false;
  }
}

// ──────────────────────────────────────────────
//  ENVOYER ALERTE D'ÉCHEC
// ──────────────────────────────────────────────

async function sendFailureAlert(client, failureCount) {
  const msg = `⚠️ **Alerte TikTok Monitor** : ${failureCount} vérifications consécutives échouées. Le scraping ne fonctionne plus — vérifie le système !`;

  // Essayer le webhook d'abord
  try {
    await fetch(CONFIG.discordWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: msg }),
      timeout: 10_000,
    });
    return;
  } catch (_) {}

  // Fallback via le bot
  if (client && client.isReady()) {
    try {
      const channel = client.channels.cache.get(CONFIG.discordChannelId);
      if (channel) await channel.send(msg);
    } catch (_) {}
  }
}

// ──────────────────────────────────────────────
//  BOUCLE PRINCIPALE
// ──────────────────────────────────────────────

let checkInterval = null;

/**
 * Démarre la surveillance TikTok.
 * @param {object} client - Instance du client Discord (optionnel si webhook configuré)
 */
function startTikTokMonitor(client = null) {
  const state = loadState();
  console.log('[TikTok] 🚀 Moniteur démarré (multi-source)');
  console.log(`[TikTok] Dernière vidéo connue : ${state.lastVideoId || 'aucune'}`);
  console.log(`[TikTok] Vidéos notifiées : ${state.notifiedVideos.length}`);

  async function check() {
    console.log(`[TikTok] 🔍 Vérification... (${new Date().toLocaleTimeString('fr-FR')})`);

    let latestVideoId = null;
    let sourceUsed = null;

    // ── Essayer Source 1 : Embed page ──
    try {
      latestVideoId = await scrapeEmbedPage();
      sourceUsed = 'embed';
      console.log(`[TikTok] ✅ Source embed : ${latestVideoId}`);
    } catch (e) {
      console.warn(`[TikTok] ⚠️ Embed échoué : ${e.message}`);
    }

    // ── Essayer Source 2 : Profile page (si embed échoué) ──
    if (!latestVideoId) {
      try {
        latestVideoId = await scrapeProfilePage();
        sourceUsed = 'profile';
        console.log(`[TikTok] ✅ Source profile : ${latestVideoId}`);
      } catch (e) {
        console.warn(`[TikTok] ⚠️ Profile échoué : ${e.message}`);
      }
    }

    // ── Essayer Source 3 : TikAPI (si les 2 autres ont échoué) ──
    if (!latestVideoId) {
      try {
        latestVideoId = await fetchTikApi();
        sourceUsed = 'tikapi';
        console.log(`[TikTok] ✅ Source TikAPI : ${latestVideoId}`);
      } catch (e) {
        console.warn(`[TikTok] ⚠️ TikAPI échoué : ${e.message}`);
      }
    }

    // ── Aucune source n'a fonctionné ──
    if (!latestVideoId) {
      state.consecutiveFailures++;
      console.error(`[TikTok] ❌ Toutes les sources ont échoué (${state.consecutiveFailures}/${CONFIG.maxConsecutiveFailures})`);

      if (state.consecutiveFailures === CONFIG.maxConsecutiveFailures) {
        await sendFailureAlert(client, state.consecutiveFailures);
      }

      saveState(state);
      return;
    }

    // ── Succès → réinitialiser le compteur ──
    state.consecutiveFailures = 0;

    // ── Nouvelle vidéo détectée ? ──
    if (state.notifiedVideos.includes(latestVideoId)) {
      // Déjà notifiée, rien à faire
      state.lastCheckTime = new Date().toISOString();
      saveState(state);
      return;
    }

    if (state.lastVideoId === null) {
      // Premier lancement — enregistrer sans notifier
      // (pour ne pas spam à chaque redémarrage du bot)
      console.log(`[TikTok] 📝 Premier lancement — vidéo enregistrée sans notification : ${latestVideoId}`);
      state.lastVideoId = latestVideoId;
      state.notifiedVideos.push(latestVideoId);
      state.lastCheckTime = new Date().toISOString();
      saveState(state);
      return;
    }

    if (latestVideoId !== state.lastVideoId) {
      console.log(`[TikTok] 🎉 NOUVELLE VIDÉO ! ${latestVideoId} (source: ${sourceUsed})`);

      // Récupérer les infos de la vidéo
      const videoInfo = await getVideoInfo(latestVideoId);

      // Essayer le webhook d'abord (plus fiable)
      let sent = false;
      if (CONFIG.discordWebhookUrl && CONFIG.discordWebhookUrl !== 'REMPLACER_PAR_URL_WEBHOOK') {
        sent = await sendDiscordWebhook(latestVideoId, videoInfo);
      }

      // Fallback via le bot si le webhook a échoué ou n'est pas configuré
      if (!sent && client) {
        sent = await sendViaBot(client, latestVideoId, videoInfo);
      }

      if (sent) {
        state.lastVideoId = latestVideoId;
        state.notifiedVideos.push(latestVideoId);
      }
    }

    state.lastCheckTime = new Date().toISOString();
    saveState(state);
  }

  // Première vérification immédiate
  check();

  // Puis toutes les X minutes
  checkInterval = setInterval(check, CONFIG.checkIntervalMs);
}

/**
 * Arrête la surveillance TikTok.
 */
function stopTikTokMonitor() {
  if (checkInterval) {
    clearInterval(checkInterval);
    checkInterval = null;
    console.log('[TikTok] 🛑 Moniteur arrêté');
  }
}

// ──────────────────────────────────────────────
//  EXPORTS
// ──────────────────────────────────────────────

module.exports = {
  startTikTokMonitor,
  stopTikTokMonitor,
  CONFIG, // permet de modifier la config depuis l'extérieur
};

// ──────────────────────────────────────────────
//  UTILISATION STANDALONE (sans bot Discord)
//  Si tu veux tester juste le moniteur :
//    node tiktok-monitor-robust.js
// ──────────────────────────────────────────────

if (require.main === module) {
  if (CONFIG.discordWebhookUrl === 'REMPLACER_PAR_URL_WEBHOOK') {
    console.error('❌ Configure ton URL webhook dans CONFIG.discordWebhookUrl !');
    process.exit(1);
  }
  startTikTokMonitor(null);
}
