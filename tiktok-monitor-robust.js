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
// HEADERS — User-Agent réalistes + cookies factices
// pour ressembler à un vrai navigateur.
//
// 🔧 FIX : Ajout de cookies factices et d'en-têtes
// supplémentaires pour contourner le blocage bot
// de TikTok/Cloudflare.
// ======================================================

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0",
];

function buildHeaders() {
  const ua = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
  // 🔧 FIX : Cookies factices pour que TikTok croit à un vrai navigateur
  const dummyCookies = [
    "tt_webid_v2=71" + Math.random().toString(36).slice(2, 12),
    "tt_webid=71" + Math.random().toString(36).slice(2, 12),
    "sid=t=xxx" + Math.random().toString(36).slice(2, 10),
    "odin_tt=xxx",
    "bm_sz=xxx",
    "domain_ver=xxx",
  ].join("; ");

  return {
    "User-Agent": ua,
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9,fr;q=0.8",
    "Accept-Encoding": "gzip, deflate, br",
    Referer: "https://www.tiktok.com/",
    Cookie: dummyCookies,
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
  };
}

// ======================================================
// EXTRACTION — TikTok HTML (tous les IDs + followers)
//
// 🔧 FIX MAJEUR : Extraction depuis le JSON embarqué
// __UNIVERSAL_DATA_FOR_REHYDRATION__ et RENDER_DATA
// au lieu de se baser uniquement sur des regex fragiles.
// Le JSON structuré contient la liste complète des
// vidéos et le compteur de followers.
// ======================================================

function extractAllVideosFromTikTokHtml(html) {
  const ids = new Set();

  // ─── Méthode 1 : __UNIVERSAL_DATA_FOR_REHYDRATION__ ───
  // C'est la source de données la plus fiable sur la page profil.
  const universalMatch = html.match(
    /<script\s+id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>\s*([\s\S]*?)\s*<\/script>/
  );
  if (universalMatch) {
    try {
      const data = JSON.parse(universalMatch[1]);
      // Parcourir les scopes à la recherche des vidéos
      for (const scopeKey of Object.keys(data)) {
        const scope = data[scopeKey];
        if (!scope || typeof scope !== "object") continue;
        for (const moduleKey of Object.keys(scope)) {
          const module = scope[moduleKey];
          if (!module || typeof module !== "object") continue;

          // itemList contient les vidéos du profil
          if (Array.isArray(module.itemList)) {
            for (const item of module.itemList) {
              if (item.id) ids.add(String(item.id));
            }
          }

          // Certaines structures imbriquées
          if (module.itemList && Array.isArray(module.itemList)) {
            for (const item of module.itemList) {
              if (item.id) ids.add(String(item.id));
            }
          }

          // Vérifier les sous-objets aussi
          if (module.userInfo && module.userInfo.itemList) {
            for (const item of module.userInfo.itemList) {
              if (item.id) ids.add(String(item.id));
            }
          }
        }
      }
      if (ids.size > 0) {
        console.log(
          `[TikTok Monitor] 📋 ${ids.size} ID(s) extrait(s) depuis __UNIVERSAL_DATA__`
        );
      }
    } catch (e) {
      console.log(
        `[TikTok Monitor] ⚠️ Parse __UNIVERSAL_DATA__ échoué: ${e.message}`
      );
    }
  }

  // ─── Méthode 2 : RENDER_DATA (base64 encodé) ───
  const renderMatch = html.match(
    /<script\s+id="RENDER_DATA"\s+type="application\/json">([^<]+)<\/script>/
  );
  if (renderMatch) {
    try {
      const decoded = JSON.parse(decodeURIComponent(renderMatch[1]));
      for (const key of Object.keys(decoded)) {
        const section = decoded[key];
        if (!section || typeof section !== "object") continue;

        // Chercher les vidéos dans la structure
        if (section.ItemModule) {
          for (const itemKey of Object.keys(section.ItemModule)) {
            const item = section.ItemModule[itemKey];
            if (item.id) ids.add(String(item.id));
          }
        }
        if (section.ItemList) {
          for (const item of section.ItemList) {
            if (item.id) ids.add(String(item.id));
          }
        }
        // Parcours générique
        if (section.aweme_list) {
          for (const item of section.aweme_list) {
            if (item.aweme_id) ids.add(String(item.aweme_id));
            else if (item.id) ids.add(String(item.id));
          }
        }
      }
      if (ids.size > 0) {
        console.log(
          `[TikTok Monitor] 📋 ${ids.size} ID(s) extrait(s) depuis RENDER_DATA`
        );
      }
    } catch (e) {
      console.log(
        `[TikTok Monitor] ⚠️ Parse RENDER_DATA échoué: ${e.message}`
      );
    }
  }

  // ─── Méthode 3 : SIGI_STATE ───
  const sigiMatch = html.match(
    /<script[^>]*>window\['SIGI_STATE'\]\s*=\s*JSON\.parse\('([\s\S]*?)'\);?<\/script>/
  );
  if (sigiMatch) {
    try {
      const data = JSON.parse(sigiMatch[1]);
      // ItemModule contient les vidéos
      if (data.ItemModule) {
        for (const itemKey of Object.keys(data.ItemModule)) {
          const item = data.ItemModule[itemKey];
          if (item.id) ids.add(String(item.id));
        }
      }
      if (data.ItemList) {
        for (const item of data.ItemList) {
          if (item.id) ids.add(String(item.id));
        }
      }
      if (ids.size > 0) {
        console.log(
          `[TikTok Monitor] 📋 ${ids.size} ID(s) extrait(s) depuis SIGI_STATE`
        );
      }
    } catch (e) {
      console.log(
        `[TikTok Monitor] ⚠️ Parse SIGI_STATE échoué: ${e.message}`
      );
    }
  }

  // ─── Méthode 4 : Regex de secours (ancienne méthode) ───
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
  // ─── Méthode 1 : __UNIVERSAL_DATA_FOR_REHYDRATION__ ───
  const universalMatch = html.match(
    /<script\s+id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>\s*([\s\S]*?)\s*<\/script>/
  );
  if (universalMatch) {
    try {
      const data = JSON.parse(universalMatch[1]);
      for (const scopeKey of Object.keys(data)) {
        const scope = data[scopeKey];
        if (!scope || typeof scope !== "object") continue;
        for (const moduleKey of Object.keys(scope)) {
          const module = scope[moduleKey];
          if (!module || typeof module !== "object") continue;

          // followerCount est souvent dans userInfo.stats
          if (module.userInfo && module.userInfo.stats) {
            const fc = module.userInfo.stats.followerCount;
            if (typeof fc === "number") return fc;
          }
          // Autre structure possible
          if (module.stats && typeof module.stats.followerCount === "number") {
            return module.stats.followerCount;
          }
        }
      }
    } catch (e) {
      // On continue avec les autres méthodes
    }
  }

  // ─── Méthode 2 : RENDER_DATA ───
  const renderMatch = html.match(
    /<script\s+id="RENDER_DATA"\s+type="application\/json">([^<]+)<\/script>/
  );
  if (renderMatch) {
    try {
      const decoded = JSON.parse(decodeURIComponent(renderMatch[1]));
      for (const key of Object.keys(decoded)) {
        const section = decoded[key];
        if (!section || typeof section !== "object") continue;
        if (section.UserModule && section.UserModule.stats) {
          const fc = section.UserModule.stats.followerCount;
          if (typeof fc === "number") return fc;
        }
      }
    } catch (e) {
      // continuer
    }
  }

  // ─── Méthode 3 : Regex (ancienne méthode, fallback) ───
  const match = html.match(/"followerCount":(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

// ======================================================
// VALIDATION DE PAGE
//
// 🔧 FIX : Validation plus stricte — détection des
// pages Cloudflare/CAPTCHA même quand elles sont longues.
// ======================================================

function isValidPage(html) {
  if (!html || html.length < 500) return false;

  // Signes de page de challenge Cloudflare / CAPTCHA
  const challengeSigns = [
    "Just a moment",
    "cf-challenge",
    "Enable JavaScript",
    "Checking your browser",
    "Please Wait",
    "Attention Required",
    "ray ID",
    "_cfduid",
    "challenge-platform",
    "cf-browser-verification",
  ];

  // Si la page contient des signes de challenge ET est courte,
  // c'est certainement un blocage
  const hasChallenge = challengeSigns.some((s) =>
    html.toLowerCase().includes(s.toLowerCase())
  );
  if (hasChallenge && html.length < 80000) return false;

  // La page doit contenir du contenu TikTok
  const hasTikTokContent =
    html.includes("tiktok.com") ||
    html.includes("TikTok") ||
    html.includes("tiktok") ||
    html.includes("__UNIVERSAL_DATA") ||
    html.includes("RENDER_DATA") ||
    html.includes("SIGI_STATE");

  if (!hasTikTokContent) return false;

  return true;
}

// ======================================================
// SOURCES — ordre de priorité.
//
// 🔧 FIX MAJEUR :
// 1. La page profil (@username) est utilisée en priorité
//    au lieu de /embed/@username qui ne contient PAS
//    la liste complète des vidéos.
// 2. La version mobile (m.tiktok.com) est ajoutée car
//    elle est souvent moins protégée par Cloudflare.
// 3. L'embed reste en dernier recours.
// 4. Plus de proxys de secours.
// ======================================================

const TIKTOK_SOURCES = [
  // ─── Priorité 1 : Page profil directe ───
  {
    name: "profile-direct",
    buildUrl: (u) => `https://www.tiktok.com/@${u}`,
    useProxy: false,
  },
  // ─── Priorité 2 : Page profil via proxy ───
  {
    name: "profile-codetabs",
    buildUrl: (u) => `https://www.tiktok.com/@${u}`,
    useProxy: true,
    proxyUrl: (url) =>
      `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
  },
  {
    name: "profile-allorigins",
    buildUrl: (u) => `https://www.tiktok.com/@${u}`,
    useProxy: true,
    proxyUrl: (url) =>
      `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  },
  {
    name: "profile-corsproxy",
    buildUrl: (u) => `https://www.tiktok.com/@${u}`,
    useProxy: true,
    proxyUrl: (url) =>
      `https://corsproxy.io/?${encodeURIComponent(url)}`,
  },
  // ─── Priorité 3 : Page profil MOBILE (moins de protection) ───
  {
    name: "mobile-direct",
    buildUrl: (u) => `https://m.tiktok.com/@${u}`,
    useProxy: false,
  },
  {
    name: "mobile-codetabs",
    buildUrl: (u) => `https://m.tiktok.com/@${u}`,
    useProxy: true,
    proxyUrl: (url) =>
      `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
  },
  // ─── Priorité 4 : Embed (dernier recours) ───
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
      `https://corsproxy.io/?${encodeURIComponent(url)}`,
  },
];

// ======================================================
// FETCH — direct en priorité, proxys en secours
// ======================================================

async function fetchHtml(url, useProxy, proxyUrlFn, sourceName) {
  const targetUrl = useProxy ? proxyUrlFn(url) : url;
  const timeoutMs = useProxy ? 30000 : 20000;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(targetUrl, {
      headers: buildHeaders(),
      signal: controller.signal,
      redirect: "follow",
    });
    clearTimeout(timeout);

    if (res.ok) {
      const html = await res.text();
      if (isValidPage(html)) {
        return html;
      }
      console.log(
        `[TikTok Monitor] ${sourceName} — réponse invalide/blocage (${html.length} chars)`
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
  if (fetchInProgress && fetchPromise) {
    console.log(
      `[TikTok Monitor] ⏳ Requête déjà en cours — on attend le résultat`
    );
    return fetchPromise;
  }

  if (cachedHtml && Date.now() - cachedHtmlTime < HTML_CACHE_TTL) {
    console.log(
      `[TikTok Monitor] ♻️ Cache HTML (${Math.round(
        (Date.now() - cachedHtmlTime) / 1000
      )}s)`
    );
    return cachedHtml;
  }

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
      cachedHtml = html;
      cachedHtmlTime = Date.now();
      cachedFollowers = extractFollowersFromTikTokHtml(html);
      if (cachedFollowers !== null) {
        console.log(
          `[TikTok Monitor] 👥 Followers détectés: ${cachedFollowers}`
        );
      }
      return html;
    }
  }
  console.error("[TikTok Monitor] ❌ Toutes les sources ont échoué");
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
  if (cachedFollowers !== null) {
    console.log(
      `[TikTok Monitor] ♻️ Followers en cache: ${cachedFollowers}`
    );
    return cachedFollowers;
  }

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
