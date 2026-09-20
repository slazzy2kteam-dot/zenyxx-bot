// ============================================================
// tiktok-monitor-robust.js
//
// Module compatible avec index.js :
//   const { startTikTokMonitor, checkFollowers } = require("./tiktok-monitor-robust");
//
//   startTikTokMonitor(client)   -> demarre la boucle de surveillance
//                                   (notifie les nouveaux TikTok dans CHANNEL_ID)
//   checkFollowers()             -> Promise<number|null> nombre d'abonnes actuel
//
// Sources (dans l'ordre) :
//   1. Cloudflare Worker (PRINCIPAL) — abonnes + likes + videos
//   2. Microlink API (fallback)      — abonnes + likes
//   3. hub.slarker.me (fallback)     — videos
//
// Variables d'environnement utilisees :
//   WORKER_URL      — URL du Cloudflare Worker
//   DISCORD_WEBHOOK — URL du webhook Discord (optionnel)
//   TIKTOK_USER     — Nom TikTok sans @ (defaut: aetherofficiel)
//   CHECK_INTERVAL  — Intervalle en ms (defaut: 300000 = 5 min)
//   CHANNEL_ID      — ID du channel Discord pour les notifs de nouvelles videos
// ============================================================

const { EmbedBuilder } = require('discord.js');

// === CONFIG ===
var TIKTOK_USER = process.env.TIKTOK_USER || 'aetherofficiel';
var DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK || '';
var CHECK_INTERVAL = parseInt(process.env.CHECK_INTERVAL) || 300000;
var CHANNEL_ID = process.env.CHANNEL_ID || '1548231185015120054';
var WORKER_URL = process.env.WORKER_URL || '';

var VERSION = 'v7-module';
var MAX_STORED_IDS = 50;

// === STATE ===
var knownVideoIds = new Set();
var discordClient = null; // injecte via startTikTokMonitor(client)

// ============================================================
// UTILITAIRES HTTP
// ============================================================
function sleep(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
}

function fetchWithTimeout(url, options, timeoutMs) {
  if (!timeoutMs) timeoutMs = 25000;
  var controller = new AbortController();
  var timer = setTimeout(function () { controller.abort(); }, timeoutMs);
  return fetch(url, Object.assign({}, options, { signal: controller.signal }))
    .then(function (resp) {
      clearTimeout(timer);
      return resp;
    })
    .catch(function (e) {
      clearTimeout(timer);
      throw e;
    });
}

function fetchWithRetry(url, options, retries, delay) {
  if (!retries) retries = 2;
  if (!delay) delay = 2000;

  function attempt(remaining) {
    return fetchWithTimeout(url, options).then(function (resp) {
      if (resp.ok) return resp;
      if (remaining > 0 && resp.status >= 500) {
        return sleep(delay * (retries - remaining + 1)).then(function () {
          return attempt(remaining - 1);
        });
      }
      return resp;
    }).catch(function (e) {
      if (remaining > 0) {
        console.log('[TikTok Retry ' + (retries - remaining + 1) + '/' + retries + '] ' + e.message);
        return sleep(delay * (retries - remaining + 1)).then(function () {
          return attempt(remaining - 1);
        });
      }
      throw e;
    });
  }

  return attempt(retries);
}

// ============================================================
// SOURCE 1 : CLOUDFLARE WORKER (PRINCIPAL)
// ============================================================
function fetchFromWorker() {
  if (!WORKER_URL) return Promise.resolve(null);

  var url = WORKER_URL + '/profile?user=@' + TIKTOK_USER;
  console.log('[Worker] Tentative : ' + url);

  return fetchWithRetry(url, { timeout: 25000 }, 2, 2000)
    .then(function (resp) {
      if (!resp.ok) {
        console.log('[Worker] HTTP ' + resp.status);
        return null;
      }
      return resp.json();
    })
    .then(function (data) {
      if (!data || data.error) {
        console.log('[Worker] Erreur : ' + (data ? data.error : 'pas de donnees'));
        return null;
      }
      console.log(
        '[Worker] OK — @' + (data.uniqueId || TIKTOK_USER) + ' — ' +
        data.followers + ' abonnes, ' + data.likes + ' likes — ' +
        (data.videos ? data.videos.length : 0) + ' videos'
      );
      return {
        followers: data.followers,
        likes: data.likes,
        following: data.following,
        nickname: data.nickname,
        signature: data.signature,
        videos: data.videos || [],
        source: 'Cloudflare Worker',
      };
    })
    .catch(function (e) {
      console.log('[Worker] Echec : ' + e.message);
      return null;
    });
}

// ============================================================
// SOURCE 2 : MICROLINK API (fallback abonnes)
// ============================================================
function parseCount(str) {
  if (!str) return null;
  var cleaned = str.replace(/,/g, '').replace(/\./g, '');
  var num = parseInt(cleaned);
  return isNaN(num) ? null : num;
}

function fetchFromMicrolink() {
  var profileUrl = 'https://www.tiktok.com/@' + TIKTOK_USER;
  var embedUrl = 'https://www.tiktok.com/embed/@' + TIKTOK_USER;

  function tryMicrolinkProfile() {
    var url = 'https://api.microlink.io/?url=' + encodeURIComponent(profileUrl) + '&video=false';
    console.log('[Microlink] Tentative profil...');

    return fetchWithTimeout(url, {}, 20000)
      .then(function (resp) { return resp.json(); })
      .then(function (data) {
        if (data.status === 'success') {
          var desc = (data.data && data.data.description) || '';
          var fMatch = desc.match(/([\d,.]+)\s*[Aa]bonnes/);
          var fMatchEn = desc.match(/([\d,.]+)\s*[Ff]ollowers/);
          var lMatch = desc.match(/([\d,.]+)\s*[Ll]ikes/);

          var followers = parseCount(fMatch ? fMatch[1] : (fMatchEn ? fMatchEn[1] : null));
          var likes = parseCount(lMatch ? lMatch[1] : null);

          if (followers !== null) {
            console.log('[Microlink] Profil OK — ' + followers + ' abonnes, ' + (likes || '?') + ' likes');
            return { followers: followers, likes: likes, videos: [], source: 'Microlink' };
          }
        }
        return null;
      })
      .catch(function (e) {
        console.log('[Microlink] Profil echoue : ' + e.message);
        return null;
      });
  }

  function tryMicrolinkEmbed() {
    var url = 'https://api.microlink.io/?url=' + encodeURIComponent(embedUrl) + '&video=false';
    console.log('[Microlink] Tentative embed...');

    return fetchWithTimeout(url, {}, 20000)
      .then(function (resp) { return resp.json(); })
      .then(function (data) {
        if (data.status === 'success') {
          var desc = (data.data && data.data.description) || '';
          var fMatch = desc.match(/([\d,.]+)\s*[Ff]ollowers/);
          var fMatchFr = desc.match(/([\d,.]+)\s*[Aa]bonnes/);
          var lMatch = desc.match(/([\d,.]+)\s*[Ll]ikes/);

          var followers = parseCount(fMatch ? fMatch[1] : (fMatchFr ? fMatchFr[1] : null));
          var likes = parseCount(lMatch ? lMatch[1] : null);

          if (followers !== null) {
            console.log('[Microlink] Embed OK — ' + followers + ' abonnes, ' + (likes || '?') + ' likes');
            return { followers: followers, likes: likes, videos: [], source: 'Microlink (embed)' };
          }
        }
        return null;
      })
      .catch(function (e) {
        console.log('[Microlink] Embed echoue : ' + e.message);
        return null;
      });
  }

  return tryMicrolinkProfile().then(function (result) {
    if (result) return result;
    return tryMicrolinkEmbed();
  });
}

// ============================================================
// SOURCE 3 : HUB.SLARKER.ME (fallback videos)
// ============================================================
function fetchFromSlarker() {
  var jsonUrl = 'https://hub.slarker.me/tiktok/user/@' + TIKTOK_USER + '?format=json';

  function tryJsonFeed() {
    console.log('[Slarker] Tentative JSON Feed...');
    return fetchWithRetry(jsonUrl, { timeout: 25000 }, 2, 3000)
      .then(function (resp) {
        if (!resp.ok) return null;
        return resp.json();
      })
      .then(function (data) {
        if (!data) return null;
        var items = data.items || data;
        if (!Array.isArray(items) || items.length === 0) return null;

        var videos = items.map(function (item) {
          var videoId =
            item.id ||
            (item.url ? item.url.split('/').pop() : '') ||
            (item.webpage_url ? item.webpage_url.split('/').pop() : '');
          var desc = item.title || item.content_text || item.summary || '';
          return { id: videoId, desc: desc };
        }).filter(function (v) { return v.id; });

        console.log('[Slarker] JSON Feed OK — ' + videos.length + ' videos');
        return { followers: null, likes: null, videos: videos, source: 'hub.slarker.me' };
      })
      .catch(function (e) {
        console.log('[Slarker] JSON echoue : ' + e.message);
        return null;
      });
  }

  function tryRssXml() {
    var rssUrl = 'https://hub.slarker.me/tiktok/user/@' + TIKTOK_USER;
    console.log('[Slarker] Tentative RSS XML...');
    return fetchWithRetry(rssUrl, { timeout: 25000 }, 1, 2000)
      .then(function (resp) {
        if (!resp.ok) return null;
        return resp.text();
      })
      .then(function (xml) {
        if (!xml) return null;
        var videoIds = xml.match(/video\/(\d+)/g);
        if (!videoIds || videoIds.length === 0) return null;

        var videos = videoIds.map(function (m) {
          var id = m.replace('video/', '');
          return { id: id, desc: '' };
        });

        var seen = {};
        videos = videos.filter(function (v) {
          if (seen[v.id]) return false;
          seen[v.id] = true;
          return true;
        });

        console.log('[Slarker] RSS XML OK — ' + videos.length + ' videos');
        return { followers: null, likes: null, videos: videos, source: 'hub.slarker.me (RSS)' };
      })
      .catch(function (e) {
        console.log('[Slarker] RSS echoue : ' + e.message);
        return null;
      });
  }

  return tryJsonFeed().then(function (result) {
    if (result && result.videos.length > 0) return result;
    return tryRssXml();
  });
}

// ============================================================
// ORCHESTRATEUR
// ============================================================
function fetchAllData() {
  var results = { followers: null, likes: null, videos: [], source: 'aucune' };

  return fetchFromWorker().then(function (worker) {
    if (worker) {
      results.followers = worker.followers;
      results.likes = worker.likes;
      results.videos = worker.videos || [];
      results.source = worker.source;
    }

    if (results.followers === null) {
      return fetchFromMicrolink().then(function (micro) {
        if (micro) {
          results.followers = micro.followers;
          results.likes = micro.likes;
          if (results.source === 'aucune') results.source = micro.source;
        }
        return results;
      });
    }
    return results;
  }).then(function (results) {
    if (results.videos.length === 0) {
      return fetchFromSlarker().then(function (slarker) {
        if (slarker && slarker.videos.length > 0) {
          results.videos = slarker.videos;
          if (results.source === 'aucune') results.source = slarker.source;
        }
        return results;
      });
    }
    return results;
  });
}

// ============================================================
// checkFollowers() — appelee par index.js sans argument
// Retourne le nombre d'abonnes (number) ou null en cas d'echec.
// ============================================================
function checkFollowers() {
  return fetchAllData().then(function (data) {
    if (data.followers !== null && data.followers !== undefined) {
      return data.followers;
    }
    console.log('[checkFollowers] Impossible de recuperer les abonnes (toutes sources ont echoue)');
    return null;
  }).catch(function (e) {
    console.log('[checkFollowers] Erreur inattendue : ' + e.message);
    return null;
  });
}

// ============================================================
// DETECTION NOUVEAUX TIKTOK + NOTIFICATION
// ============================================================
function checkForNewVideos() {
  console.log('\n--- Verification des nouveaux TikTok ---');

  return fetchAllData().then(function (data) {
    if (!data.videos || data.videos.length === 0) {
      console.log('[Videos] Aucune video trouvee');
      return;
    }

    if (knownVideoIds.size === 0) {
      console.log('[Videos] Premier lancement — ' + data.videos.length + ' videos enregistrees');
      var slice = data.videos.slice(0, MAX_STORED_IDS);
      for (var i = 0; i < slice.length; i++) {
        knownVideoIds.add(String(slice[i].id));
      }
      return;
    }

    var newVideos = [];
    for (var j = 0; j < data.videos.length; j++) {
      var vid = data.videos[j];
      var id = String(vid.id);
      if (!knownVideoIds.has(id)) {
        newVideos.push(vid);
        knownVideoIds.add(id);
      }
    }

    if (knownVideoIds.size > MAX_STORED_IDS) {
      var arr = Array.from(knownVideoIds);
      knownVideoIds = new Set(arr.slice(-MAX_STORED_IDS));
    }

    if (newVideos.length === 0) {
      console.log('[Videos] Pas de nouveau TikTok');
      return;
    }

    console.log('[Videos] ' + newVideos.length + ' nouveau(x) TikTok detecte(s) !');
    return sendNotifications(newVideos);
  }).catch(function (e) {
    console.log('[TikTok Monitor] Erreur pendant la verification : ' + e.message);
  });
}

function sendNotifications(videos) {
  var promises = videos.map(function (video) {
    var videoUrl = 'https://www.tiktok.com/@' + TIKTOK_USER + '/video/' + video.id;

    if (DISCORD_WEBHOOK) {
      var body = JSON.stringify({
        content: '@everyone \ud83c\udfac **Nouveau TikTok** de @' + TIKTOK_USER + ' ! Va le regarder \ud83d\udd25',
        allowed_mentions: { parse: ['everyone'] },
        embeds: [{
          title: video.desc || 'Nouveau TikTok',
          url: videoUrl,
          color: 0xFF0050,
          footer: { text: 'TikTok Monitor ' + VERSION },
          timestamp: new Date().toISOString(),
        }],
      });

      return fetch(DISCORD_WEBHOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body,
      }).then(function (resp) {
        if (resp.ok) {
          console.log('[Discord] Notification envoyee via webhook');
          return;
        }
        console.log('[Discord] Webhook HTTP ' + resp.status + ', tentative via channel');
        return sendViaChannel(video, videoUrl);
      }).catch(function (e) {
        console.log('[Discord] Webhook echoue : ' + e.message + ', tentative via channel');
        return sendViaChannel(video, videoUrl);
      });
    }

    return sendViaChannel(video, videoUrl);
  });

  return Promise.all(promises);
}

function sendViaChannel(video, videoUrl) {
  if (!discordClient) {
    console.log('[Discord] Pas de client Discord disponible (startTikTokMonitor non appele avec le client)');
    return Promise.resolve();
  }

  return discordClient.channels.fetch(CHANNEL_ID).then(function (channel) {
    if (!channel) return;
    var embed = new EmbedBuilder()
      .setTitle(video.desc || '\ud83c\udfac Nouveau TikTok !')
      .setURL(videoUrl)
      .setColor(0xFF0050)
      .setDescription(
        '@' + TIKTOK_USER + ' vient de poster un nouveau TikTok !\n\n' +
        '\ud83d\udd17 [Regarder le TikTok](' + videoUrl + ')'
      )
      .setFooter({ text: 'TikTok Monitor ' + VERSION })
      .setTimestamp();

    return channel.send({
      content: '@everyone \ud83c\udfac **Nouveau TikTok** de @' + TIKTOK_USER + ' ! Va le regarder \ud83d\udd25',
      embeds: [embed],
      allowedMentions: { parse: ['everyone'] },
    });
  }).then(function () {
    console.log('[Discord] Notification envoyee dans le channel');
  }).catch(function (e) {
    console.log('[Discord] Channel echoue : ' + e.message);
  });
}

// ============================================================
// startTikTokMonitor(client) — appelee par index.js avec le client Discord
// ============================================================
function startTikTokMonitor(client) {
  discordClient = client;

  console.log('============================================');
  console.log('   TikTok Monitor ' + VERSION + ' — demarre');
  console.log('   TikTok : @' + TIKTOK_USER);
  console.log('   Worker : ' + (WORKER_URL || 'Non configure (fallbacks actives)'));
  console.log('   Webhook : ' + (DISCORD_WEBHOOK ? 'Oui' : 'Non'));
  console.log('   Channel : ' + CHANNEL_ID);
  console.log('   Intervalle : ' + (CHECK_INTERVAL / 1000) + 's');
  console.log('============================================');

  // Premiere verification immediate
  checkForNewVideos();

  // Puis toutes les X minutes
  setInterval(checkForNewVideos, CHECK_INTERVAL);
}

module.exports = {
  startTikTokMonitor: startTikTokMonitor,
  checkFollowers: checkFollowers,
};
