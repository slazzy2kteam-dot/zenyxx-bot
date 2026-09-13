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
  checkIntervalMs: 3 * 60 * 1000, // 3 minutes (un peu plus long pour éviter les blocages)
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
let cachedHtml = null;
let cachedHtmlTime = 0;
const HTML_CACHE_TTL = 100 * 1000; // 100 secondes
let cachedFollowers = null;

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
// UTILITAIRE — délai aléatoire pour paraître humain
// ======================================================

function randomDelay(minMs, maxMs) {
  const ms = minMs + Math.random() * (maxMs - minMs);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ======================================================
// HEADERS
// ======================================================

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0",
  // Mobile UA — utile pour les endpoints API mobiles
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
];

function buildHeaders(mobile = false) {
  const ua = mobile
    ? USER_AGENTS[4 + Math.floor(Math.random() * 2)]
    : USER_AGENTS[Math.floor(Math.random() * 4)];

  const webid = Math.random().toString(36).slice(2, 14);
  const iid = Math.random().toString(36).slice(2, 14);

  const cookies = [
    `tt_webid_v2=71${webid}`,
    `tt_webid=71${webid}`,
    `msToken=${iid}`,
    `sid=t=xxx${Math.random().toString(36).slice(2, 10)}`,
    `odin_tt=${iid}`,
    `bm_sv=${iid}`,
    `domain_ver=xxx`,
  ].join("; ");

  return {
    "User-Agent": ua,
    Accept: mobile
      ? "application/json, text/plain, */*"
      : "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9,fr;q=0.8",
    "Accept-Encoding": "gzip, deflate, br",
    Referer: "https://www.tiktok.com/",
    Cookie: cookies,
    "Sec-Fetch-Dest": mobile ? "empty" : "document",
    "Sec-Fetch-Mode": mobile ? "cors" : "navigate",
    "Sec-Fetch-Site": mobile ? "same-origin" : "none",
    "Sec-Fetch-User": mobile ? undefined : "?1",
    "Upgrade-Insecure-Requests": mobile ? undefined : "1",
  };
}

// ======================================================
// EXTRACTION — depuis le JSON embarqué dans le HTML
// ======================================================

function deepCollectVideoIds(obj, depth, ids) {
  if (depth > 20 || !obj || typeof obj !== "object") return;

  if (Array.isArray(obj)) {
    for (const item of obj) deepCollectVideoIds(item, depth + 1, ids);
    return;
  }

  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (
      (key === "id" || key === "aweme_id" || key === "awemeId") &&
      typeof val === "string" &&
      /^\d{15,20}$/.test(val)
    ) {
      ids.add(val);
    }
    if (
      (key === "id" || key === "aweme_id" || key === "awemeId") &&
      typeof val === "number" &&
      val > 100000000000000
    ) {
      ids.add(String(val));
    }
    if (val && typeof val === "object") {
      deepCollectVideoIds(val, depth + 1, ids);
    }
  }
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
// EXTRACTION — depuis HTML (pages profil/embed)
// ======================================================

function extractAllVideosFromTikTokHtml(html) {
  const ids = new Set();

  // __UNIVERSAL_DATA_FOR_REHYDRATION__
  const universalMatch = html.match(
    /<script\s+id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>\s*([\s\S]*?)\s*<\/script>/
  );
  if (universalMatch) {
    try {
      const data = JSON.parse(universalMatch[1]);
      deepCollectVideoIds(data, 0, ids);
      console.log(
        `[TikTok Monitor] 📋 __UNIVERSAL_DATA__ → ${ids.size} ID(s)`
      );
    } catch (e) {
      console.log(`[TikTok Monitor] ⚠️ Parse __UNIVERSAL_DATA__ échoué: ${e.message}`);
    }
  }

  // RENDER_DATA
  const renderMatch = html.match(
    /<script\s+id="RENDER_DATA"\s+type="application\/json">([^<]+)<\/script>/
  );
  if (renderMatch) {
    try {
      const decoded = JSON.parse(decodeURIComponent(renderMatch[1]));
      deepCollectVideoIds(decoded, 0, ids);
      console.log(`[TikTok Monitor] 📋 RENDER_DATA → ${ids.size} ID(s)`);
    } catch (e) {
      console.log(`[TikTok Monitor] ⚠️ Parse RENDER_DATA échoué: ${e.message}`);
    }
  }

  // SIGI_STATE
  const sigiMatch = html.match(
    /window\['SIGI_STATE'\]\s*=\s*JSON\.parse\('([\s\S]*?)'\)/
  );
  if (sigiMatch) {
    try {
      const data = JSON.parse(sigiMatch[1]);
      deepCollectVideoIds(data, 0, ids);
      console.log(`[TikTok Monitor] 📋 SIGI_STATE → ${ids.size} ID(s)`);
    } catch (e) {
      console.log(`[TikTok Monitor] ⚠️ Parse SIGI_STATE échoué: ${e.message}`);
    }
  }

  // Regex fallback
  const urlMatches = html.match(/video\/(\d{15,20})/g);
  if (urlMatches) {
    for (const m of urlMatches) {
      const id = m.match(/video\/(\d{15,20})/);
      if (id) ids.add(id[1]);
    }
  }
  const idMatches = html.match(/"id"\s*:\s*"?(\d{15,20})"?/g);
  if (idMatches) {
    for (const m of idMatches) {
      const id = m.match(/"id"\s*:\s*"?(\d{15,20})"?/);
      if (id) ids.add(id[1]);
    }
  }
  const awemeMatches = html.match(/"aweme_id"\s*:\s*"?(\d{15,20})"?/g);
  if (awemeMatches) {
    for (const m of awemeMatches) {
      const id = m.match(/"aweme_id"\s*:\s*"?(\d{15,20})"?/);
      if (id) ids.add(id[1]);
    }
  }

  console.log(`[TikTok Monitor] 📊 Total HTML: ${ids.size} ID(s) vidéo unique(s)`);
  return ids.size > 0 ? ids : null;
}

function extractFollowersFromTikTokHtml(html) {
  const universalMatch = html.match(
    /<script\s+id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>\s*([\s\S]*?)\s*<\/script>/
  );
  if (universalMatch) {
    try {
      const data = JSON.parse(universalMatch[1]);
      const found = deepFindFollowerCount(data, 0);
      if (found !== null) return found;
    } catch (e) {}
  }

  const renderMatch = html.match(
    /<script\s+id="RENDER_DATA"\s+type="application\/json">([^<]+)<\/script>/
  );
  if (renderMatch) {
    try {
      const decoded = JSON.parse(decodeURIComponent(renderMatch[1]));
      const found = deepFindFollowerCount(decoded, 0);
      if (found !== null) return found;
    } catch (e) {}
  }

  const match = html.match(/"followerCount"\s*:\s*(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

// ======================================================
// EXTRACTION — depuis JSON API (endpoints internes TikTok)
// ======================================================

function extractVideosFromApiResponse(data) {
  const ids = new Set();

  // Structure itemList (API interne TikTok)
  if (data.itemList && Array.isArray(data.itemList)) {
    for (const item of data.itemList) {
      if (item.id) ids.add(String(item.id));
      if (item.aweme_id) ids.add(String(item.aweme_id));
    }
    console.log(
      `[TikTok Monitor] 📋 API itemList → ${ids.size} ID(s)`
    );
  }

  // Structure aweme_list
  if (data.aweme_list && Array.isArray(data.aweme_list)) {
    for (const item of data.aweme_list) {
      if (item.aweme_id) ids.add(String(item.aweme_id));
      else if (item.id) ids.add(String(item.id));
    }
    console.log(
      `[TikTok Monitor] 📋 API aweme_list → ${ids.size} ID(s)`
    );
  }

  // Parcours récursif de secours
  deepCollectVideoIds(data, 0, ids);

  return ids.size > 0 ? ids : null;
}

function extractFollowersFromApiResponse(data) {
  // userInfo dans l'API
  if (data.userInfo) {
    if (data.userInfo.stats && typeof data.userInfo.stats.followerCount === "number") {
      return data.userInfo.stats.followerCount;
    }
  }
  // userModule
  if (data.userModule) {
    const fc = deepFindFollowerCount(data.userModule, 0);
    if (fc !== null) return fc;
  }
  // Recherche récursive
  const fc = deepFindFollowerCount(data, 0);
  return fc;
}

// ======================================================
// VALIDATION DE PAGE HTML
// ======================================================

function isValidPage(html) {
  if (!html || html.length < 500) return false;

  const challengeSigns = [
    "Just a moment",
    "cf-challenge",
    "Enable JavaScript",
    "Checking your browser",
    "Please Wait",
    "Attention Required",
    "challenge-platform",
    "cf-browser-verification",
  ];

  const hasChallenge = challengeSigns.some((s) =>
    html.toLowerCase().includes(s.toLowerCase())
  );
  if (hasChallenge && html.length < 80000) return false;

  const hasTikTokContent =
    html.includes("tiktok.com") ||
    html.includes("TikTok") ||
    html.includes("tiktok") ||
    html.includes("__UNIVERSAL_DATA") ||
    html.includes("RENDER_DATA") ||
    html.includes("SIGI_STATE");

  return hasTikTokContent;
}

// ======================================================
// SOURCES — 3 types : API JSON > HTML profil > HTML embed
//
// Les API internes TikTok retournent du JSON propre,
// pas besoin de scraper le HTML. C'est beaucoup plus
// fiable et plus léger. On les essaie en premier.
//
// L'API /api/post/item_list/ retourne la liste des
// vidéos d'un utilisateur.
// L'API /api/user/detail/ retourne le profil
// (avec followerCount).
// ======================================================

const TIKTOK_SOURCES = [
  // ───────────── API JSON (priorité maximale) ─────────────
  // L'API interne de TikTok pour lister les vidéos d'un user
  {
    name: "api-itemlist-direct",
    type: "api",
    buildUrl: (u) =>
      `https://www.tiktok.com/api/post/item_list/?aid=1988&count=30&secUid=&username=${u}&verifyFp=xxx`,
    useProxy: false,
    mobile: true,
  },
  {
    name: "api-itemlist-codetabs",
    type: "api",
    buildUrl: (u) =>
      `https://www.tiktok.com/api/post/item_list/?aid=1988&count=30&secUid=&username=${u}&verifyFp=xxx`,
    useProxy: true,
    mobile: true,
    proxyUrl: (url) =>
      `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
  },
  {
    name: "api-itemlist-allorigins",
    type: "api",
    buildUrl: (u) =>
      `https://www.tiktok.com/api/post/item_list/?aid=1988&count=30&secUid=&username=${u}&verifyFp=xxx`,
    useProxy: true,
    mobile: true,
    proxyUrl: (url) =>
      `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  },
  // API détail utilisateur (followers)
  {
    name: "api-userdetail-direct",
    type: "api-user",
    buildUrl: (u) =>
      `https://www.tiktok.com/api/user/detail/?aid=1988&username=${u}&verifyFp=xxx`,
    useProxy: false,
    mobile: true,
  },
  {
    name: "api-userdetail-codetabs",
    type: "api-user",
    buildUrl: (u) =>
      `https://www.tiktok.com/api/user/detail/?aid=1988&username=${u}&verifyFp=xxx`,
    useProxy: true,
    mobile: true,
    proxyUrl: (url) =>
      `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
  },
  // ───────────── Pages HTML profil ─────────────
  {
    name: "profile-direct",
    type: "html",
    buildUrl: (u) => `https://www.tiktok.com/@${u}`,
    useProxy: false,
    mobile: false,
  },
  {
    name: "profile-codetabs",
    type: "html",
    buildUrl: (u) => `https://www.tiktok.com/@${u}`,
    useProxy: true,
    mobile: false,
    proxyUrl: (url) =>
      `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
  },
  {
    name: "profile-allorigins",
    type: "html",
    buildUrl: (u) => `https://www.tiktok.com/@${u}`,
    useProxy: true,
    mobile: false,
    proxyUrl: (url) =>
      `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  },
  {
    name: "profile-corsproxy",
    type: "html",
    buildUrl: (u) => `https://www.tiktok.com/@${u}`,
    useProxy: true,
    mobile: false,
    proxyUrl: (url) =>
      `https://corsproxy.io/?${encodeURIComponent(url)}`,
  },
  // ───────────── Mobile HTML ─────────────
  {
    name: "mobile-direct",
    type: "html",
    buildUrl: (u) => `https://m.tiktok.com/@${u}`,
    useProxy: false,
    mobile: true,
  },
  {
    name: "mobile-codetabs",
    type: "html",
    buildUrl: (u) => `https://m.tiktok.com/@${u}`,
    useProxy: true,
    mobile: true,
    proxyUrl: (url) =>
      `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
  },
  // ───────────── Embed (dernier recours) ─────────────
  {
    name: "embed-direct",
    type: "html",
    buildUrl: (u) => `https://www.tiktok.com/embed/@${u}`,
    useProxy: false,
    mobile: false,
  },
  {
    name: "embed-codetabs",
    type: "html",
    buildUrl: (u) => `https://www.tiktok.com/embed/@${u}`,
    useProxy: true,
    mobile: false,
    proxyUrl: (url) =>
      `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
  },
  {
    name: "embed-allorigins",
    type: "html",
    buildUrl: (u) => `https://www.tiktok.com/embed/@${u}`,
    useProxy: true,
    mobile: false,
    proxyUrl: (url) =>
      `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  },
];

// ======================================================
// FETCH — générique (HTML ou JSON API)
// ======================================================

async function fetchFromSource(source) {
  const url = source.buildUrl(CONFIG.username);
  const targetUrl = source.useProxy ? source.proxyUrl(url) : url;
  const timeoutMs = source.useProxy ? 30000 : 15000;
  const isApi = source.type === "api" || source.type === "api-user";

  // Petit délai aléatoire entre les sources (500ms-2s)
  await randomDelay(500, 2000);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(targetUrl, {
      headers: buildHeaders(source.mobile),
      signal: controller.signal,
      redirect: "follow",
    });
    clearTimeout(timeout);

    if (!res.ok) {
      console.log(`[TikTok Monitor] ${source.name} — HTTP ${res.status}`);
      return null;
    }

    const text = await res.text();

    if (isApi) {
      // L'API retourne du JSON — on essaie de le parser
      try {
        const json = JSON.parse(text);
        // Vérifier que c'est bien une réponse TikTok valide
        if (json.statusCode === 0 || json.itemList || json.aweme_list || json.userInfo || json.userModule) {
          console.log(`[TikTok Monitor] ✅ ${source.name} — JSON API valide`);
          return { type: source.type, data: json };
        }
        // L'API peut renvoyer une page HTML de blocage au lieu de JSON
        if (isValidPage(text)) {
          console.log(`[TikTok Monitor] ${source.name} — API a renvoyé du HTML au lieu de JSON`);
          return { type: "html", data: text };
        }
        console.log(`[TikTok Monitor] ${source.name} — API réponse inattendue (statusCode: ${json.statusCode || 'N/A'})`);
        return null;
      } catch (e) {
        // Pas du JSON — vérifier si c'est du HTML valide
        if (isValidPage(text)) {
          console.log(`[TikTok Monitor] ${source.name} — Réponse HTML au lieu de JSON (OK, on utilise)`);
          return { type: "html", data: text };
        }
        console.log(`[TikTok Monitor] ${source.name} — Réponse non-JSON, non-HTML`);
        return null;
      }
    } else {
      // Source HTML
      if (isValidPage(text)) {
        console.log(`[TikTok Monitor] ✅ ${source.name} — ${text.length} chars`);
        return { type: "html", data: text };
      }
      console.log(`[TikTok Monitor] ${source.name} — HTML invalide/blocage (${text.length} chars)`);
      return null;
    }
  } catch (e) {
    console.log(`[TikTok Monitor] ${source.name} — erreur: ${e.message}`);
    return null;
  }
}

// ======================================================
// FETCH GLOBAL — essaie toutes les sources
// ======================================================

async function fetchTikTokData() {
  if (fetchInProgress && fetchPromise) {
    console.log(`[TikTok Monitor] ⏳ Requête déjà en cours — on attend`);
    return fetchPromise;
  }

  if (cachedHtml && Date.now() - cachedHtmlTime < HTML_CACHE_TTL) {
    console.log(
      `[TikTok Monitor] ♻️ Cache (${Math.round((Date.now() - cachedHtmlTime) / 1000)}s)`
    );
    return { videoIds: null, followers: cachedFollowers, fromCache: true };
  }

  fetchInProgress = true;
  fetchPromise = _doFetchTikTokData();

  try {
    const result = await fetchPromise;
    return result;
  } finally {
    fetchInProgress = false;
    fetchPromise = null;
  }
}

async function _doFetchTikTokData() {
  let allVideoIds = new Set();
  let followers = null;
  let gotHtml = false;

  for (const source of TIKTOK_SOURCES) {
    console.log(`[TikTok Monitor] 🔄 Source: ${source.name}`);
    const result = await fetchFromSource(source);

    if (!result) continue;

    if (result.type === "api" || result.type === "api-user") {
      const apiData = result.data;

      // Extraire les vidéos de l'API
      if (result.type === "api") {
        const vids = extractVideosFromApiResponse(apiData);
        if (vids) {
          for (const id of vids) allVideoIds.add(id);
          console.log(
            `[TikTok Monitor] 🎬 ${vids.size} vidéo(s) depuis API (total: ${allVideoIds.size})`
          );
        }
      }

      // Extraire les followers de l'API
      const fc = extractFollowersFromApiResponse(apiData);
      if (fc !== null) {
        followers = fc;
        console.log(`[TikTok Monitor] 👥 Followers API: ${followers}`);
      }

      // Si on a des vidéos ET des followers, on est bon
      if (allVideoIds.size > 0 && followers !== null) {
        console.log(
          `[TikTok Monitor] ✅ API complète — ${allVideoIds.size} vidéos, ${followers} followers`
        );
        cachedFollowers = followers;
        cachedHtmlTime = Date.now();
        return { videoIds: allVideoIds, followers };
      }
    }

    if (result.type === "html") {
      gotHtml = true;
      const html = result.data;

      // Extraire vidéos du HTML
      const vids = extractAllVideosFromTikTokHtml(html);
      if (vids) {
        for (const id of vids) allVideoIds.add(id);
      }

      // Extraire followers du HTML
      const fc = extractFollowersFromTikTokHtml(html);
      if (fc !== null) {
        followers = fc;
        console.log(`[TikTok Monitor] 👥 Followers HTML: ${followers}`);
      }

      // Mettre en cache le HTML
      cachedHtml = html;
      cachedHtmlTime = Date.now();
      cachedFollowers = followers;

      if (allVideoIds.size > 0) {
        console.log(
          `[TikTok Monitor] ✅ HTML — ${allVideoIds.size} vidéos, ${followers || '?'} followers`
        );
        return { videoIds: allVideoIds, followers };
      }
    }
  }

  // Retourner ce qu'on a, même partiel
  if (allVideoIds.size > 0 || followers !== null) {
    cachedFollowers = followers;
    cachedHtmlTime = Date.now();
    return { videoIds: allVideoIds.size > 0 ? allVideoIds : null, followers };
  }

  console.error("[TikTok Monitor] ❌ Toutes les sources ont échoué");
  return null;
}

// ======================================================
// VÉRIFICATION VIDÉO + FOLLOWERS
// ======================================================

async function checkLatestVideos() {
  const result = await fetchTikTokData();
  if (!result || !result.videoIds) return null;
  console.log(`[TikTok Monitor] ✅ ${result.videoIds.size} vidéo(s) trouvée(s)`);
  return result.videoIds;
}

async function checkFollowers() {
  if (cachedFollowers !== null) {
    console.log(`[TikTok Monitor] ♻️ Followers en cache: ${cachedFollowers}`);
    return cachedFollowers;
  }
  const result = await fetchTikTokData();
  return result ? result.followers : null;
}

// ======================================================
// NOTIFICATION DISCORD
// ======================================================

async function sendVideoNotification(guild, videoId) {
  const videoUrl = `https://www.tiktok.com/@${CONFIG.username}/video/${videoId}`;

  if (CONFIG.webhookUrl) {
    try {
      const embed = {
        title: "\U0001F3AC Nouvelle vidéo TikTok !",
        url: videoUrl,
        color: 0x00f2ea,
        description: `**@${CONFIG.username}** vient de poster une nouvelle vidéo !\nVa la regarder \U0001F525`,
        timestamp: new Date().toISOString(),
      };

      await fetch(CONFIG.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: "\u{1D292}\u{1D294}\u{1D271}\u{1D26F}\u{1D31E}\u{1D2FF} Tiktok",
          avatar_url: "<<url_7:png>>",
          content: `@everyone **Nouvelle vidéo TikTok !** @${CONFIG.username} vient de poster !\n${videoUrl}`,
          embeds: [embed],
        }),
      });
      console.log(
        `[TikTok Monitor] \U0001F4E2 Notification webhook envoyée ! Vidéo: ${videoId}`
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
    .setTitle("\U0001F3AC Nouvelle vidéo TikTok !")
    .setURL(videoUrl)
    .setColor(0x00f2ea)
    .setDescription(
      `**@${CONFIG.username}** vient de poster une nouvelle vidéo !\n` +
        `Va la regarder \U0001F525`
    )
    .setTimestamp();

  try {
    await channel.send({
      content: `@everyone **Nouvelle vidéo TikTok !** @${CONFIG.username} vient de poster !\n${videoUrl}`,
      embeds: [embed],
    });
    console.log(
      `[TikTok Monitor] \U0001F4E2 Notification bot envoyée ! Vidéo: ${videoId}`
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
            `[TikTok Monitor] \U0001F3AC Nouvelle vidéo détectée ! ID: ${id}`
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
        `[TikTok Monitor] \u274C Échec (${consecutiveFailures}/${CONFIG.maxFailures})`
      );

      if (consecutiveFailures >= CONFIG.maxFailures) {
        const guild = client.guilds.cache.values().next().value;
        if (guild) {
          const channel = guild.channels.cache.get(CONFIG.channelId);
          if (channel) {
            await channel
              .send(
                "\u26A0\uFE0F Le moniteur TikTok n'arrive pas à récupérer les données depuis un moment. Tous les proxies ont échoué."
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
