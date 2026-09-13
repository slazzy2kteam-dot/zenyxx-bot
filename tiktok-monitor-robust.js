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
// STRATÉGIE V4 — Contourner Cloudflare
//
// Au lieu de scraper directement tiktok.com (bloqué
// par Cloudflare sur les IP de datacenter), on utilise
// des services tiers gratuits qui ont deja resolu
// le probleme Cloudflare :
//
// 1. RSSHub public — genere un flux RSS/JSON pour
//    n'importe quel compte TikTok. Plusieurs instances
//    publiques gratuites existent.
//
// 2. Urlebird — site tiers qui affiche les profils
//    TikTok dans un format plus simple (moins de
//    protection Cloudflare).
//
// 3. TikTok embed — la page /embed/@user est la
//    moins protegee par Cloudflare (elle est faite
//    pour etre chargee dans des iframes externes).
//    RSSHub lui-meme utilise cette page.
//
// 4. Vidnoz / autres viewers TikTok
//
// On essaie dans cet ordre, le premier qui marche
// suffit. Plus besoin de proxy!
// ======================================================

// ======================================================
// SOURCE 1 : RSSHub (instances publiques gratuites)
// RSSHub expose une route /tiktok/user/@username
// qui retourne du JSON ou du RSS avec les videos.
// ======================================================

const RSSHUB_INSTANCES = [
  "https://rsshub.app",
  "https://hub.slarker.me",
  "https://rsshub.rssforever.com",
  "https://rss.shab.fun",
];

async function fetchFromRSSHub() {
  for (const instance of RSSHUB_INSTANCES) {
    const jsonUrl = `${instance}/api/tiktok/user/@${CONFIG.username}`;
    const rssUrl = `${instance}/tiktok/user/@${CONFIG.username}`;

    // Essayer d'abord le JSON (API RSSHub)
    try {
      console.log(`[TikTok Monitor] Essai RSSHub JSON: ${instance}`);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      const res = await fetch(jsonUrl, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
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
            // Extraire l'ID video depuis le lien
            const urlMatch = (item.url || item.link || "").match(
              /video\/(\d{15,20})/
            );
            if (urlMatch) ids.add(urlMatch[1]);

            // Ou depuis l'ID RSSHub
            if (item.id) {
              const idMatch = String(item.id).match(/video\/(\d{15,20})/);
              if (idMatch) ids.add(idMatch[1]);
            }
          }

          if (ids.size > 0) {
            console.log(
              `[TikTok Monitor] RSSHub JSON (${instance}) OK — ${ids.size} video(s)`
            );

            // Essayer de recuperer les followers depuis la description du feed
            let followers = null;
            if (data.description) {
              const fMatch = data.description.match(/(\d[\d,.]*\d*)\s*followers/i);
              if (fMatch) {
                followers = parseInt(fMatch[1].replace(/[,.]/g, ""), 10);
              }
            }

            return { videoIds: ids, followers, source: `rsshub-json-${instance}` };
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

    // Essayer le RSS (XML) si le JSON ne marche pas
    try {
      console.log(`[TikTok Monitor] Essai RSSHub RSS: ${instance}`);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      const res = await fetch(rssUrl, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (compatible; TikTokMonitor/4.0; +https://github.com)",
          Accept: "application/rss+xml, application/xml, text/xml",
        },
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (res.ok) {
        const xml = await res.text();
        const ids = new Set();

        // Parser les IDs depuis le XML du RSS
        const linkMatches = xml.match(/<link>[^<]*video\/(\d{15,20})[^<]*<\/link>/g);
        if (linkMatches) {
          for (const m of linkMatches) {
            const id = m.match(/video\/(\d{15,20})/);
            if (id) ids.add(id[1]);
          }
        }

        // Au cas ou les IDs sont dans d'autres balises
        const guidMatches = xml.match(
          /<guid[^>]*>[^<]*video\/(\d{15,20})[^<]*<\/guid>/g
        );
        if (guidMatches) {
          for (const m of guidMatches) {
            const id = m.match(/video\/(\d{15,20})/);
            if (id) ids.add(id[1]);
          }
        }

        // Regex generique pour les URLs de video dans le XML
        const allVideoUrls = xml.match(/video\/(\d{15,20})/g);
        if (allVideoUrls) {
          for (const m of allVideoUrls) {
            const id = m.match(/video\/(\d{15,20})/);
            if (id) ids.add(id[1]);
          }
        }

        if (ids.size > 0) {
          console.log(
            `[TikTok Monitor] RSSHub RSS (${instance}) OK — ${ids.size} video(s)`
          );
          return { videoIds: ids, followers: null, source: `rsshub-rss-${instance}` };
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
  }

  return null;
}

// ======================================================
// SOURCE 2 : Urlebird (site viewer TikTok tiers)
// Urlebird affiche les profils et videos TikTok
// sans la protection Cloudflare de tiktok.com.
// ======================================================

async function fetchFromUrlebird() {
  const profileUrl = `https://urlebird.com/user/${CONFIG.username}/`;

  try {
    console.log(`[TikTok Monitor] Essai Urlebird`);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(profileUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
        Accept: "text/html",
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      console.log(`[TikTok Monitor] Urlebird — HTTP ${res.status}`);
      return null;
    }

    const html = await res.text();
    if (!html || html.length < 500) {
      console.log(`[TikTok Monitor] Urlebird — page vide`);
      return null;
    }

    const ids = new Set();

    // Urlebird utilise des URLs du type /user/username/video/7XXXXXXXXXXXXXXXXX
    const videoUrlMatches = html.match(/video\/(\d{15,20})/g);
    if (videoUrlMatches) {
      for (const m of videoUrlMatches) {
        const id = m.match(/video\/(\d{15,20})/);
        if (id) ids.add(id[1]);
      }
    }

    // Extraire les followers depuis Urlebird
    let followers = null;
    const followerMatch = html.match(
      /(\d[\d,.]*\d*)\s*(?:followers|abonnes|subscribers)/i
    );
    if (followerMatch) {
      followers = parseInt(followerMatch[1].replace(/[,.]/g, ""), 10);
    }

    // Chercher dans les attributs data-* aussi
    const dataIds = html.match(/data-id="(\d{15,20})"/g);
    if (dataIds) {
      for (const m of dataIds) {
        const id = m.match(/data-id="(\d{15,20})"/);
        if (id) ids.add(id[1]);
      }
    }

    if (ids.size > 0) {
      console.log(
        `[TikTok Monitor] Urlebird OK — ${ids.size} video(s), ${followers || "?"} followers`
      );
      return { videoIds: ids, followers, source: "urlebird" };
    }

    // Si on n'a pas trouve de videos mais des followers, c'est utile quand meme
    if (followers !== null) {
      console.log(
        `[TikTok Monitor] Urlebird — ${followers} followers (pas de videos trouvees)`
      );
      return { videoIds: null, followers, source: "urlebird" };
    }

    console.log(`[TikTok Monitor] Urlebird — rien trouvé`);
    return null;
  } catch (e) {
    console.log(`[TikTok Monitor] Urlebird — erreur: ${e.message}`);
    return null;
  }
}

// ======================================================
// SOURCE 3 : TikTok Embed (page /embed/@user)
// Cette page est la moins protegee par Cloudflare car
// elle est faite pour etre chargee dans des iframes
// externes (blogs, sites, etc.).
// On utilise un proxy CORS gratuit si l'acces direct
// echoue.
// ======================================================

async function fetchFromEmbed() {
  const embedUrl = `https://www.tiktok.com/embed/@${CONFIG.username}`;

  // Essai direct d'abord
  try {
    console.log(`[TikTok Monitor] Essai TikTok Embed (direct)`);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(embedUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
        Accept: "text/html",
        Referer: "https://www.tiktok.com/",
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (res.ok) {
      const html = await res.text();
      const result = parseEmbedHtml(html);
      if (result) {
        result.source = "embed-direct";
        return result;
      }
    } else {
      console.log(
        `[TikTok Monitor] Embed direct — HTTP ${res.status}`
      );
    }
  } catch (e) {
    console.log(`[TikTok Monitor] Embed direct — erreur: ${e.message}`);
  }

  // Essai via proxy
  const proxies = [
    (url) =>
      `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
    (url) =>
      `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
    (url) => `https://corsproxy.io/?${encodeURIComponent(url)}`,
  ];

  for (const makeProxy of proxies) {
    try {
      const proxyName = makeProxy.toString().match(/\/\/([^.]+)/)?.[1] || "proxy";
      console.log(`[TikTok Monitor] Essai Embed via ${proxyName}`);
      const proxyUrl = makeProxy(embedUrl);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20000);
      const res = await fetch(proxyUrl, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
        },
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (res.ok) {
        const html = await res.text();
        const result = parseEmbedHtml(html);
        if (result) {
          result.source = `embed-${proxyName}`;
          return result;
        }
      } else {
        console.log(
          `[TikTok Monitor] Embed ${proxyName} — HTTP ${res.status}`
        );
      }
    } catch (e) {
      console.log(`[TikTok Monitor] Embed proxy — erreur: ${e.message}`);
    }
  }

  return null;
}

function parseEmbedHtml(html) {
  if (!html || html.length < 500) return null;

  // Verifier que c'est pas une page de blocage Cloudflare
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

  const ids = new Set();

  // __FRONTITY_CONNECT_STATE__ — utilise par RSSHub
  const frontityMatch = html.match(
    /<script\s+id="__FRONTITY_CONNECT_STATE__"[^>]*>([\s\S]*?)<\/script>/
  );
  if (frontityMatch) {
    try {
      const state = JSON.parse(frontityMatch[1]);
      deepCollectVideoIds(state, 0, ids);
    } catch (e) {}
  }

  // __UNIVERSAL_DATA_FOR_REHYDRATION__
  const universalMatch = html.match(
    /<script\s+id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>\s*([\s\S]*?)\s*<\/script>/
  );
  if (universalMatch) {
    try {
      const data = JSON.parse(universalMatch[1]);
      deepCollectVideoIds(data, 0, ids);
    } catch (e) {}
  }

  // RENDER_DATA
  const renderMatch = html.match(
    /<script\s+id="RENDER_DATA"\s+type="application\/json">([^<]+)<\/script>/
  );
  if (renderMatch) {
    try {
      const decoded = JSON.parse(decodeURIComponent(renderMatch[1]));
      deepCollectVideoIds(decoded, 0, ids);
    } catch (e) {}
  }

  // Regex fallback
  const urlMatches = html.match(/video\/(\d{15,20})/g);
  if (urlMatches) {
    for (const m of urlMatches) {
      const id = m.match(/video\/(\d{15,20})/);
      if (id) ids.add(id[1]);
    }
  }

  // Extraire les followers
  let followers = null;
  const followerMatch = html.match(/"followerCount"\s*:\s*(\d+)/);
  if (followerMatch) {
    followers = parseInt(followerMatch[1], 10);
  }
  if (followers === null) {
    followers = deepFindFollowerCount(
      universalMatch ? JSON.parse(universalMatch[1]) : {},
      0
    );
  }

  if (ids.size > 0 || followers !== null) {
    console.log(
      `[TikTok Monitor] Embed HTML — ${ids.size} video(s), ${followers || "?"} followers`
    );
    return { videoIds: ids.size > 0 ? ids : null, followers };
  }

  return null;
}

// ======================================================
// EXTRACTION RECURSIVE PROFONDE
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
// SOURCE 4 : TikTok Profile page via proxy
// (dernier recours — meme strategie que V3 mais en
//  dernier seulement)
// ======================================================

async function fetchFromProfileViaProxy() {
  const profileUrl = `https://www.tiktok.com/@${CONFIG.username}`;

  const proxies = [
    (url) =>
      `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
    (url) =>
      `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
    (url) => `https://corsproxy.io/?${encodeURIComponent(url)}`,
  ];

  for (const makeProxy of proxies) {
    try {
      const proxyName = makeProxy.toString().match(/\/\/([^.]+)/)?.[1] || "proxy";
      console.log(`[TikTok Monitor] Essai Profile via ${proxyName}`);
      const proxyUrl = makeProxy(profileUrl);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20000);
      const res = await fetch(proxyUrl, {
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
        if (html.length > 5000 && !html.includes("Just a moment")) {
          const ids = new Set();

          // Parser les donnees JSON embarquees
          const universalMatch = html.match(
            /<script\s+id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>\s*([\s\S]*?)\s*<\/script>/
          );
          if (universalMatch) {
            try {
              const data = JSON.parse(universalMatch[1]);
              deepCollectVideoIds(data, 0, ids);
            } catch (e) {}
          }

          const renderMatch = html.match(
            /<script\s+id="RENDER_DATA"\s+type="application\/json">([^<]+)<\/script>/
          );
          if (renderMatch) {
            try {
              const decoded = JSON.parse(decodeURIComponent(renderMatch[1]));
              deepCollectVideoIds(decoded, 0, ids);
            } catch (e) {}
          }

          // Regex fallback
          const urlMatches = html.match(/video\/(\d{15,20})/g);
          if (urlMatches) {
            for (const m of urlMatches) {
              const id = m.match(/video\/(\d{15,20})/);
              if (id) ids.add(id[1]);
            }
          }

          let followers = null;
          const followerMatch = html.match(/"followerCount"\s*:\s*(\d+)/);
          if (followerMatch) {
            followers = parseInt(followerMatch[1], 10);
          }

          if (ids.size > 0 || followers !== null) {
            console.log(
              `[TikTok Monitor] Profile ${proxyName} OK — ${ids.size} video(s), ${followers || "?"} followers`
            );
            return {
              videoIds: ids.size > 0 ? ids : null,
              followers,
              source: `profile-${proxyName}`,
            };
          }
        }
      } else {
        console.log(
          `[TikTok Monitor] Profile ${proxyName} — HTTP ${res.status}`
        );
      }
    } catch (e) {
      console.log(
        `[TikTok Monitor] Profile proxy — erreur: ${e.message}`
      );
    }
  }

  return null;
}

// ======================================================
// FETCH GLOBAL — essaie toutes les sources dans l'ordre
// ======================================================

async function fetchTikTokData() {
  if (fetchInProgress && fetchPromise) {
    console.log(`[TikTok Monitor] Requete deja en cours`);
    return fetchPromise;
  }

  fetchInProgress = true;
  fetchPromise = _doFetchTikTokData();

  try {
    return await fetchPromise;
  } finally {
    fetchInProgress = false;
    fetchPromise = null;
  }
}

async function _doFetchTikTokData() {
  let allVideoIds = new Set();
  let followers = null;

  // ───── SOURCE 1 : RSSHub (meilleure chance) ─────
  const rsshubResult = await fetchFromRSSHub();
  if (rsshubResult) {
    if (rsshubResult.videoIds) {
      for (const id of rsshubResult.videoIds) allVideoIds.add(id);
    }
    if (rsshubResult.followers !== null) followers = rsshubResult.followers;

    // Si RSSHub nous donne des videos, on est bon
    if (allVideoIds.size > 0) {
      console.log(
        `[TikTok Monitor] RSSHub OK — ${allVideoIds.size} video(s) [${rsshubResult.source}]`
      );
      // On essaie quand meme Urlebird pour les followers si RSSHub ne les a pas
      if (followers === null) {
        const urlResult = await fetchFromUrlebird();
        if (urlResult && urlResult.followers !== null) {
          followers = urlResult.followers;
        }
      }
      cachedFollowers = followers;
      followersTimestamp = Date.now();
      return { videoIds: allVideoIds, followers };
    }
  }

  // ───── SOURCE 2 : Urlebird ─────
  const urlebirdResult = await fetchFromUrlebird();
  if (urlebirdResult) {
    if (urlebirdResult.videoIds) {
      for (const id of urlebirdResult.videoIds) allVideoIds.add(id);
    }
    if (urlebirdResult.followers !== null) followers = urlebirdResult.followers;

    if (allVideoIds.size > 0) {
      console.log(
        `[TikTok Monitor] Urlebird OK — ${allVideoIds.size} video(s)`
      );
      cachedFollowers = followers;
      followersTimestamp = Date.now();
      return { videoIds: allVideoIds, followers };
    }
  }

  // ───── SOURCE 3 : TikTok Embed ─────
  const embedResult = await fetchFromEmbed();
  if (embedResult) {
    if (embedResult.videoIds) {
      for (const id of embedResult.videoIds) allVideoIds.add(id);
    }
    if (embedResult.followers !== null && followers === null) {
      followers = embedResult.followers;
    }

    if (allVideoIds.size > 0) {
      console.log(
        `[TikTok Monitor] Embed OK — ${allVideoIds.size} video(s) [${embedResult.source}]`
      );
      cachedFollowers = followers;
      followersTimestamp = Date.now();
      return { videoIds: allVideoIds, followers };
    }
  }

  // ───── SOURCE 4 : TikTok Profile via proxy (dernier recours) ─────
  const profileResult = await fetchFromProfileViaProxy();
  if (profileResult) {
    if (profileResult.videoIds) {
      for (const id of profileResult.videoIds) allVideoIds.add(id);
    }
    if (profileResult.followers !== null && followers === null) {
      followers = profileResult.followers;
    }

    if (allVideoIds.size > 0) {
      console.log(
        `[TikTok Monitor] Profile proxy OK — ${allVideoIds.size} video(s)`
      );
      cachedFollowers = followers;
      followersTimestamp = Date.now();
      return { videoIds: allVideoIds, followers };
    }
  }

  // Retourner ce qu'on a meme partiel
  if (allVideoIds.size > 0 || followers !== null) {
    cachedFollowers = followers;
    followersTimestamp = Date.now();
    return { videoIds: allVideoIds.size > 0 ? allVideoIds : null, followers };
  }

  console.error("[TikTok Monitor] Toutes les sources ont echoue");
  return null;
}

// ======================================================
// VÉRIFICATION VIDÉO + FOLLOWERS
// ======================================================

async function checkLatestVideos() {
  const result = await fetchTikTokData();
  if (!result || !result.videoIds) return null;
  console.log(
    `[TikTok Monitor] ${result.videoIds.size} video(s) trouvee(s)`
  );
  return result.videoIds;
}

async function checkFollowers() {
  if (
    cachedFollowers !== null &&
    Date.now() - followersTimestamp < FOLLOWERS_TTL
  ) {
    console.log(
      `[TikTok Monitor] Followers en cache: ${cachedFollowers}`
    );
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
        title: "Nouvelle video TikTok !",
        url: videoUrl,
        color: 0x00f2ea,
        description: `**@${CONFIG.username}** vient de poster une nouvelle video !\nVa la regarder`,
        timestamp: new Date().toISOString(),
      };

      await fetch(CONFIG.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: "TikTok Monitor",
          content: `@everyone **Nouvelle video TikTok !** @${CONFIG.username} vient de poster !\n${videoUrl}`,
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
    .setTitle("Nouvelle video TikTok !")
    .setURL(videoUrl)
    .setColor(0x00f2ea)
    .setDescription(
      `**@${CONFIG.username}** vient de poster une nouvelle video !\n` +
        `Va la regarder`
    )
    .setTimestamp();

  try {
    await channel.send({
      content: `@everyone **Nouvelle video TikTok !** @${CONFIG.username} vient de poster !\n${videoUrl}`,
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
        console.log("[TikTok Monitor] Pas de nouvelle video");
      } else if (knownVideoIds.size === 0) {
        // Premier lancement : on enregistre tout sans notifier
        for (const id of newIds) {
          knownVideoIds.add(id);
        }
        saveKnownIds();
        console.log(
          `[TikTok Monitor] Premier lancement — ${newIds.length} IDs initiaux enregistres (pas de notification)`
        );
      } else {
        // Vraies nouvelles videos
        for (const id of newIds) {
          console.log(
            `[TikTok Monitor] Nouvelle video detectee ! ID: ${id}`
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
        `[TikTok Monitor] Echec (${consecutiveFailures}/${CONFIG.maxFailures})`
      );

      if (consecutiveFailures >= CONFIG.maxFailures) {
        const guild = client.guilds.cache.values().next().value;
        if (guild) {
          const channel = guild.channels.cache.get(CONFIG.channelId);
          if (channel) {
            await channel
              .send(
                "Le moniteur TikTok n'arrive pas a recuperer les donnees depuis un moment. Toutes les sources ont echoue."
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
    `[TikTok Monitor] Demarre — verification toutes les ${
      CONFIG.checkIntervalMs / 1000
    }s`
  );
}

module.exports = { startTikTokMonitor, checkFollowers };
