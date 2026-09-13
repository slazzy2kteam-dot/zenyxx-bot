// ============================================================
// TikTok Monitor v7 — Bot Discord (version safe)
//
// Sources (dans l'ordre) :
//   1. Cloudflare Worker (PRINCIPAL) — abonnes + likes + videos
//   2. Microlink API (fallback)    — abonnes + likes
//   3. hub.slarker.me (fallback)   — videos
//
// Variables d'environnement requises :
//   DISCORD_TOKEN   — Token du bot Discord
//   WORKER_URL      — URL du Cloudflare Worker
//   DISCORD_WEBHOOK — URL du webhook Discord (optionnel)
//   TIKTOK_USER     — Nom TikTok sans @ (defaut: aetherofficiel)
//   CHECK_INTERVAL  — Intervalle en ms (defaut: 300000 = 5 min)
//   CHANNEL_ID      — ID du channel Discord
// ============================================================

const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');

// === CONFIG ===
var TIKTOK_USER = process.env.TIKTOK_USER || 'aetherofficiel';
var DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK || '';
var CHECK_INTERVAL = parseInt(process.env.CHECK_INTERVAL) || 300000;
var CHANNEL_ID = process.env.CHANNEL_ID || '1548231185015120054';
var WORKER_URL = process.env.WORKER_URL || '';

var VERSION = 'v7';
var MAX_STORED_IDS = 50;

// === STATE ===
var knownVideoIds = new Set();
var cachedFollowers = { count: null, likes: null, updated: 0 };
var FOLLOWER_CACHE_TTL = 3 * 3600 * 1000;

// === DISCORD CLIENT ===
var client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ============================================================
// UTILITAIRES HTTP
// ============================================================
function sleep(ms) {
  return new Promise(function(r) { setTimeout(r, ms); });
}

function fetchWithTimeout(url, options, timeoutMs) {
  if (!timeoutMs) timeoutMs = 25000;
  var controller = new AbortController();
  var timer = setTimeout(function() { controller.abort(); }, timeoutMs);
  return fetch(url, Object.assign({}, options, { signal: controller.signal }))
    .then(function(resp) {
      clearTimeout(timer);
      return resp;
    })
    .catch(function(e) {
      clearTimeout(timer);
      throw e;
    });
}

function fetchWithRetry(url, options, retries, delay) {
  if (!retries) retries = 2;
  if (!delay) delay = 2000;

  function attempt(remaining) {
    return fetchWithTimeout(url, options).then(function(resp) {
      if (resp.ok) return resp;
      if (remaining > 0 && resp.status >= 500) {
        return sleep(delay * (retries - remaining + 1)).then(function() {
          return attempt(remaining - 1);
        });
      }
      return resp;
    }).catch(function(e) {
      if (remaining > 0) {
        console.log('[Retry ' + (retries - remaining + 1) + '/' + retries + '] ' + e.message);
        return sleep(delay * (retries - remaining + 1)).then(function() {
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
    .then(function(resp) {
      if (!resp.ok) {
        console.log('[Worker] HTTP ' + resp.status);
        return null;
      }
      return resp.json();
    })
    .then(function(data) {
      if (!data || data.error) {
        console.log('[Worker] Erreur : ' + (data ? data.error : 'pas de donnees'));
        return null;
      }
      console.log('[Worker] OK — @' + (data.uniqueId || TIKTOK_USER) + ' — ' + data.followers + ' abonnes, ' + data.likes + ' likes — ' + (data.videos ? data.videos.length : 0) + ' videos');
      return {
        followers: data.followers,
        likes: data.likes,
        following: data.following,
        nickname: data.nickname,
        signature: data.signature,
        videos: data.videos || [],
        source: 'Cloudflare Worker'
      };
    })
    .catch(function(e) {
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

  // Essai 1 : page profil
  function tryMicrolinkProfile() {
    var url = 'https://api.microlink.io/?url=' + encodeURIComponent(profileUrl) + '&video=false';
    console.log('[Microlink] Tentative profil...');

    return fetchWithTimeout(url, {}, 20000)
      .then(function(resp) { return resp.json(); })
      .then(function(data) {
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
      .catch(function(e) {
        console.log('[Microlink] Profil echoue : ' + e.message);
        return null;
      });
  }

  // Essai 2 : page embed
  function tryMicrolinkEmbed() {
    var url = 'https://api.microlink.io/?url=' + encodeURIComponent(embedUrl) + '&video=false';
    console.log('[Microlink] Tentative embed...');

    return fetchWithTimeout(url, {}, 20000)
      .then(function(resp) { return resp.json(); })
      .then(function(data) {
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
      .catch(function(e) {
        console.log('[Microlink] Embed echoue : ' + e.message);
        return null;
      });
  }

  return tryMicrolinkProfile().then(function(result) {
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
      .then(function(resp) {
        if (!resp.ok) return null;
        return resp.json();
      })
      .then(function(data) {
        if (!data) return null;
        var items = data.items || data;
        if (!Array.isArray(items) || items.length === 0) return null;

        var videos = items.map(function(item) {
          var videoId = item.id || (item.url ? item.url.split('/').pop() : '') || (item.webpage_url ? item.webpage_url.split('/').pop() : '');
          var desc = item.title || item.content_text || item.summary || '';
          return { id: videoId, desc: desc };
        }).filter(function(v) { return v.id; });

        console.log('[Slarker] JSON Feed OK — ' + videos.length + ' videos');
        return { followers: null, likes: null, videos: videos, source: 'hub.slarker.me' };
      })
      .catch(function(e) {
        console.log('[Slarker] JSON echoue : ' + e.message);
        return null;
      });
  }

  function tryRssXml() {
    var rssUrl = 'https://hub.slarker.me/tiktok/user/@' + TIKTOK_USER;
    console.log('[Slarker] Tentative RSS XML...');
    return fetchWithRetry(rssUrl, { timeout: 25000 }, 1, 2000)
      .then(function(resp) {
        if (!resp.ok) return null;
        return resp.text();
      })
      .then(function(xml) {
        if (!xml) return null;
        var videoIds = xml.match(/video\/(\d+)/g);
        if (!videoIds || videoIds.length === 0) return null;

        var videos = videoIds.map(function(m) {
          var id = m.replace('video/', '');
          return { id: id, desc: '' };
        });

        // Deduplicate
        var seen = {};
        videos = videos.filter(function(v) {
          if (seen[v.id]) return false;
          seen[v.id] = true;
          return true;
        });

        console.log('[Slarker] RSS XML OK — ' + videos.length + ' videos');
        return { followers: null, likes: null, videos: videos, source: 'hub.slarker.me (RSS)' };
      })
      .catch(function(e) {
        console.log('[Slarker] RSS echoue : ' + e.message);
        return null;
      });
  }

  return tryJsonFeed().then(function(result) {
    if (result && result.videos.length > 0) return result;
    return tryRssXml();
  });
}

// ============================================================
// ORCHESTRATEUR
// ============================================================
function fetchAllData() {
  var results = { followers: null, likes: null, videos: [], source: 'aucune' };

  return fetchFromWorker().then(function(worker) {
    if (worker) {
      results.followers = worker.followers;
      results.likes = worker.likes;
      results.videos = worker.videos || [];
      results.source = worker.source;
    }

    if (results.followers === null) {
      return fetchFromMicrolink().then(function(micro) {
        if (micro) {
          results.followers = micro.followers;
          results.likes = micro.likes;
          if (results.source === 'aucune') results.source = micro.source;
        }
        return results;
      });
    }
    return results;
  }).then(function(results) {
    if (results.videos.length === 0) {
      return fetchFromSlarker().then(function(slarker) {
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
// DETECTION NOUVEAUX TIKTOK
// ============================================================
function checkForNewVideos() {
  console.log('\n--- Verification des nouveaux TikTok ---');

  return fetchAllData().then(function(data) {
    // Mettre a jour le cache des abonnes
    if (data.followers !== null) {
      cachedFollowers = {
        count: data.followers,
        likes: data.likes,
        updated: Date.now()
      };
      console.log('[Abonnes] ' + data.followers + ' abonnes, ' + (data.likes || '?') + ' likes (source: ' + data.source + ')');
    } else {
      console.log('[Abonnes] Impossible de recuperer les abonnes');
    }

    // Verifier les nouveaux TikTok
    if (!data.videos || data.videos.length === 0) {
      console.log('[Videos] Aucune video trouvee');
      return;
    }

    // Premier lancement : stocker les IDs
    if (knownVideoIds.size === 0) {
      console.log('[Videos] Premier lancement — ' + data.videos.length + ' videos enregistrees');
      var slice = data.videos.slice(0, MAX_STORED_IDS);
      for (var i = 0; i < slice.length; i++) {
        knownVideoIds.add(String(slice[i].id));
      }
      return;
    }

    // Verifier les nouvelles videos
    var newVideos = [];
    for (var j = 0; j < data.videos.length; j++) {
      var vid = data.videos[j];
      var id = String(vid.id);
      if (!knownVideoIds.has(id)) {
        newVideos.push(vid);
        knownVideoIds.add(id);
      }
    }

    // Limiter la taille du Set
    if (knownVideoIds.size > MAX_STORED_IDS) {
      var arr = Array.from(knownVideoIds);
      knownVideoIds = new Set(arr.slice(-MAX_STORED_IDS));
    }

    if (newVideos.length === 0) {
      console.log('[Videos] Pas de nouveau TikTok');
      return;
    }

    console.log('[Videos] ' + newVideos.length + ' nouveau(x) TikTok detecte(s) !');

    // Envoyer les notifications
    return sendNotifications(newVideos);
  });
}

// ============================================================
// NOTIFICATION DISCORD
// ============================================================
function sendNotifications(videos) {
  var promises = videos.map(function(video) {
    var videoUrl = 'https://www.tiktok.com/@' + TIKTOK_USER + '/video/' + video.id;

    // Methode 1 : Webhook
    if (DISCORD_WEBHOOK) {
      var body = JSON.stringify({
        content: '🎬 **Nouveau TikTok** de @' + TIKTOK_USER + ' !',
        embeds: [{
          title: video.desc || 'Nouveau TikTok',
          url: videoUrl,
          color: 0xFF0050,
          footer: { text: 'TikTok Monitor ' + VERSION },
          timestamp: new Date().toISOString()
        }]
      });

      return fetch(DISCORD_WEBHOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body
      }).then(function(resp) {
        if (resp.ok) {
          console.log('[Discord] Notification envoyee via webhook');
          return;
        }
        console.log('[Discord] Webhook HTTP ' + resp.status + ', tentative via channel');
        return sendViaChannel(video, videoUrl);
      }).catch(function(e) {
        console.log('[Discord] Webhook echoue : ' + e.message + ', tentative via channel');
        return sendViaChannel(video, videoUrl);
      });
    }

    // Methode 2 : Channel
    return sendViaChannel(video, videoUrl);
  });

  return Promise.all(promises);
}

function sendViaChannel(video, videoUrl) {
  return client.channels.fetch(CHANNEL_ID).then(function(channel) {
    if (!channel) return;
    var embed = new EmbedBuilder()
      .setTitle(video.desc || '🎬 Nouveau TikTok !')
      .setURL(videoUrl)
      .setColor(0xFF0050)
      .setDescription('@' + TIKTOK_USER + ' vient de poster un nouveau TikTok !\n\n🔗 [Regarder le TikTok](' + videoUrl + ')')
      .setFooter({ text: 'TikTok Monitor ' + VERSION })
      .setTimestamp();

    return channel.send({ embeds: [embed] });
  }).then(function() {
    console.log('[Discord] Notification envoyee dans le channel');
  }).catch(function(e) {
    console.log('[Discord] Channel echoue : ' + e.message);
  });
}

// ============================================================
// COMMANDE !FOLLOWERS
// ============================================================
function handleFollowersCommand(message) {
  // Utiliser le cache si recent
  if (cachedFollowers.count !== null && (Date.now() - cachedFollowers.updated) < FOLLOWER_CACHE_TTL) {
    var age = Math.round((Date.now() - cachedFollowers.updated) / 60000);
    message.reply(
      '📊 **@' + TIKTOK_USER + '** — ' + cachedFollowers.count.toLocaleString('fr-FR') + ' abonnes, ' + (cachedFollowers.likes ? cachedFollowers.likes.toLocaleString('fr-FR') : '?') + " j'aime _(il y a " + age + ' min)_'
    );
    return;
  }

  // Sinon, requete fraiche
  fetchAllData().then(function(data) {
    if (data.followers !== null) {
      cachedFollowers = {
        count: data.followers,
        likes: data.likes,
        updated: Date.now()
      };
      message.reply(
        '📊 **@' + TIKTOK_USER + '** — ' + data.followers.toLocaleString('fr-FR') + ' abonnes, ' + (data.likes ? data.likes.toLocaleString('fr-FR') : '?') + " j'aime ✅"
      );
    } else {
      message.reply(
        '❌ Impossible de recuperer les statistiques de @' + TIKTOK_USER + '.\n' +
        'Sources essayees : Cloudflare Worker, Microlink, hub.slarker.me.\n' +
        'Reessaie dans quelques minutes.'
      );
    }
  });
}

// ============================================================
// COMMANDES DISCORD
// ============================================================
client.on('messageCreate', function(message) {
  if (message.author.bot) return;

  var content = message.content.toLowerCase().trim();

  if (content === '!followers' || content === '!abonnes') {
    handleFollowersCommand(message);
  }

  if (content === '!tiktokstatus' || content === '!status') {
    var workerStatus = WORKER_URL ? 'Configure ✅' : 'Non configure ⚠️';
    var webhookStatus = DISCORD_WEBHOOK ? 'Configure ✅' : 'Non configure ⚠️';
    var lastCheck = knownVideoIds.size > 0 ? knownVideoIds.size + ' IDs connus' : 'Pas encore verifie';
    message.reply(
      '🔧 **TikTok Monitor ' + VERSION + '**\n' +
      '• Worker : ' + workerStatus + '\n' +
      '• Webhook : ' + webhookStatus + '\n' +
      '• TikTok : @' + TIKTOK_USER + '\n' +
      '• Abonnes : ' + (cachedFollowers.count != null ? cachedFollowers.count : 'N/A') + '\n' +
      '• Videos : ' + lastCheck + '\n' +
      '• Intervalle : ' + (CHECK_INTERVAL / 1000) + 's'
    );
  }
});

// ============================================================
// DEMARRAGE
// ============================================================
client.once('ready', function() {
  console.log('============================================');
  console.log('   TikTok Monitor ' + VERSION + ' — Bot connecte !');
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
});

// Lancer le bot
client.login(process.env.DISCORD_TOKEN);
