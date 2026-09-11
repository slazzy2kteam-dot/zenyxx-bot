const {
  Client,
  GatewayIntentBits,
  Partials,
  Options,
  EmbedBuilder,
  SlashCommandBuilder,
  PermissionFlagsBits,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  AttachmentBuilder,
  AuditLogEvent,
  MessageType,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  VoiceBasedChannel
} = require("discord.js");

const { createCanvas, loadImage } = require("@napi-rs/canvas");
const express = require("express");
const fs = require("fs");

// ======================================================
// SERVEUR HTTP
// ======================================================

const app = express();

app.get("/", (req, res) => {
  res.send("Bot en ligne !");
});

app.listen(process.env.PORT || 3000, () => {
  console.log("Serveur HTTP demarre");
});

// ======================================================
// CLIENT DISCORD
// ======================================================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildVoiceStates
  ],
  partials: [
    Partials.Message,
    Partials.Channel
  ],

  // Garde beaucoup plus de messages en mémoire par salon
  // (200 par défaut → 5000), pour que les logs de suppression
  // affichent l'auteur et le contenu même sur des salons très actifs.
  makeCache:
    Options.cacheWithLimits({
      ...Options.DefaultMakeCacheSettings,

      MessageManager:
        5000
    }),

  // Empêche Discord.js de "nettoyer" les vieux messages du cache
  // trop rapidement (garde les messages jusqu'à 24h avant de les retirer).
  sweepers: {
    ...Options.DefaultSweeperSettings,

    messages: {
      interval:
        3600,

      lifetime:
        86400
    }
  }
});

// ======================================================
// CONFIGURATION
// ======================================================

const LOG_CHANNEL_NAME = "📋・logs";
const TICKET_LOG_CHANNEL_NAME = "🚫-logs-tickets";
const MODERATION_LOG_CHANNEL_NAME = "🚫-logs-moderation";
const WELCOME_CHANNEL_NAME = "🔨-arrivé-des-membres";
const GOODBYE_CHANNEL_NAME = "✈️・𝗮𝘂𝗿𝗲𝘃𝗼𝗶𝗿";
const PUBLIC_WELCOME_CHANNEL_NAME = "👋-bienvenue";
const BOOST_CHANNEL_NAME = "🚀・boost";

const CASE_FILE = "./cases.json";

const MAX_EMBED_FIELD = 1024;

// ======================================================
// SYSTÈME DE VOCALES PRIVÉES
// ======================================================

// IDs des salons "hub" qui déclenchent la création
// 🔉 • Créer ta vocal duo → 2 places
// 🔉 • Créer ta vocal trio → 3 places
const VOCAL_HUBS = {
  "1547964402118959214": 2,
  "1547943285010472991": 3
};

// Stockage en mémoire : channelId -> { ownerId, hubType, locked, hidden, blockedUsers, panelMessageId }
const privateVoiceChannels = new Map();

// Fichier de sauvegarde pour les vocales privées
const VOCAL_FILE = "./private_vocals.json";

function loadVocalData() {
  try {
    if (!fs.existsSync(VOCAL_FILE)) {
      return {};
    }
    return JSON.parse(fs.readFileSync(VOCAL_FILE, "utf8"));
  } catch (error) {
    console.error("Erreur lecture private_vocals.json :", error);
    return {};
  }
}

function saveVocalData() {
  try {
    const data = {};
    for (const [channelId, info] of privateVoiceChannels.entries()) {
      data[channelId] = info;
    }
    fs.writeFileSync(VOCAL_FILE, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error("Erreur écriture private_vocals.json :", error);
  }
}

function restoreVocalData() {
  const data = loadVocalData();
  for (const [channelId, info] of Object.entries(data)) {
    privateVoiceChannels.set(channelId, info);
  }
}


// ======================================================
// PANEL DE CONTRÔLE VOCAL
// ======================================================

function buildVoiceControlPanel(channel, owner) {
  const info = privateVoiceChannels.get(channel.id);
  const isLocked = info?.locked || false;
  const isHidden = info?.hidden || false;
  const hubType = info?.hubType || 2;
  const limit = channel.userLimit || hubType;

  const embed = new EmbedBuilder()
    .setTitle("🔊 Panneau de contrôle du salon")
    .setColor(0x5865F2)
    .addFields(
      {
        name: "Salon :",
        value: `🔊 👥 • ${channel.name}`,
        inline: true
      },
      {
        name: "Propriétaire :",
        value: `<@${owner.id}>`,
        inline: true
      }
    )
    .setDescription(
      "Utilise les boutons ci-dessous pour gérer ton salon vocal.\n" +
      "✏️ **Renommer** Change le nom du salon\n" +
      "👥 **Limite** Définit le nombre max de membres\n" +
      "🔒 **Verrouiller** Empêche les autres de rejoindre\n" +
      "👁️ **Masquer** Cache le salon\n" +
      "👑 **Propriétaire** Transfère le salon\n" +
      "🚫 **Exclure** Kick / bloque un membre.\n\n" +
      "Seul le propriétaire du salon peut utiliser ces contrôles."
    );

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("vc_rename")
      .setLabel("Renommer")
      .setStyle(ButtonStyle.Secondary)
      .setEmoji("✏️"),
    new ButtonBuilder()
      .setCustomId("vc_limit")
      .setLabel("Limite")
      .setStyle(ButtonStyle.Secondary)
      .setEmoji("👤"),
    new ButtonBuilder()
      .setCustomId("vc_quality")
      .setLabel("Qualité")
      .setStyle(ButtonStyle.Secondary)
      .setEmoji("🎚️")
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("vc_lock")
      .setLabel("Verrouiller")
      .setStyle(ButtonStyle.Secondary)
      .setEmoji("🔒")
      .setDisabled(isLocked),
    new ButtonBuilder()
      .setCustomId("vc_unlock")
      .setLabel("Déverrouiller")
      .setStyle(ButtonStyle.Secondary)
      .setEmoji("🔓")
      .setDisabled(!isLocked)
  );

  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("vc_hide")
      .setLabel("Masquer")
      .setStyle(ButtonStyle.Secondary)
      .setEmoji("👁️")
      .setDisabled(isHidden),
    new ButtonBuilder()
      .setCustomId("vc_show")
      .setLabel("Afficher")
      .setStyle(ButtonStyle.Secondary)
      .setEmoji("🕶️")
      .setDisabled(!isHidden)
  );

  const row4 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("vc_kick")
      .setLabel("Exclure")
      .setStyle(ButtonStyle.Danger)
      .setEmoji("🔨"),
    new ButtonBuilder()
      .setCustomId("vc_block")
      .setLabel("Bloquer")
      .setStyle(ButtonStyle.Danger)
      .setEmoji("🚫"),
    new ButtonBuilder()
      .setCustomId("vc_allow")
      .setLabel("Autoriser")
      .setStyle(ButtonStyle.Success)
      .setEmoji("✅")
  );

  const row5 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("vc_claim")
      .setLabel("Réclamer")
      .setStyle(ButtonStyle.Primary)
      .setEmoji("👑"),
    new ButtonBuilder()
      .setCustomId("vc_transfer")
      .setLabel("Transférer")
      .setStyle(ButtonStyle.Primary)
      .setEmoji("🎁")
  );

  return {
    embeds: [embed],
    components: [row1, row2, row3, row4, row5]
  };
}


// ======================================================
// CRÉATION D'UNE VOCALE PRIVÉE
// ======================================================

async function createPrivateVoiceChannel(member, hubChannel) {
  const guild = member.guild;
  const hubType = VOCAL_HUBS[hubChannel.id] || 2;

  // Trouver la catégorie du hub
  const category = hubChannel.parent;

  // Créer le nom du salon
  const typeLabel = hubType === 2 ? "Duo" : "Trio";
  const channelName = `${typeLabel} de ${member.user.username}`;

  // Permissions : privé par défaut
  const permissionOverwrites = [
    {
      id: guild.roles.everyone.id,
      deny: [
        PermissionFlagsBits.ViewChannel
      ]
    },
    {
      id: member.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.Connect,
        PermissionFlagsBits.Speak,
        PermissionFlagsBits.Stream,
        PermissionFlagsBits.UseVAD,
        PermissionFlagsBits.ManageChannels
      ]
    },
    {
      id: client.user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.Connect,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.MoveMembers
      ]
    }
  ];

  const newChannel = await guild.channels.create({
    name: channelName,
    type: ChannelType.GuildVoice,
    parent: category,
    userLimit: hubType,
    permissionOverwrites
  }).catch(() => null);

  if (!newChannel) {
    console.error("Impossible de créer la vocale privée");
    return null;
  }

  // Déplacer le membre dans le nouveau salon
  await member.voice.setChannel(newChannel).catch(() => {});

  // Enregistrer les infos
  const channelInfo = {
    ownerId: member.id,
    hubType,
    locked: false,
    hidden: true,
    blockedUsers: [],
    panelMessageId: null
  };

  privateVoiceChannels.set(newChannel.id, channelInfo);
  saveVocalData();

  // Envoyer le panel dans le chat intégré de la vocale
  const panel = buildVoiceControlPanel(newChannel, member.user);
  const panelMsg = await newChannel.send(panel).catch(() => null);

  if (panelMsg) {
    channelInfo.panelMessageId = panelMsg.id;
    privateVoiceChannels.set(newChannel.id, channelInfo);
    saveVocalData();
  }

  return newChannel;
}


// ======================================================
// METTRE À JOUR LE PANEL
// ======================================================

async function updateVoicePanel(voiceChannel) {
  const info = privateVoiceChannels.get(voiceChannel.id);
  if (!info || !info.panelMessageId) return;

  const panelMsg = await voiceChannel.messages.fetch(info.panelMessageId).catch(() => null);
  if (!panelMsg) return;

  const owner = await voiceChannel.guild.members.fetch(info.ownerId).catch(() => null);
  const panel = buildVoiceControlPanel(voiceChannel, owner?.user || { id: info.ownerId });

  await panelMsg.edit(panel).catch(() => {});
}


// ======================================================
// SUPPRESSION D'UNE VOCALE PRIVÉE
// ======================================================

async function deletePrivateVoiceChannel(voiceChannel) {
  privateVoiceChannels.delete(voiceChannel.id);
  saveVocalData();

  // Supprimer le salon vocal lui-même
  await voiceChannel.delete().catch(() => {});
}


// ======================================================
// VÉRIFIER SI UN MEMBRE EST PROPRIÉTAIRE
// ======================================================

function isVoiceOwner(voiceChannelId, userId) {
  const info = privateVoiceChannels.get(voiceChannelId);
  return info?.ownerId === userId;
}

// Permet d'éviter les doubles logs
// ======================================================

const botActions = new Map();

function actionKey(guildId, userId, action) {
  return `${guildId}:${userId}:${action}`;
}

function markBotAction(
  guildId,
  userId,
  action,
  ttl = 15000
) {
  const key = actionKey(
    guildId,
    userId,
    action
  );

  botActions.set(
    key,
    Date.now() + ttl
  );

  setTimeout(() => {
    botActions.delete(key);
  }, ttl + 1000);
}

function consumeBotAction(
  guildId,
  userId,
  action
) {
  const key = actionKey(
    guildId,
    userId,
    action
  );

  const expires =
    botActions.get(key);

  if (!expires) {
    return false;
  }

  botActions.delete(key);

  return expires >= Date.now();
}


// ======================================================
// SALONS
// ======================================================

function getLogChannel(
  guild,
  channelName = LOG_CHANNEL_NAME
) {
  return guild.channels.cache.find(
    channel =>
      channel.name === channelName &&
      channel.isTextBased()
  );
}


// ======================================================
// UTILITAIRES
// ======================================================

function cleanText(
  value,
  fallback = "Aucune information"
) {
  const text =
    String(
      value ?? fallback
    ).trim() || fallback;

  if (
    text.length >
    MAX_EMBED_FIELD
  ) {
    return (
      text.slice(
        0,
        MAX_EMBED_FIELD - 3
      ) + "..."
    );
  }

  return text;
}


function formatDiscordDate(date) {
  return `<t:${Math.floor(
    new Date(date).getTime() / 1000
  )}:F>`;
}


// ======================================================
// LOG SIMPLE
// ======================================================

async function sendLog(
  guild,
  title,
  description,
  channelName = LOG_CHANNEL_NAME,
  fields = [],
  color = 0x5865F2
) {
  const channel =
    getLogChannel(
      guild,
      channelName
    );

  if (!channel) {
    return;
  }

  const embed =
    new EmbedBuilder()
      .setTitle(title)
      .setColor(color)
      .setTimestamp();

  if (description) {
    embed.setDescription(
      cleanText(
        description,
        ""
      )
    );
  }

  if (fields.length) {
    embed.addFields(
      fields.map(field => ({
        ...field,
        value: cleanText(
          field.value
        )
      }))
    );
  }

  await channel.send({
    embeds: [embed]
  }).catch(() => {});
}


// ======================================================
// SYSTÈME DE CASES
// ======================================================

function loadCaseData() {
  try {

    if (!fs.existsSync(CASE_FILE)) {

      const initial = {};

      fs.writeFileSync(
        CASE_FILE,
        JSON.stringify(
          initial,
          null,
          2
        )
      );

      return initial;
    }

    const data =
      JSON.parse(
        fs.readFileSync(
          CASE_FILE,
          "utf8"
        )
      );

    // Compatibilité avec un ancien cases.json
    for (
      const [guildId, value]
      of Object.entries(data)
    ) {

      if (
        typeof value ===
        "number"
      ) {

        data[guildId] = {
          nextCase: value,
          cases: [],
          tempbans: []
        };

      } else {

        data[guildId] ??= {};

        data[guildId].nextCase ??=
          223;

        data[guildId].cases ??=
          [];

        data[guildId].tempbans ??=
          [];
      }
    }

    return data;

  } catch (error) {

    console.error(
      "Erreur lecture cases.json :",
      error
    );

    return {};
  }
}


function saveCaseData(data) {

  try {

    fs.writeFileSync(
      CASE_FILE,
      JSON.stringify(
        data,
        null,
        2
      )
    );

  } catch (error) {

    console.error(
      "Erreur écriture cases.json :",
      error
    );
  }
}


function getGuildCaseData(
  guildId,
  data = loadCaseData()
) {

  data[guildId] ??= {
    nextCase: 223,
    cases: [],
    tempbans: []
  };

  data[guildId].nextCase ??=
    223;

  data[guildId].cases ??=
    [];

  data[guildId].tempbans ??=
    [];

  return data[guildId];
}


function createCase(
  guildId,
  caseInfo
) {

  const data =
    loadCaseData();

  const guildData =
    getGuildCaseData(
      guildId,
      data
    );

  guildData.nextCase++;

  const record = {
    case:
      guildData.nextCase,

    createdAt:
      Date.now(),

    ...caseInfo
  };

  guildData.cases.push(
    record
  );

  saveCaseData(data);

  return record.case;
}


// ======================================================
// WARNINGS
// ======================================================

function getWarnings(
  guildId,
  userId
) {

  const data =
    loadCaseData();

  const guildData =
    getGuildCaseData(
      guildId,
      data
    );

  return guildData.cases.filter(
    c =>
      c.type === "warn" &&
      c.userId === userId
  );
}


function clearWarnings(
  guildId,
  userId
) {

  const data =
    loadCaseData();

  const guildData =
    getGuildCaseData(
      guildId,
      data
    );

  const before =
    guildData.cases.length;

  guildData.cases =
    guildData.cases.filter(
      c =>
        !(
          c.type === "warn" &&
          c.userId === userId
        )
    );

  saveCaseData(data);

  return (
    before -
    guildData.cases.length
  );
}


function findCase(
  guildId,
  caseNumber
) {

  const data =
    loadCaseData();

  const guildData =
    getGuildCaseData(
      guildId,
      data
    );

  return guildData.cases.find(
    c =>
      Number(c.case) ===
      Number(caseNumber)
  );
}


// ======================================================
// DURÉES
//
// Exemples acceptés :
// 30s
// 5m
// 2h
// 1d
// 4d
// 7d
// 14d
// 28d
// 1w
// 1j
// 4jours
// ======================================================

function parseDuration(
  input
) {

  if (!input) {
    return null;
  }

  const value =
    String(input)
      .trim()
      .toLowerCase()
      .replace(
        /\s+/g,
        ""
      );

  const match =
    value.match(
      /^(\d+)(s|sec|m|min|h|heure|heures|d|j|jour|jours|w|sem|semaine|semaines)$/
    );

  if (!match) {
    return null;
  }

  const amount =
    Number(match[1]);

  const unit =
    match[2];

  const multiplier =

    ["s", "sec"].includes(unit)
      ? 1000

      : ["m", "min"].includes(unit)
      ? 60 * 1000

      : [
          "h",
          "heure",
          "heures"
        ].includes(unit)
      ? 60 * 60 * 1000

      : [
          "d",
          "j",
          "jour",
          "jours"
        ].includes(unit)
      ? 24 * 60 * 60 * 1000

      : 7 *
        24 *
        60 *
        60 *
        1000;

  return amount * multiplier;
}


function formatDuration(
  ms
) {

  let remaining =
    Math.max(
      0,
      Number(ms)
    );

  const parts = [];

  const units = [

    [
      7 *
      24 *
      60 *
      60 *
      1000,

      "semaine",
      "semaines"
    ],

    [
      24 *
      60 *
      60 *
      1000,

      "jour",
      "jours"
    ],

    [
      60 *
      60 *
      1000,

      "heure",
      "heures"
    ],

    [
      60 *
      1000,

      "minute",
      "minutes"
    ],

    [
      1000,

      "seconde",
      "secondes"
    ]
  ];

  for (
    const [
      size,
      one,
      many
    ]
    of units
  ) {

    if (
      remaining >= size
    ) {

      const amount =
        Math.floor(
          remaining / size
        );

      remaining %=
        size;

      parts.push(
        `${amount} ${
          amount === 1
            ? one
            : many
        }`
      );
    }

    if (
      parts.length >= 2
    ) {
      break;
    }
  }

  return parts.length
    ? parts.join(" et ")
    : "0 seconde";
}


// ======================================================
// LOG DE MODÉRATION
// ======================================================

async function sendModerationLog({
  guild,
  title,
  color,
  type,
  memberUser,
  moderator,
  reason = "Aucune raison fournie",
  duration = null,
  expires = null,
  proof = null,
  extraFields = []
}) {

  const channel =
    getLogChannel(
      guild,
      MODERATION_LOG_CHANNEL_NAME
    );

  if (!channel) {
    return null;
  }

  const caseNumber =
    createCase(
      guild.id,
      {
        type,

        userId:
          memberUser.id,

        userTag:
          memberUser.tag,

        moderatorId:
          moderator?.id ??
          null,

        moderatorTag:
          moderator?.tag ??
          "Inconnu",

        reason,

        duration,

        expiresAt:
          expires
            ? new Date(
                expires
              ).getTime()
            : null,

        proof:
          proof?.url ??
          null
      }
    );

  const embed =
    new EmbedBuilder()
      .setTitle(title)
      .setColor(color)
      .setThumbnail(
        memberUser.displayAvatarURL({
          extension: "png",
          size: 256
        })
      )

      .addFields(

        {
          name:
            "👤 Membre",

          value:
            `${memberUser.tag} (\`${memberUser.id}\`)`,

          inline:
            false
        },

        {
          name:
            "🛡️ Modérateur",

          value:
            `${moderator?.tag ?? "Inconnu"} (\`${moderator?.id ?? "Inconnu"}\`)`,

          inline:
            false
        }
      );

  if (duration) {

    embed.addFields({
      name:
        "⏱️ Durée",

      value:
        duration,

      inline:
        true
    });
  }

  if (expires) {

    embed.addFields({
      name:
        "📅 Expire",

      value:
        formatDiscordDate(
          expires
        ),

      inline:
        true
    });
  }

  embed.addFields({
    name:
      "📝 Raison",

    value:
      cleanText(reason),

    inline:
      false
  });

  if (proof) {

    embed.addFields({
      name:
        "📎 Preuves",

      value:
        `[Voir la preuve](${proof.url})`,

      inline:
        false
    });
  }

  if (
    extraFields.length
  ) {

    embed.addFields(
      extraFields.map(
        field => ({
          ...field,

          value:
            cleanText(
              field.value
            )
        })
      )
    );
  }

  embed.addFields({
    name:
      "📁 Case",

    value:
      `#${caseNumber}`,

    inline:
      false
  });

  embed
    .setFooter({
      text:
        `Case #${caseNumber}`
    })

    .setTimestamp();

  await channel.send({
    embeds: [
      embed
    ]
  }).catch(() => {});

  return caseNumber;
}


// ======================================================
// IMAGE DE BIENVENUE
// ======================================================

async function generateWelcomeImage(
  member
) {

  const width = 900;
  const height = 300;

  const canvas =
    createCanvas(
      width,
      height
    );

  const ctx =
    canvas.getContext(
      "2d"
    );

  ctx.fillStyle =
    "#23272a";

  ctx.fillRect(
    0,
    0,
    width,
    height
  );

  ctx.fillStyle =
    "#5865F2";

  ctx.fillRect(
    0,
    0,
    8,
    height
  );

  const avatarSize =
    200;

  const avatarX =
    60;

  const avatarY =
    (
      height -
      avatarSize
    ) / 2;

  const avatarURL =
    member.user.displayAvatarURL({
      extension: "png",
      size: 256
    });

  const avatarImage =
    await loadImage(
      avatarURL
    );

  ctx.save();

  ctx.beginPath();

  ctx.arc(
    avatarX +
      avatarSize / 2,

    avatarY +
      avatarSize / 2,

    avatarSize / 2,

    0,
    Math.PI * 2
  );

  ctx.closePath();
  ctx.clip();

  ctx.drawImage(
    avatarImage,
    avatarX,
    avatarY,
    avatarSize,
    avatarSize
  );

  ctx.restore();

  const textX =
    avatarX +
    avatarSize +
    50;

  ctx.textBaseline =
    "top";

  ctx.fillStyle =
    "#ffffff";

  ctx.font =
    "bold 60px sans-serif";

  ctx.fillText(
    "Bienvenue",
    textX,
    70
  );

  ctx.font =
    "28px sans-serif";

  ctx.fillStyle =
    "#b9bbbe";

  ctx.fillText(
    "sur le serveur Discord",
    textX,
    150
  );

  ctx.font =
    "bold 34px sans-serif";

  ctx.fillStyle =
    "#ffffff";

  ctx.fillText(
    member.user.username,
    textX,
    195
  );

  return canvas.toBuffer(
    "image/png"
  );
}


// ======================================================
// TRANSCRIPT
// ======================================================

async function generateTranscript(
  channel
) {

  let allMessages = [];

  let lastId = null;

  while (true) {

    const options = {
      limit: 100
    };

    if (lastId) {
      options.before =
        lastId;
    }

    const fetched =
      await channel.messages.fetch(
        options
      );

    if (
      fetched.size === 0
    ) {
      break;
    }

    allMessages.push(
      ...fetched.values()
    );

    lastId =
      fetched.last().id;

    if (
      fetched.size < 100
    ) {
      break;
    }
  }

  allMessages.reverse();

  const participantIds =
    new Set();

  for (
    const msg
    of allMessages
  ) {

    if (
      msg.author &&
      !msg.author.bot
    ) {

      participantIds.add(
        msg.author.id
      );
    }
  }

  const lines =
    allMessages.map(
      msg => {

        const time =
          msg.createdAt.toLocaleString(
            "fr-FR",
            {
              dateStyle:
                "short",

              timeStyle:
                "short"
            }
          );

        let content =
          msg.content || "";

        for (
          const [
            id,
            user
          ]
          of msg.mentions.users
        ) {

          content =
            content.replace(
              new RegExp(
                `<@!?${id}>`,
                "g"
              ),

              `@${user.username}`
            );
        }

        for (
          const [
            id,
            role
          ]
          of msg.mentions.roles
        ) {

          content =
            content.replace(
              new RegExp(
                `<@&${id}>`,
                "g"
              ),

              `@${role.name}`
            );
        }

        for (
          const [
            id,
            channelMention
          ]
          of msg.mentions.channels
        ) {

          content =
            content.replace(
              new RegExp(
                `<#${id}>`,
                "g"
              ),

              `#${channelMention.name}`
            );
        }

        const attachments =
          [
            ...msg.attachments.values()
          ]

            .map(
              a =>
                `[Fichier joint : ${a.name} — ${a.url}]`
            )

            .join("\n");

        let line =
          `[${time}] ${msg.author.tag} : ${content}`;

        if (attachments) {
          line +=
            `\n${attachments}`;
        }

        return line;
      }
    );

  const text =
    `Transcript du ticket : ${channel.name}\n` +
    `${"=".repeat(50)}\n\n` +
    (
      lines.length
        ? lines.join("\n\n")
        : "Aucun message dans ce ticket."
    );

  return {
    text,
    participantIds:
      [...participantIds]
  };
}


// ======================================================
// TICKETS
// ======================================================

const TICKET_CATEGORIES = [

  {
    value:
      "administration",

    label:
      "Administration",

    emoji:
      "🛡️",

    roles:
      [
        "Administrateur"
      ]
  },

  {
    value:
      "aide_generale",

    label:
      "Aide générale",

    emoji:
      "❓",

    roles:
      [
        "Administrateur",
        "Moderateur Discord",
        "Helper"
      ]
  },

  {
    value:
      "moderation_discord",

    label:
      "Modération Discord",

    emoji:
      "⚔️",

    roles:
      [
        "Administrateur",
        "Gestionnaire.Mods discord",
        "Moderateur Discord"
      ]
  },

  {
    value:
      "moderation_twitch",

    label:
      "Modération Twitch",

    emoji:
      "🟣",

    roles:
      [
        "Administrateur",
        "Gestionnaire Twitch",
        "Moderateur Twitch"
      ]
  },

  {
    value:
      "moderation_youtube",

    label:
      "Modération YouTube",

    emoji:
      "🔴",

    roles:
      [
        "Administrateur",
        "Moderateur YouTube"
      ]
  },

  {
    value:
      "animation",

    label:
      "Animation",

    emoji:
      "🎉",

    roles:
      [
        "Administrateur",
        "Moderateur Animation"
      ]
  },

  {
    value:
      "bug_technique",

    label:
      "Bug ou problème technique",

    emoji:
      "🛠️",

    roles:
      [
        "Administrateur"
      ]
  },

  {
    value:
      "candidature",

    label:
      "Candidature",

    emoji:
      "📋",

    hasSubcategories:
      true
  },

  {
    value:
      "abus_staff",

    label:
      "Signaler un abus d'un Staff",

    emoji:
      "🚨",

    roles:
      [
        "Administrateur"
      ]
  },

  {
    value:
      "autre",

    label:
      "Autre demande",

    emoji:
      "✏️",

    roles:
      [
        "Administrateur",
        "Moderateur Discord",
        "Helper"
      ]
  }
];


const CANDIDATURE_SUBCATEGORIES = [

  {
    value:
      "candidature_discord",

    label:
      "Staff Discord",

    emoji:
      "⚔️",

    description:
      "Modération / Staff sur le serveur Discord",

    roles:
      [
        "Administrateur",
        "Gestionnaire.Mods discord"
      ]
  },

  {
    value:
      "candidature_twitch",

    label:
      "Twitch",

    emoji:
      "🟣",

    description:
      "Modération pendant les lives Twitch",

    roles:
      [
        "Administrateur",
        "Gestionnaire Twitch"
      ]
  },

  {
    value:
      "candidature_youtube",

    label:
      "YouTube / TikTok",

    emoji:
      "🔴",

    description:
      "Modération YouTube / TikTok",

    roles:
      [
        "Administrateur"
      ]
  },

  {
    value:
      "candidature_animation",

    label:
      "Animation",

    emoji:
      "🎭",

    description:
      "Animateur sur le serveur",

    roles:
      [
        "Administrateur",
        "Gestionnaire.Mods discord"
      ]
  }
];


function getRolesForCategory(
  guild,
  category
) {

  return (
    category.roles || []
  )

    .map(
      roleName =>
        guild.roles.cache.find(
          r =>
            r.name ===
            roleName
        )
    )

    .filter(Boolean);
}


// ======================================================
// PANEL TICKET
// ======================================================

function buildTicketPanel() {

  const banniere =
    new AttachmentBuilder(
      "./zenyxx_banner.png"
    );

  const embed =
    new EmbedBuilder()

      .setTitle(
        "🎫 Support — Ouvrir un ticket"
      )

      .setDescription(
        "Sélectionnez le type de demande ci-dessous pour ouvrir un ticket :\n\n" +

        TICKET_CATEGORIES
          .map(
            c =>
              `${c.emoji} — **${c.label}**`
          )
          .join("\n")
      )

      .setImage(
        "attachment://zenyxx_banner.png"
      )

      .setColor(
        0x5865F2
      );

  const selectMenu =
    new StringSelectMenuBuilder()

      .setCustomId(
        "ticket_category_select"
      )

      .setPlaceholder(
        "Sélectionnez le type de ticket"
      )

      .addOptions(
        TICKET_CATEGORIES.map(
          c => ({
            label:
              c.label,

            value:
              c.value,

            emoji:
              c.emoji
          })
        )
      );

  return {

    embeds:
      [embed],

    components:
      [
        new ActionRowBuilder()
          .addComponents(
            selectMenu
          )
      ],

    files:
      [banniere]
  };
}


// ======================================================
// CRÉATION TICKET
// ======================================================

async function createTicketChannel(
  interaction,
  guild,
  categoryLike
) {

  const safeUsername =
    interaction.user.username
      .toLowerCase()
      .replace(
        /[^a-z0-9-_]/g,
        "-"
      )
      .slice(
        0,
        40
      );

  const existing =
    guild.channels.cache.find(
      c =>
        c.name ===
        `ticket-${categoryLike.value}-${safeUsername}`
    );

  if (existing) {

    return interaction.editReply({
      content:
        `Tu as déjà un ticket ouvert : ${existing}`
    });
  }

  const staffRoles =
    getRolesForCategory(
      guild,
      categoryLike
    );

  const permissionOverwrites = [

    {
      id:
        guild.roles.everyone.id,

      deny:
        [
          PermissionFlagsBits.ViewChannel
        ]
    },

    {
      id:
        interaction.user.id,

      allow:
        [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory
        ]
    },

    ...staffRoles.map(
      role => ({

        id:
          role.id,

        allow:
          [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory
          ]
      })
    )
  ];

  const ticketChannel =
    await guild.channels.create({

      name:
        `ticket-${categoryLike.value}-${safeUsername}`,

      type:
        ChannelType.GuildText,

      topic:
        `ticket-creator:${interaction.user.id}`,

      permissionOverwrites
    })
      .catch(
        () => null
      );

  if (!ticketChannel) {

    return interaction.editReply({
      content:
        "❌ Impossible de créer le ticket. Vérifie mes permissions."
    });
  }

  const welcomeEmbed =
    new EmbedBuilder()

      .setTitle(
        `${categoryLike.emoji} Ticket — ${categoryLike.label}`
      )

      .setDescription(
        `Bienvenue ${interaction.user}, ton ticket a été créé.\n\n` +
        `Merci de décrire ta demande en détail. Un membre du staff va te répondre bientôt.`
      )

      .setColor(
        0x5865F2
      )

      .setTimestamp();

  const closeButton =
    new ButtonBuilder()

      .setCustomId(
        "close_ticket"
      )

      .setLabel(
        "Fermer le ticket"
      )

      .setStyle(
        ButtonStyle.Danger
      )

      .setEmoji(
        "🔒"
      );

  const silentRoles = [
    "Administrateur",
    "Gestionnaire.Mods discord"
  ];

  const pingCandidates =
    staffRoles.filter(
      r =>
        !silentRoles.includes(
          r.name
        )
    );

  const mentionRoles =
    (
      pingCandidates.length
        ? pingCandidates
        : staffRoles
    )

      .map(
        r =>
          `<@&${r.id}>`
      )

      .join(" ");

  await ticketChannel.send({

    content:
      `${interaction.user} ${mentionRoles}`.trim(),

    embeds:
      [welcomeEmbed],

    components:
      [
        new ActionRowBuilder()
          .addComponents(
            closeButton
          )
      ]
  });

  await interaction.editReply({
    content:
      `✅ Ton ticket a été créé : ${ticketChannel}`
  });
}


// ======================================================
// TEMPBAN
// ======================================================

function addTempBan(
  guildId,
  userId,
  expiresAt
) {

  const data =
    loadCaseData();

  const guildData =
    getGuildCaseData(
      guildId,
      data
    );

  guildData.tempbans =
    guildData.tempbans.filter(
      x =>
        x.userId !== userId
    );

  guildData.tempbans.push({
    userId,
    expiresAt
  });

  saveCaseData(data);
}


function removeTempBan(
  guildId,
  userId
) {

  const data =
    loadCaseData();

  const guildData =
    getGuildCaseData(
      guildId,
      data
    );

  guildData.tempbans =
    guildData.tempbans.filter(
      x =>
        x.userId !== userId
    );

  saveCaseData(data);
}


function scheduleTempBan(
  guild,
  userId,
  expiresAt
) {

  const delay =
    Math.max(
      0,
      expiresAt -
      Date.now()
    );

  // setTimeout ne peut pas gérer plus de ~24,8 jours.
  if (
    delay >
    2147483647
  ) {

    setTimeout(
      () => {

        scheduleTempBan(
          guild,
          userId,
          expiresAt
        );

      },

      2147483647
    );

    return;
  }

  setTimeout(
    async () => {

      try {

        await guild.members.unban(
          userId,
          "Fin du bannissement temporaire"
        );

        removeTempBan(
          guild.id,
          userId
        );

        console.log(
          `✅ Tempban terminé pour ${userId} sur ${guild.name}`
        );

      } catch {

        removeTempBan(
          guild.id,
          userId
        );
      }

    },

    delay
  );
}


async function restoreTempBans() {

  const data =
    loadCaseData();

  for (
    const [
      guildId,
      guildData
    ]
    of Object.entries(data)
  ) {

    const guild =
      client.guilds.cache.get(
        guildId
      );

    if (!guild) {
      continue;
    }

    const tempbans =
      guildData.tempbans ||
      [];

    for (
      const tempban
      of tempbans
    ) {

      if (
        tempban.expiresAt <=
        Date.now()
      ) {

        await guild.members.unban(
          tempban.userId,
          "Fin du bannissement temporaire"
        ).catch(
          () => {}
        );

        removeTempBan(
          guildId,
          tempban.userId
        );

      } else {

        scheduleTempBan(
          guild,
          tempban.userId,
          tempban.expiresAt
        );
      }
    }
  }
}


// ======================================================
// COMMANDES
// ======================================================

const commands = [

  // KICK
  new SlashCommandBuilder()

    .setName(
      "kick"
    )

    .setDescription(
      "Expulse un membre du serveur"
    )

    .addUserOption(
      o =>
        o
          .setName(
            "membre"
          )
          .setDescription(
            "Le membre à expulser"
          )
          .setRequired(
            true
          )
    )

    .addStringOption(
      o =>
        o
          .setName(
            "raison"
          )
          .setDescription(
            "Raison de l'expulsion"
          )
          .setRequired(
            false
          )
    )

    .addAttachmentOption(
      o =>
        o
          .setName(
            "preuve"
          )
          .setDescription(
            "Preuve de la sanction"
          )
          .setRequired(
            false
          )
    )

    .setDefaultMemberPermissions(
      PermissionFlagsBits.KickMembers
    ),


  // BAN
  new SlashCommandBuilder()

    .setName(
      "ban"
    )

    .setDescription(
      "Bannit définitivement un membre"
    )

    .addUserOption(
      o =>
        o
          .setName(
            "membre"
          )
          .setDescription(
            "Le membre à bannir"
          )
          .setRequired(
            true
          )
    )

    .addStringOption(
      o =>
        o
          .setName(
            "raison"
          )
          .setDescription(
            "Raison du bannissement"
          )
          .setRequired(
            false
          )
    )

    .addAttachmentOption(
      o =>
        o
          .setName(
            "preuve"
          )
          .setDescription(
            "Preuve du bannissement"
          )
          .setRequired(
            false
          )
    )

    .setDefaultMemberPermissions(
      PermissionFlagsBits.BanMembers
    ),


  // TEMPBAN
  new SlashCommandBuilder()

    .setName(
      "tempban"
    )

    .setDescription(
      "Bannit temporairement un membre"
    )

    .addUserOption(
      o =>
        o
          .setName(
            "membre"
          )
          .setDescription(
            "Le membre à bannir"
          )
          .setRequired(
            true
          )
    )

    .addStringOption(
      o =>
        o
          .setName(
            "duree"
          )
          .setDescription(
            "Exemples : 1d, 4d, 7d, 14d, 28d"
          )
          .setRequired(
            true
          )
    )

    .addStringOption(
      o =>
        o
          .setName(
            "raison"
          )
          .setDescription(
            "Raison du bannissement"
          )
          .setRequired(
            false
          )
    )

    .addAttachmentOption(
      o =>
        o
          .setName(
            "preuve"
          )
          .setDescription(
            "Preuve du bannissement"
          )
          .setRequired(
            false
          )
    )

    .setDefaultMemberPermissions(
      PermissionFlagsBits.BanMembers
    ),


  // TIMEOUT
  new SlashCommandBuilder()

    .setName(
      "timeout"
    )

    .setDescription(
      "Exclut temporairement un membre"
    )

    .addUserOption(
      o =>
        o
          .setName(
            "membre"
          )
          .setDescription(
            "Le membre à exclure"
          )
          .setRequired(
            true
          )
    )

    .addStringOption(
      o =>
        o
          .setName(
            "duree"
          )
          .setDescription(
            "Exemples : 5m, 1h, 1d, 4d, 28d"
          )
          .setRequired(
            true
          )
    )

    .addStringOption(
      o =>
        o
          .setName(
            "raison"
          )
          .setDescription(
            "Raison du timeout"
          )
          .setRequired(
            false
          )
    )

    .addAttachmentOption(
      o =>
        o
          .setName(
            "preuve"
          )
          .setDescription(
            "Preuve du timeout"
          )
          .setRequired(
            false
          )
    )

    .setDefaultMemberPermissions(
      PermissionFlagsBits.ModerateMembers
    ),


  // WARN
  new SlashCommandBuilder()

    .setName(
      "warn"
    )

    .setDescription(
      "Avertit un membre"
    )

    .addUserOption(
      o =>
        o
          .setName(
            "membre"
          )
          .setDescription(
            "Le membre à avertir"
          )
          .setRequired(
            true
          )
    )

    .addStringOption(
      o =>
        o
          .setName(
            "raison"
          )
          .setDescription(
            "Raison de l'avertissement"
          )
          .setRequired(
            false
          )
    )

    .addAttachmentOption(
      o =>
        o
          .setName(
            "preuve"
          )
          .setDescription(
            "Preuve de l'avertissement"
          )
          .setRequired(
            false
          )
    )

    .setDefaultMemberPermissions(
      PermissionFlagsBits.ModerateMembers
    ),


  // WARNINGS
  new SlashCommandBuilder()

    .setName(
      "warnings"
    )

    .setDescription(
      "Affiche les avertissements d'un membre"
    )

    .addUserOption(
      o =>
        o
          .setName(
            "membre"
          )
          .setDescription(
            "Le membre"
          )
          .setRequired(
            true
          )
    )

    .setDefaultMemberPermissions(
      PermissionFlagsBits.ModerateMembers
    ),


  // CLEAR WARNINGS
  new SlashCommandBuilder()

    .setName(
      "clearwarnings"
    )

    .setDescription(
      "Supprime les avertissements d'un membre"
    )

    .addUserOption(
      o =>
        o
          .setName(
            "membre"
          )
          .setDescription(
            "Le membre"
          )
          .setRequired(
            true
          )
    )

    .setDefaultMemberPermissions(
      PermissionFlagsBits.ModerateMembers
    ),


  // UNBAN
  new SlashCommandBuilder()

    .setName(
      "unban"
    )

    .setDescription(
      "Débannit un membre"
    )

    .addStringOption(
      o =>
        o
          .setName(
            "membre"
          )
          .setDescription(
            "ID du membre à débannir"
          )
          .setRequired(
            true
          )
    )

    .addStringOption(
      o =>
        o
          .setName(
            "raison"
          )
          .setDescription(
            "Raison du débannissement"
          )
          .setRequired(
            false
          )
    )

    .setDefaultMemberPermissions(
      PermissionFlagsBits.BanMembers
    ),


  // CASE
  new SlashCommandBuilder()

    .setName(
      "case"
    )

    .setDescription(
      "Affiche les informations d'une case"
    )

    .addIntegerOption(
      o =>
        o
          .setName(
            "numero"
          )
          .setDescription(
            "Numéro de la case"
          )
          .setRequired(
            true
          )
    )

    .setDefaultMemberPermissions(
      PermissionFlagsBits.ModerateMembers
    ),


  // CLEAR
  new SlashCommandBuilder()

    .setName(
      "clear"
    )

    .setDescription(
      "Supprime un nombre de messages"
    )

    .addIntegerOption(
      o =>
        o
          .setName(
            "nombre"
          )
          .setDescription(
            "Nombre de messages à supprimer (1-100)"
          )
          .setRequired(
            true
          )
          .setMinValue(
            1
          )
          .setMaxValue(
            100
          )
    )

    .setDefaultMemberPermissions(
      PermissionFlagsBits.ManageMessages
    ),


  // TICKET PANEL
  new SlashCommandBuilder()

    .setName(
      "ticket-panel"
    )

    .setDescription(
      "Affiche le panneau de création de tickets"
    )

    .setDefaultMemberPermissions(
      PermissionFlagsBits.Administrator
    )

].map(
  command =>
    command.toJSON()
);


// ======================================================
// READY
// ======================================================

client.once(
  "ready",
  async () => {

    console.log(
      `✅ ${client.user.tag} est connecté !`
    );

    try {

      for (
        const guild
        of client.guilds.cache.values()
      ) {

        await guild.commands.set(
          commands
        );
      }

      console.log(
        "✅ Commandes slash enregistrées !"
      );

      await restoreTempBans();

      // Restaurer les données des vocales privées
      restoreVocalData();
      console.log(
        "✅ Vocales privées restaurées !"
      );

    } catch (error) {

      console.error(
        "Erreur lors de l'initialisation :",
        error
      );
    }
  }
);


// ======================================================
// INTERACTIONS
// ======================================================

client.on(
  "interactionCreate",
  async interaction => {

    const {
      guild,
      member
    } = interaction;

    if (!guild) {
      return;
    }


    // ==================================================
    // COMMANDES SLASH
    // ==================================================

    if (
      interaction.isChatInputCommand()
    ) {

      const {
        commandName,
        options
      } = interaction;


      // ================================================
      // KICK
      // ================================================

      if (
        commandName ===
        "kick"
      ) {

        const target =
          options.getUser(
            "membre"
          );

        const reason =
          options.getString(
            "raison"
          ) ||
          "Aucune raison fournie";

        const proof =
          options.getAttachment(
            "preuve"
          );

        const targetMember =
          await guild.members
            .fetch(
              target.id
            )
            .catch(
              () => null
            );

        if (!targetMember) {

          return interaction.reply({
            content:
              "❌ Membre introuvable.",

            ephemeral:
              true
          });
        }

        if (
          !targetMember.kickable
        ) {

          return interaction.reply({
            content:
              "❌ Je ne peux pas expulser ce membre.",

            ephemeral:
              true
          });
        }

        markBotAction(
          guild.id,
          target.id,
          "kick"
        );

        await targetMember.kick(
          reason
        );

        await interaction.reply(
          `👢 **${target.tag}** a été expulsé.`
        );

        await sendModerationLog({

          guild,

          title:
            "👢 Exclusion",

          color:
            0xED4245,

          type:
            "kick",

          memberUser:
            target,

          moderator:
            member.user,

          reason,

          proof
        });

        return;
      }


      // ================================================
      // BAN
      // ================================================

      if (
        commandName ===
        "ban"
      ) {

        const target =
          options.getUser(
            "membre"
          );

        const reason =
          options.getString(
            "raison"
          ) ||
          "Aucune raison fournie";

        const proof =
          options.getAttachment(
            "preuve"
          );

        const targetMember =
          await guild.members
            .fetch(
              target.id
            )
            .catch(
              () => null
            );

        if (
          targetMember &&
          !targetMember.bannable
        ) {

          return interaction.reply({
            content:
              "❌ Je ne peux pas bannir ce membre.",

            ephemeral:
              true
          });
        }

        markBotAction(
          guild.id,
          target.id,
          "ban"
        );

        await guild.members.ban(
          target.id,
          {
            reason
          }
        );

        await interaction.reply(
          `🔨 **${target.tag}** a été banni définitivement.`
        );

        await sendModerationLog({

          guild,

          title:
            "🔨 Bannissement",

          color:
            0xED4245,

          type:
            "ban",

          memberUser:
            target,

          moderator:
            member.user,

          reason,

          proof
        });

        return;
      }


      // ================================================
      // TEMPBAN
      // ================================================

      if (
        commandName ===
        "tempban"
      ) {

        const target =
          options.getUser(
            "membre"
          );

        const durationInput =
          options.getString(
            "duree"
          );

        const reason =
          options.getString(
            "raison"
          ) ||
          "Aucune raison fournie";

        const proof =
          options.getAttachment(
            "preuve"
          );

        const durationMs =
          parseDuration(
            durationInput
          );

        if (!durationMs) {

          return interaction.reply({
            content:
              "❌ Durée invalide. Utilise par exemple `1d`, `4d`, `7d`, `14d` ou `28d`.",

            ephemeral:
              true
          });
        }

        const targetMember =
          await guild.members
            .fetch(
              target.id
            )
            .catch(
              () => null
            );

        if (
          targetMember &&
          !targetMember.bannable
        ) {

          return interaction.reply({
            content:
              "❌ Je ne peux pas bannir ce membre.",

            ephemeral:
              true
          });
        }

        const expiresAt =
          Date.now() +
          durationMs;

        markBotAction(
          guild.id,
          target.id,
          "ban"
        );

        await guild.members.ban(
          target.id,
          {
            reason:
              `Tempban ${formatDuration(durationMs)} — ${reason}`
          }
        );

        addTempBan(
          guild.id,
          target.id,
          expiresAt
        );

        scheduleTempBan(
          guild,
          target.id,
          expiresAt
        );

        await interaction.reply(
          `⏳ **${target.tag}** a été banni pendant **${formatDuration(durationMs)}**.`
        );

        await sendModerationLog({

          guild,

          title:
            "🔨 Bannissement temporaire",

          color:
            0xED4245,

          type:
            "tempban",

          memberUser:
            target,

          moderator:
            member.user,

          reason,

          duration:
            formatDuration(
              durationMs
            ),

          expires:
            new Date(
              expiresAt
            ),

          proof
        });

        return;
      }


      // ================================================
      // TIMEOUT
      // ================================================

      if (
        commandName ===
        "timeout"
      ) {

        const target =
          options.getUser(
            "membre"
          );

        const durationInput =
          options.getString(
            "duree"
          );

        const reason =
          options.getString(
            "raison"
          ) ||
          "Aucune raison fournie";

        const proof =
          options.getAttachment(
            "preuve"
          );

        const durationMs =
          parseDuration(
            durationInput
          );

        if (!durationMs) {

          return interaction.reply({
            content:
              "❌ Durée invalide. Utilise `5m`, `1h`, `1d`, `4d`, etc.",

            ephemeral:
              true
          });
        }

        if (
          durationMs >
          28 *
          24 *
          60 *
          60 *
          1000
        ) {

          return interaction.reply({
            content:
              "❌ Un timeout Discord ne peut pas dépasser 28 jours.",

            ephemeral:
              true
          });
        }

        const targetMember =
          await guild.members
            .fetch(
              target.id
            )
            .catch(
              () => null
            );

        if (!targetMember) {

          return interaction.reply({
            content:
              "❌ Membre introuvable.",

            ephemeral:
              true
          });
        }

        if (
          !targetMember.moderatable
        ) {

          return interaction.reply({
            content:
              "❌ Je ne peux pas exclure ce membre.",

            ephemeral:
              true
          });
        }

        const expiresAt =
          Date.now() +
          durationMs;

        markBotAction(
          guild.id,
          target.id,
          "timeout"
        );

        await targetMember.timeout(
          durationMs,
          reason
        );

        await interaction.reply(
          `⏳ **${target.tag}** a été exclu pendant **${formatDuration(durationMs)}**.`
        );

        await sendModerationLog({

          guild,

          title:
            "🔨 Exclusion (timeout)",

          color:
            0xFEE75C,

          type:
            "timeout",

          memberUser:
            target,

          moderator:
            member.user,

          reason,

          duration:
            formatDuration(
              durationMs
            ),

          expires:
            new Date(
              expiresAt
            ),

          proof
        });

        return;
      }


      // ================================================
      // WARN
      // ================================================

      if (
        commandName ===
        "warn"
      ) {

        const target =
          options.getUser(
            "membre"
          );

        const reason =
          options.getString(
            "raison"
          ) ||
          "Aucune raison fournie";

        const proof =
          options.getAttachment(
            "preuve"
          );

        const warningsBefore =
          getWarnings(
            guild.id,
            target.id
          ).length;

        const caseNumber =
          createCase(
            guild.id,
            {

              type:
                "warn",

              userId:
                target.id,

              userTag:
                target.tag,

              moderatorId:
                member.user.id,

              moderatorTag:
                member.user.tag,

              reason,

              duration:
                null,

              expiresAt:
                null,

              proof:
                proof?.url ??
                null
            }
          );

        await interaction.reply(
          `⚠️ **${target.tag}** a reçu un avertissement. (Warn #${warningsBefore + 1})`
        );

        const channel =
          getLogChannel(
            guild,
            MODERATION_LOG_CHANNEL_NAME
          );

        if (channel) {

          const embed =
            new EmbedBuilder()

              .setTitle(
                "⚠️ Avertissement"
              )

              .setColor(
                0xFEE75C
              )

              .setThumbnail(
                target.displayAvatarURL({
                  extension:
                    "png",

                  size:
                    256
                })
              )

              .addFields(

                {
                  name:
                    "👤 Membre",

                  value:
                    `${target.tag} (\`${target.id}\`)`,

                  inline:
                    false
                },

                {
                  name:
                    "🛡️ Modérateur",

                  value:
                    `${member.user.tag} (\`${member.user.id}\`)`,

                  inline:
                    false
                },

                {
                  name:
                    "🔢 Nombre de warns",

                  value:
                    `${warningsBefore + 1}`,

                  inline:
                    true
                },

                {
                  name:
                    "📝 Raison",

                  value:
                    cleanText(
                      reason
                    ),

                  inline:
                    false
                }
              );

          if (proof) {

            embed.addFields({
              name:
                "📎 Preuves",

              value:
                `[Voir la preuve](${proof.url})`,

              inline:
                false
            });
          }

          embed

            .addFields({
              name:
                "📁 Case",

              value:
                `#${caseNumber}`,

              inline:
                false
            })

            .setFooter({
              text:
                `Case #${caseNumber}`
            })

            .setTimestamp();

          await channel.send({
            embeds:
              [embed]
          }).catch(
            () => {}
          );
        }

        return;
      }


      // ================================================
      // WARNINGS
      // ================================================

      if (
        commandName ===
        "warnings"
      ) {

        const target =
          options.getUser(
            "membre"
          );

        const warnings =
          getWarnings(
            guild.id,
            target.id
          );

        if (
          !warnings.length
        ) {

          return interaction.reply({
            content:
              `✅ **${target.tag}** n'a aucun avertissement enregistré.`,

            ephemeral:
              true
          });
        }

        const description =
          warnings
            .slice(-10)
            .map(
              w =>
                `**Case #${w.case}** — ${w.reason}\n> Modérateur : ${w.moderatorTag} • ${formatDiscordDate(w.createdAt)}`
            )
            .join(
              "\n\n"
            );

        const embed =
          new EmbedBuilder()

            .setTitle(
              `⚠️ Avertissements — ${target.tag}`
            )

            .setDescription(
              description
            )

            .setThumbnail(
              target.displayAvatarURL({
                extension:
                  "png",

                size:
                  256
              })
            )

            .setColor(
              0xFEE75C
            )

            .setFooter({
              text:
                `${warnings.length} avertissement(s) enregistré(s)`
            })

            .setTimestamp();

        return interaction.reply({
          embeds:
            [embed],

          ephemeral:
            true
        });
      }


      // ================================================
      // CLEAR WARNINGS
      // ================================================

      if (
        commandName ===
        "clearwarnings"
      ) {

        const target =
          options.getUser(
            "membre"
          );

        const count =
          clearWarnings(
            guild.id,
            target.id
          );

        if (!count) {

          return interaction.reply({
            content:
              `ℹ️ **${target.tag}** n'a aucun avertissement à supprimer.`,

            ephemeral:
              true
          });
        }

        await interaction.reply(
          `🧹 **${count}** avertissement(s) supprimé(s) pour **${target.tag}**.`
        );

        await sendLog(

          guild,

          "🧹 Avertissements supprimés",

          null,

          MODERATION_LOG_CHANNEL_NAME,

          [

            {
              name:
                "👤 Membre",

              value:
                `${target.tag} (\`${target.id}\`)`,

              inline:
                false
            },

            {
              name:
                "🛡️ Modérateur",

              value:
                `${member.user.tag} (\`${member.user.id}\`)`,

              inline:
                false
            },

            {
              name:
                "🔢 Nombre",

              value:
                `${count}`,

              inline:
                true
            }
          ],

          0x57F287
        );

        return;
      }


      // ================================================
      // UNBAN
      // ================================================

      if (
        commandName ===
        "unban"
      ) {

        const userId =
          options.getString(
            "membre"
          );

        const reason =
          options.getString(
            "raison"
          ) ||
          "Aucune raison fournie";

        const user =
          await client.users
            .fetch(
              userId
            )
            .catch(
              () => null
            );

        if (!user) {

          return interaction.reply({
            content:
              "❌ Utilisateur introuvable.",

            ephemeral:
              true
          });
        }

        const ban =
          await guild.bans
            .fetch(
              user.id
            )
            .catch(
              () => null
            );

        if (!ban) {

          return interaction.reply({
            content:
              "ℹ️ Cet utilisateur n'est pas banni.",

            ephemeral:
              true
          });
        }

        markBotAction(
          guild.id,
          user.id,
          "unban"
        );

        removeTempBan(
          guild.id,
          user.id
        );

        await guild.members.unban(
          user.id,
          reason
        );

        await interaction.reply(
          `🔓 **${user.tag}** a été débanni.`
        );

        await sendModerationLog({

          guild,

          title:
            "🔓 Débannissement",

          color:
            0x57F287,

          type:
            "unban",

          memberUser:
            user,

          moderator:
            member.user,

          reason
        });

        return;
      }


      // ================================================
      // CASE
      // ================================================

      if (
        commandName ===
        "case"
      ) {

        const number =
          options.getInteger(
            "numero"
          );

        const record =
          findCase(
            guild.id,
            number
          );

        if (!record) {

          return interaction.reply({
            content:
              `❌ La case **#${number}** n'existe pas.`,

            ephemeral:
              true
          });
        }

        const embed =
          new EmbedBuilder()

            .setTitle(
              `📁 Case #${record.case}`
            )

            .setColor(
              0x5865F2
            )

            .addFields(

              {
                name:
                  "🔨 Type",

                value:
                  record.type ||
                  "Inconnu",

                inline:
                  true
              },

              {
                name:
                  "👤 Membre",

                value:
                  `${record.userTag || "Inconnu"} (\`${record.userId || "Inconnu"}\`)`,

                inline:
                  false
              },

              {
                name:
                  "🛡️ Modérateur",

                value:
                  `${record.moderatorTag || "Inconnu"} (\`${record.moderatorId || "Inconnu"}\`)`,

                inline:
                  false
              },

              {
                name:
                  "📝 Raison",

                value:
                  cleanText(
                    record.reason
                  ),

                inline:
                  false
              },

              {
                name:
                  "🕐 Date",

                value:
                  formatDiscordDate(
                    record.createdAt
                  ),

                inline:
                  true
              }
            )

            .setTimestamp();

        if (
          record.duration
        ) {

          embed.addFields({
            name:
              "⏱️ Durée",

            value:
              record.duration,

            inline:
              true
          });
        }

        if (
          record.expiresAt
        ) {

          embed.addFields({
            name:
              "📅 Expire",

            value:
              formatDiscordDate(
                record.expiresAt
              ),

            inline:
              true
          });
        }

        if (
          record.proof
        ) {

          embed.addFields({
            name:
              "📎 Preuve",

            value:
              `[Voir la preuve](${record.proof})`,

            inline:
              false
          });
        }

        return interaction.reply({
          embeds:
            [embed],

          ephemeral:
            true
        });
      }


      // ================================================
      // CLEAR
      // ================================================

      if (
        commandName ===
        "clear"
      ) {

        const nombre =
          options.getInteger(
            "nombre"
          );

        const deleted =
          await interaction.channel
            .bulkDelete(
              nombre,
              true
            )
            .catch(
              () => null
            );

        if (!deleted) {

          return interaction.reply({
            content:
              "❌ Impossible de supprimer ces messages. Certains peuvent avoir plus de 14 jours.",

            ephemeral:
              true
          });
        }

        await interaction.reply({

          content:
            `🧹 ${deleted.size} messages supprimés.`,

          ephemeral:
            true
        });

        const clearEmbed =
          new EmbedBuilder()

            .setAuthor({

              name:
                member.user.tag,

              iconURL:
                member.user.displayAvatarURL()
            })

            .setTitle(
              "🧹 Messages supprimés"
            )

            .addFields(

              {
                name:
                  "🛡️ Modérateur",

                value:
                  `${member.user}`,

                inline:
                  true
              },

              {
                name:
                  "📍 Salon",

                value:
                  `${interaction.channel}`,

                inline:
                  true
              },

              {
                name:
                  "🔢 Nombre",

                value:
                  `${deleted.size}`,

                inline:
                  true
              }
            )

            .setThumbnail(
              member.user.displayAvatarURL({
                extension:
                  "png",

                size:
                  256
              })
            )

            .setColor(
              0x5865F2
            )

            .setFooter({

              text:
                `${guild.name} • Support & Logs`,

              iconURL:
                guild.iconURL()
            })

            .setTimestamp();

        const clearLogChannel =
          getLogChannel(
            guild,
            MODERATION_LOG_CHANNEL_NAME
          );

        if (clearLogChannel) {

          await clearLogChannel.send({
            embeds:
              [clearEmbed]
          }).catch(
            () => {}
          );
        }

        return;
      }


      // ================================================
      // TICKET PANEL
      // ================================================

      if (
        commandName ===
        "ticket-panel"
      ) {

        await interaction.channel.send(
          buildTicketPanel()
        );

        await interaction.reply({

          content:
            "✅ Panneau de tickets envoyé.",

          ephemeral:
            true
        });

        return;
      }
    }


    // ==================================================
    // MENU TICKET
    // ==================================================

    if (
      interaction.isStringSelectMenu() &&
      interaction.customId ===
        "ticket_category_select"
    ) {

      const category =
        TICKET_CATEGORIES.find(
          c =>
            c.value ===
            interaction.values[0]
        );

      if (!category) {
        return;
      }

      if (
        category.hasSubcategories
      ) {

        const subEmbed =
          new EmbedBuilder()

            .setTitle(
              "📋 Candidature"
            )

            .setDescription(

              "Pour quel secteur souhaitez-vous postuler ?\n\n" +

              CANDIDATURE_SUBCATEGORIES
                .map(
                  s =>
                    `${s.emoji} — **${s.label}**`
                )
                .join(
                  "\n"
                ) +

              "\n\nSélectionnez une option ci-dessous pour ouvrir votre ticket de candidature."
            )

            .setColor(
              0x5865F2
            );

        const subMenu =
          new StringSelectMenuBuilder()

            .setCustomId(
              "candidature_subcategory_select"
            )

            .setPlaceholder(
              "Sélectionnez le secteur visé"
            )

            .addOptions(
              CANDIDATURE_SUBCATEGORIES.map(
                s => ({

                  label:
                    s.label,

                  value:
                    s.value,

                  emoji:
                    s.emoji,

                  description:
                    s.description
                })
              )
            );

        return interaction.reply({

          embeds:
            [subEmbed],

          components:
            [
              new ActionRowBuilder()
                .addComponents(
                  subMenu
                )
            ],

          ephemeral:
            true
        });
      }

      await interaction.deferReply({
        ephemeral:
          true
      });

      await createTicketChannel(
        interaction,
        guild,
        category
      );

      return;
    }


    // ==================================================
    // SOUS-CATÉGORIE
    // ==================================================

    if (
      interaction.isStringSelectMenu() &&
      interaction.customId ===
        "candidature_subcategory_select"
    ) {

      const subCategory =
        CANDIDATURE_SUBCATEGORIES.find(
          s =>
            s.value ===
            interaction.values[0]
        );

      if (!subCategory) {
        return;
      }

      await interaction.deferReply({
        ephemeral:
          true
      });

      await createTicketChannel(
        interaction,
        guild,
        subCategory
      );

      return;
    }


    // ==================================================
    // FERMETURE TICKET
    // ==================================================

    if (
      interaction.isButton() &&
      interaction.customId ===
        "close_ticket"
    ) {

      await interaction.reply({

        content:
          "🔒 Ce ticket sera fermé dans 5 secondes..."
      });

      const ticketLogChannel =
        getLogChannel(
          guild,
          TICKET_LOG_CHANNEL_NAME
        );

      if (
        ticketLogChannel
      ) {

        try {

          // Récupère le créateur du ticket (stocké dans le topic du salon)
          const topicMatch =
            interaction.channel.topic?.match(
              /ticket-creator:(\d+)/
            );

          const creatorId =
            topicMatch?.[1] ??
            null;

          const creator =
            creatorId
              ? await client.users
                  .fetch(
                    creatorId
                  )
                  .catch(
                    () => null
                  )
              : null;

          const {
            text:
              transcriptText,

            participantIds
          } =
            await generateTranscript(
              interaction.channel
            );

          const transcript =
            new AttachmentBuilder(

              Buffer.from(
                transcriptText,
                "utf-8"
              ),

              {
                name:
                  `transcript-${interaction.channel.name}.txt`
              }
            );

          const allParticipantIds =
            [
              ...new Set(
                [
                  ...(creatorId ? [creatorId] : []),
                  ...participantIds
                ]
              )
            ];

          const participantsText =
            allParticipantIds.length
              ? allParticipantIds
                  .map(
                    id =>
                      `<@${id}>`
                  )
                  .join(", ")
              : "Aucun";

          const closeEmbed =
            new EmbedBuilder()

              .setTitle(
                "🎟️ Ticket fermé"
              )

              .setDescription(
                `Un ticket a été fermé par **${member.user.tag}**. Vous pouvez consulter le transcript ci-dessous :`
              )

              .addFields(

                {
                  name:
                    "👤 Membre",

                  value:
                    creator
                      ? `${creator}`
                      : "Utilisateur inconnu",

                  inline:
                    false
                },

                {
                  name:
                    "🆔 ID du ticket",

                  value:
                    interaction.channel.name,

                  inline:
                    false
                },

                {
                  name:
                    "👥 Participants",

                  value:
                    cleanText(
                      participantsText
                    ),

                  inline:
                    false
                }
              )

              .setThumbnail(

                (
                  creator ||
                  member.user
                ).displayAvatarURL({
                  extension:
                    "png",

                  size:
                    256
                })
              )

              .setColor(
                0x5865F2
              )

              .setFooter({

                text:
                  `${guild.name} • Support & Logs`,

                iconURL:
                  guild.iconURL()
              })

              .setTimestamp();

          const sentMessage =
            await ticketLogChannel.send({

              embeds:
                [closeEmbed],

              files:
                [transcript]
            });

          const transcriptURL =
            sentMessage.attachments
              .first()
              ?.url;

          if (
            transcriptURL
          ) {

            closeEmbed.addFields({

              name:
                "📄 Transcript",

              value:
                `[Voir le transcript](${transcriptURL})`,

              inline:
                false
            });

            await sentMessage.edit({
              embeds:
                [closeEmbed]
            }).catch(
              () => {}
            );
          }

        } catch (error) {

          console.error(
            "Erreur génération transcript :",
            error
          );

          await sendLog(

            guild,

            "🎟️ Ticket fermé",

            `Un ticket a été fermé par **${member.user.tag}**.\n⚠️ Transcript non généré.`,

            TICKET_LOG_CHANNEL_NAME,

            [

              {
                name:
                  "🆔 ID du ticket",

                value:
                  interaction.channel.name,

                inline:
                  false
              }
            ],

            0x5865F2
          );
        }
      }

      setTimeout(
        () => {

          interaction.channel
            .delete()
            .catch(
              () => {}
            );

        },

        5000
      );

      return;
    }


    // ==================================================
    // SYSTÈME DE VOCALES PRIVÉES — BOUTONS
    // ==================================================

    if (
      interaction.isButton() &&
      interaction.customId.startsWith("vc_")
    ) {

      const customId = interaction.customId;

      // Le panel est dans le chat de la vocale, donc interaction.channel = le salon vocal
      const voiceChannel = interaction.channel;
      const voiceChannelId = voiceChannel.id;

      if (
        !privateVoiceChannels.has(
          voiceChannelId
        )
      ) {
        await interaction.reply({
          content:
            "❌ Ce salon n'est pas une vocale privée.",
          ephemeral: true
        });
        return;
      }

      const info =
        privateVoiceChannels.get(
          voiceChannelId
        );

      // Vérification propriétaire (sauf pour claim)
      if (
        customId !== "vc_claim" &&
        !isVoiceOwner(
          voiceChannelId,
          interaction.user.id
        )
      ) {
        await interaction.reply({
          content:
            "❌ Seul le propriétaire peut gérer ce salon.",
          ephemeral: true
        });
        return;
      }


      // ================================================
      // RENOMMER — Ouvre un modal
      // ================================================
      if (customId === "vc_rename") {
        const modal =
          new ModalBuilder()
            .setCustomId(
              "vc_rename_modal"
            )
            .setTitle(
              "📝 Renommer le salon"
            );

        const nameInput =
          new TextInputBuilder()
            .setCustomId(
              "vc_name_input"
            )
            .setLabel(
              "Nouveau nom du salon"
            )
            .setStyle(
              TextInputStyle.Short
            )
            .setPlaceholder(
              "Mon salon cool"
            )
            .setRequired(true)
            .setMinLength(1)
            .setMaxLength(100);

        modal.addComponents(
          new ActionRowBuilder().addComponents(
            nameInput
          )
        );

        await interaction.showModal(
          modal
        );
        return;
      }


      // ================================================
      // LIMITE — Ouvre un modal
      // ================================================
      if (customId === "vc_limit") {
        const modal =
          new ModalBuilder()
            .setCustomId(
              "vc_limit_modal"
            )
            .setTitle(
              "👥 Modifier la limite"
            );

        const limitInput =
          new TextInputBuilder()
            .setCustomId(
              "vc_limit_input"
            )
            .setLabel(
              "Nombre maximum de membres (1-99)"
            )
            .setStyle(
              TextInputStyle.Short
            )
            .setPlaceholder(
              "2"
            )
            .setRequired(true)
            .setMinLength(1)
            .setMaxLength(2);

        modal.addComponents(
          new ActionRowBuilder().addComponents(
            limitInput
          )
        );

        await interaction.showModal(
          modal
        );
        return;
      }


      // ================================================
      // QUALITÉ — Menu sélection bitrate
      // ================================================
      if (customId === "vc_quality") {
        const row =
          new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId(
                "vc_quality_select"
              )
              .setPlaceholder(
                "Choisis la qualité audio"
              )
              .addOptions(
                {
                  label:
                    "64 kbps (Faible)",
                  value: "64000",
                  description:
                    "Basse qualité, moins de données",
                  emoji: "🔉"
                },
                {
                  label:
                    "96 kbps (Moyen)",
                  value: "96000",
                  description:
                    "Qualité standard",
                  emoji: "🔊"
                },
                {
                  label:
                    "128 kbps (Élevé)",
                  value: "128000",
                  description:
                    "Haute qualité",
                  emoji: "🎧"
                },
                {
                  label:
                    "256 kbps (Très élevé)",
                  value: "256000",
                  description:
                    "Qualité maximale",
                  emoji: "🎙️"
                },
                {
                  label:
                    "384 kbps (Ultra)",
                  value: "384000",
                  description:
                    "Qualité ultra (serveur boosté)",
                  emoji: "💎"
                }
              )
          );

        await interaction.reply({
          content:
            "🎵 Choisis la qualité audio du salon :",
          components: [row],
          ephemeral: true
        });
        return;
      }


      // ================================================
      // VERROUILLER
      // ================================================
      if (customId === "vc_lock") {
        await voiceChannel.permissionOverwrites.edit(
          interaction.guild.roles.everyone,
          {
            Connect: false
          }
        );

        info.locked = true;
        privateVoiceChannels.set(
          voiceChannelId,
          info
        );
        saveVocalData();

        await updateVoicePanel(
          voiceChannel
        );

        await interaction.reply({
          content:
            "🔒 Salon verrouillé ! Personne ne peut rejoindre.",
          ephemeral: true
        });
        return;
      }


      // ================================================
      // DÉVERROUILLER
      // ================================================
      if (customId === "vc_unlock") {
        await voiceChannel.permissionOverwrites.edit(
          interaction.guild.roles.everyone,
          {
            Connect: null
          }
        );

        info.locked = false;
        privateVoiceChannels.set(
          voiceChannelId,
          info
        );
        saveVocalData();

        await updateVoicePanel(
          voiceChannel
        );

        await interaction.reply({
          content:
            "🔓 Salon déverrouillé ! Tout le monde peut rejoindre.",
          ephemeral: true
        });
        return;
      }


      // ================================================
      // MASQUER
      // ================================================
      if (customId === "vc_hide") {
        await voiceChannel.permissionOverwrites.edit(
          interaction.guild.roles.everyone,
          {
            ViewChannel: false
          }
        );

        info.hidden = true;
        privateVoiceChannels.set(
          voiceChannelId,
          info
        );
        saveVocalData();

        await updateVoicePanel(
          voiceChannel
        );

        await interaction.reply({
          content:
            "👁️ Salon masqué ! Les autres ne le voient plus.",
          ephemeral: true
        });
        return;
      }


      // ================================================
      // AFFICHER
      // ================================================
      if (customId === "vc_show") {
        await voiceChannel.permissionOverwrites.edit(
          interaction.guild.roles.everyone,
          {
            ViewChannel: null
          }
        );

        info.hidden = false;
        privateVoiceChannels.set(
          voiceChannelId,
          info
        );
        saveVocalData();

        await updateVoicePanel(
          voiceChannel
        );

        await interaction.reply({
          content:
            "👁️‍🗨️ Salon visible ! Tout le monde peut le voir.",
          ephemeral: true
        });
        return;
      }


      // ================================================
      // EXCLURE — Menu sélection membre
      // ================================================
      if (customId === "vc_kick") {
        const members =
          voiceChannel.members.filter(
            m =>
              m.id !== info.ownerId &&
              m.id !== client.user.id
          );

        if (members.size === 0) {
          await interaction.reply({
            content:
              "❌ Aucun membre à exclure.",
            ephemeral: true
          });
          return;
        }

        const options =
          members
            .map(m => ({
              label:
                m.user
                  .username,
              value: m.id,
              description:
                `ID: ${m.id}`
            }))
            .slice(0, 25);

        const row =
          new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId(
                "vc_kick_select"
              )
              .setPlaceholder(
                "Choisis le membre à exclure"
              )
              .addOptions(
                options
              )
          );

        await interaction.reply({
          content:
            "🚫 Choisis le membre à exclure :",
          components: [row],
          ephemeral: true
        });
        return;
      }


      // ================================================
      // BLOQUER — Menu sélection membre
      // ================================================
      if (customId === "vc_block") {
        const members =
          voiceChannel.members.filter(
            m =>
              m.id !== info.ownerId &&
              m.id !== client.user.id
          );

        if (members.size === 0) {
          await interaction.reply({
            content:
              "❌ Aucun membre dans le salon à bloquer.",
            ephemeral: true
          });
          return;
        }

        const options =
          members
            .map(m => ({
              label:
                m.user
                  .username,
              value: m.id,
              description:
                `ID: ${m.id}`
            }))
            .slice(0, 25);

        const row =
          new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId(
                "vc_block_select"
              )
              .setPlaceholder(
                "Choisis le membre à bloquer"
              )
              .addOptions(
                options
              )
          );

        await interaction.reply({
          content:
            "⛔ Choisis le membre à bloquer :",
          components: [row],
          ephemeral: true
        });
        return;
      }


      // ================================================
      // AUTORISER — Menu sélection membre bloqué
      // ================================================
      if (customId === "vc_allow") {
        if (
          !info.blockedUsers ||
          info.blockedUsers.length ===
            0
        ) {
          await interaction.reply({
            content:
              "✅ Aucun membre bloqué.",
            ephemeral: true
          });
          return;
        }

        const options = [];
        for (
          const blockedId
            of info.blockedUsers
        ) {
          const user =
            await client.users
              .fetch(blockedId)
              .catch(
                () => null
              );
          if (user) {
            options.push({
              label:
                user.username,
              value: blockedId,
              description:
                `ID: ${blockedId}`
            });
          }
        }

        if (options.length === 0) {
          await interaction.reply({
            content:
              "✅ Aucun membre bloqué trouvé.",
            ephemeral: true
          });
          return;
        }

        const row =
          new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId(
                "vc_allow_select"
              )
              .setPlaceholder(
                "Choisis le membre à autoriser"
              )
              .addOptions(
                options
              )
          );

        await interaction.reply({
          content:
            "✅ Choisis le membre à autoriser :",
          components: [row],
          ephemeral: true
        });
        return;
      }


      // ================================================
      // RÉCLAMER — Devient propriétaire
      // ================================================
      if (customId === "vc_claim") {
        const currentOwner =
          await interaction.guild.members
            .fetch(info.ownerId)
            .catch(
              () => null
            );

        // Si le propriétaire est encore dans le salon
        if (
          currentOwner &&
          voiceChannel.members.has(
            info.ownerId
          )
        ) {
          await interaction.reply({
            content:
              "❌ Le propriétaire est encore dans le salon.",
            ephemeral: true
          });
          return;
        }

        info.ownerId =
          interaction.user.id;

        // Mettre à jour les permissions
        await voiceChannel.permissionOverwrites.edit(
          interaction.user.id,
          {
            ViewChannel: true,
            Connect: true,
            Speak: true,
            Stream: true,
            UseVAD: true,
            ManageChannels: true
          }
        );

        // Retirer les permissions de l'ancien owner
        if (currentOwner) {
          await voiceChannel.permissionOverwrites.edit(
            info.ownerId,
            {
              ManageChannels: null
            }
          );
        }

        // Mettre à jour les permissions du vocal pour le nouveau propriétaire
        await voiceChannel.permissionOverwrites.edit(
          interaction.user.id,
          {
            ViewChannel: true,
            Connect: true,
            Speak: true,
            Stream: true,
            UseVAD: true,
            ManageChannels: true
          }
        );

        privateVoiceChannels.set(
          voiceChannelId,
          info
        );
        saveVocalData();

        await updateVoicePanel(
          voiceChannel
        );

        await interaction.reply({
          content:
            "👑 Tu es maintenant le propriétaire du salon !",
          ephemeral: true
        });
        return;
      }


      // ================================================
      // TRANSFÉRER — Ouvre un modal
      // ================================================
      if (customId === "vc_transfer") {
        const modal =
          new ModalBuilder()
            .setCustomId(
              "vc_transfer_modal"
            )
            .setTitle(
              "🔄 Transférer la propriété"
            );

        const transferInput =
          new TextInputBuilder()
            .setCustomId(
              "vc_transfer_input"
            )
            .setLabel(
              "ID du nouveau propriétaire"
            )
            .setStyle(
              TextInputStyle.Short
            )
            .setPlaceholder(
              "123456789012345678"
            )
            .setRequired(true);

        modal.addComponents(
          new ActionRowBuilder().addComponents(
            transferInput
          )
        );

        await interaction.showModal(
          modal
        );
        return;
      }
    }


    // ==================================================
    // SYSTÈME DE VOCALES PRIVÉES — MODALS
    // ==================================================

    if (
      interaction.isModalSubmit() &&
      interaction.customId.startsWith(
        "vc_"
      )
    ) {

      const customId =
        interaction.customId;

      // Le panel est dans le chat de la vocale
      const voiceChannel = interaction.channel;
      const voiceChannelId = voiceChannel.id;

      if (
        !privateVoiceChannels.has(
          voiceChannelId
        )
      ) {
        await interaction.reply({
          content:
            "❌ Ce salon n'est pas une vocale privée.",
          ephemeral: true
        });
        return;
      }

      const info =
        privateVoiceChannels.get(
          voiceChannelId
        );

      if (
        !isVoiceOwner(
          voiceChannelId,
          interaction.user.id
        )
      ) {
        await interaction.reply({
          content:
            "❌ Seul le propriétaire peut gérer ce salon.",
          ephemeral: true
        });
        return;
      }


      // ================================================
      // MODAL RENOMMER
      // ================================================
      if (
        customId === "vc_rename_modal"
      ) {
        const newName =
          interaction.fields.getTextInputValue(
            "vc_name_input"
          );

        await voiceChannel.setName(
          newName
        );

        await interaction.reply({
          content:
            `📝 Salon renommé en : **${newName}**`,
          ephemeral: true
        });

        await updateVoicePanel(
          voiceChannel
        );
        return;
      }


      // ================================================
      // MODAL LIMITE
      // ================================================
      if (
        customId === "vc_limit_modal"
      ) {
        const limitStr =
          interaction.fields.getTextInputValue(
            "vc_limit_input"
          );
        const limit =
          parseInt(limitStr, 10);

        if (
          isNaN(limit) ||
          limit < 1 ||
          limit > 99
        ) {
          await interaction.reply({
            content:
              "❌ La limite doit être un nombre entre 1 et 99.",
            ephemeral: true
          });
          return;
        }

        await voiceChannel.setUserLimit(
          limit
        );

        await interaction.reply({
          content:
            `👥 Limite définie à : **${limit}**`,
          ephemeral: true
        });

        await updateVoicePanel(
          voiceChannel
        );
        return;
      }


      // ================================================
      // MODAL TRANSFÉRER
      // ================================================
      if (
        customId ===
          "vc_transfer_modal"
      ) {
        const newOwnerId =
          interaction.fields.getTextInputValue(
            "vc_transfer_input"
          );

        const newOwner =
          await interaction.guild.members
            .fetch(newOwnerId)
            .catch(
              () => null
            );

        if (!newOwner) {
          await interaction.reply({
            content:
              "❌ Membre introuvable. Vérifie l'ID.",
            ephemeral: true
          });
          return;
        }

        // Retirer ManageChannels de l'ancien owner
        await voiceChannel.permissionOverwrites.edit(
          interaction.user.id,
          {
            ManageChannels: null
          }
        );

        // Ajouter les permissions au nouveau owner
        await voiceChannel.permissionOverwrites.edit(
          newOwner.id,
          {
            ViewChannel: true,
            Connect: true,
            Speak: true,
            Stream: true,
            UseVAD: true,
            ManageChannels: true
          }
        );

        // Mettre à jour les permissions du vocal pour le nouveau propriétaire
        await voiceChannel.permissionOverwrites.edit(
          newOwner.id,
          {
            ViewChannel: true,
            Connect: true,
            Speak: true,
            Stream: true,
            UseVAD: true,
            ManageChannels: true
          }
        );

        info.ownerId = newOwner.id;
        privateVoiceChannels.set(
          voiceChannelId,
          info
        );
        saveVocalData();

        await updateVoicePanel(
          voiceChannel
        );

        await interaction.reply({
          content:
            `🔄 Propriété transférée à <@${newOwner.id}> !`,
          ephemeral: true
        });
        return;
      }
    }


    // ==================================================
    // SYSTÈME DE VOCALES PRIVÉES — SELECT MENUS
    // ==================================================

    if (
      interaction.isStringSelectMenu() &&
      interaction.customId.startsWith(
        "vc_"
      )
    ) {

      const customId =
        interaction.customId;
      const selectedValue =
        interaction.values[0];

      // Le panel est dans le chat de la vocale
      const voiceChannel = interaction.channel;
      const voiceChannelId = voiceChannel.id;

      if (
        !privateVoiceChannels.has(
          voiceChannelId
        )
      ) {
        await interaction.reply({
          content:
            "❌ Ce salon n'est pas une vocale privée.",
          ephemeral: true
        });
        return;
      }

      const info =
        privateVoiceChannels.get(
          voiceChannelId
        );

      if (
        customId !== "vc_allow_select" &&
        !isVoiceOwner(
          voiceChannelId,
          interaction.user.id
        )
      ) {
        await interaction.reply({
          content:
            "❌ Seul le propriétaire peut gérer ce salon.",
          ephemeral: true
        });
        return;
      }


      // ================================================
      // QUALITÉ AUDIO
      // ================================================
      if (
        customId ===
          "vc_quality_select"
      ) {
        const bitrate =
          parseInt(selectedValue, 10);

        await voiceChannel.setBitrate(
          bitrate
        );

        await interaction.update({
          content:
            `🎵 Qualité audio définie à **${bitrate / 1000} kbps** !`,
          components: []
        });
        return;
      }


      // ================================================
      // EXCLURE UN MEMBRE
      // ================================================
      if (
        customId === "vc_kick_select"
      ) {
        const member =
          await interaction.guild.members
            .fetch(selectedValue)
            .catch(
              () => null
            );

        if (
          member &&
          member.voice.channel &&
          member.voice.channel.id ===
            voiceChannelId
        ) {
          await member.voice.setChannel(
            null
          );
        }

        await interaction.update({
          content:
            `🚫 <@${selectedValue}> a été exclu du salon.`,
          components: []
        });
        return;
      }


      // ================================================
      // BLOQUER UN MEMBRE
      // ================================================
      if (
        customId === "vc_block_select"
      ) {
        // Kick le membre d'abord
        const member =
          await interaction.guild.members
            .fetch(selectedValue)
            .catch(
              () => null
            );

        if (
          member &&
          member.voice.channel &&
          member.voice.channel.id ===
            voiceChannelId
        ) {
          await member.voice.setChannel(
            null
          );
        }

        // Bloquer l'accès
        await voiceChannel.permissionOverwrites.edit(
          selectedValue,
          {
            ViewChannel: false,
            Connect: false
          }
        );

        // Ajouter à la liste des bloqués
        if (
          !info.blockedUsers.includes(
            selectedValue
          )
        ) {
          info.blockedUsers.push(
            selectedValue
          );
        }

        privateVoiceChannels.set(
          voiceChannelId,
          info
        );
        saveVocalData();

        await interaction.update({
          content:
            `⛔ <@${selectedValue}> a été bloqué du salon.`,
          components: []
        });
        return;
      }


      // ================================================
      // AUTORISER UN MEMBRE BLOQUÉ
      // ================================================
      if (
        customId === "vc_allow_select"
      ) {
        // Retirer la permission de blocage
        await voiceChannel.permissionOverwrites.edit(
          selectedValue,
          {
            ViewChannel: null,
            Connect: null
          }
        );

        // Retirer de la liste des bloqués
        info.blockedUsers =
          info.blockedUsers.filter(
            id => id !== selectedValue
          );

        privateVoiceChannels.set(
          voiceChannelId,
          info
        );
        saveVocalData();

        await interaction.update({
          content:
            `✅ <@${selectedValue}> a été autorisé à revenir.`,
          components: []
        });
        return;
      }
    }
  }
);


// ======================================================
// VOICE STATE UPDATE — CRÉATION/SUPPRESSION AUTO
// ======================================================

client.on(
  "voiceStateUpdate",
  async (oldState, newState) => {

    // ------------------------------------------------
    // Un membre rejoint un salon hub → créer vocale
    // ------------------------------------------------
    if (
      newState.channel &&
      !oldState.channel
    ) {
      if (VOCAL_HUBS[newState.channel.id]) {
        await createPrivateVoiceChannel(
          newState.member,
          newState.channel
        );
      }
    }

    // ------------------------------------------------
    // Un membre quitte un salon → vérifier si vide
    // ------------------------------------------------
    if (
      oldState.channel &&
      !newState.channel
    ) {
      const channel =
        oldState.channel;

      if (
        privateVoiceChannels.has(
          channel.id
        )
      ) {
        // Vérifier s'il reste des membres
        // (exclure le bot lui-même)
        const humanMembers =
          channel.members.filter(
            m =>
              m.id !==
              client.user.id
          );

        if (
          humanMembers.size === 0
        ) {
          await deletePrivateVoiceChannel(
            channel
          );
        }
      }
    }

    // ------------------------------------------------
    // Un membre bouge d'un salon à un autre
    // → vérifier l'ancien salon (vide ?)
    // → vérifier le nouveau salon (hub ?)
    // ------------------------------------------------
    if (
      oldState.channel &&
      newState.channel &&
      oldState.channel.id !==
        newState.channel.id
    ) {
      // Ancien salon privé vide ?
      if (
        privateVoiceChannels.has(
          oldState.channel.id
        )
      ) {
        const humanMembers =
          oldState.channel.members.filter(
            m =>
              m.id !==
              client.user.id
          );

        if (
          humanMembers.size === 0
        ) {
          await deletePrivateVoiceChannel(
            oldState.channel
          );
        }
      }

      // Nouveau salon = hub ?
      if (VOCAL_HUBS[newState.channel.id]) {
        await createPrivateVoiceChannel(
          newState.member,
          newState.channel
        );
      }
    }
  }
);


// ======================================================
// MEMBRE ARRIVE
// ======================================================

client.on(
  "guildMemberAdd",
  member => {

    const welcomeChannel =
      getLogChannel(
        member.guild,
        WELCOME_CHANNEL_NAME
      );

    if (
      welcomeChannel
    ) {

      const accountAgeDays =
        Math.floor(

          (
            Date.now() -
            member.user.createdTimestamp
          ) /

          86400000
        );

      const welcomeEmbed =
        new EmbedBuilder()

          .setAuthor({

            name:
              member.user.tag,

            iconURL:
              member.user.displayAvatarURL()
          })

          .setTitle(
            "🎉 Nouveau membre sur le serveur !"
          )

          .setDescription(
            `🎉 Bienvenue ${member} sur **${member.guild.name}** !`
          )

          .addFields(

            {
              name:
                "🆔 ID",

              value:
                member.user.id
            },

            {
              name:
                "🕒 Compte créé",

              value:
                `il y a ${accountAgeDays} jour${accountAgeDays !== 1 ? "s" : ""}`
            },

            {
              name:
                "📥 Rejoint",

              value:
                `<t:${Math.floor(
                  Date.now() / 1000
                )}:F>`
            }
          )

          .setThumbnail(
            member.user.displayAvatarURL({
              size:
                256
            })
          )

          .setColor(
            0x57F287
          )

          .setFooter({

            text:
              `Membre #${member.guild.memberCount} | ${member.guild.name}`
          })

          .setTimestamp();

      welcomeChannel.send({

        content:
          `${member}`,

        embeds:
          [welcomeEmbed]

      }).catch(
        () => {}
      );
    }


    const publicWelcomeChannel =
      getLogChannel(
        member.guild,
        PUBLIC_WELCOME_CHANNEL_NAME
      );

    if (
      publicWelcomeChannel
    ) {

      generateWelcomeImage(
        member
      )

        .then(
          buffer =>

            publicWelcomeChannel.send({

              content:
                `👋 Bienvenue ${member} !`,

              files:
                [
                  new AttachmentBuilder(
                    buffer,
                    {
                      name:
                        "bienvenue.png"
                    }
                  )
                ]
            })
        )

        .catch(
          () =>

            publicWelcomeChannel
              .send(
                `👋 Bienvenue ${member} sur **${member.guild.name}** !`
              )

              .catch(
                () => {}
              )
        );
    }
  }
);


// ======================================================
// MEMBRE QUITTE / KICK DIRECT
// ======================================================

client.on(
  "guildMemberRemove",
  async member => {

    if (
      consumeBotAction(
        member.guild.id,
        member.user.id,
        "kick"
      )
    ) {
      return;
    }

    let executor =
      null;

    let reason =
      "A quitté le serveur";

    let wasKick =
      false;

    try {

      const logs =
        await member.guild.fetchAuditLogs({

          type:
            AuditLogEvent.MemberKick,

          limit:
            10
        });

      const entry =
        logs.entries.find(
          e =>

            e.target?.id ===
            member.user.id &&

            Date.now() -
              e.createdTimestamp <
              15000
        );

      if (entry) {

        wasKick =
          true;

        executor =
          entry.executor;

        reason =
          entry.reason ||
          "Aucune raison fournie";
      }

    } catch (error) {

      console.error(
        "Impossible de lire les logs d'audit (kick) :",
        error
      );
    }

    if (
      wasKick
    ) {

      await sendModerationLog({

        guild:
          member.guild,

        title:
          "👢 Exclusion",

        color:
          0xED4245,

        type:
          "kick",

        memberUser:
          member.user,

        moderator:
          executor ||
          {
            tag:
              "Inconnu",

            id:
              "Inconnu"
          },

        reason
      });

      return;
    }

    await sendLog(

      member.guild,

      "👋 Membre parti",

      `**${member.user.tag}** a quitté le serveur.`,

      LOG_CHANNEL_NAME,

      [

        {
          name:
            "👤 Pseudo",

          value:
            member.user.tag,

          inline:
            true
        },

        {
          name:
            "🆔 ID",

          value:
            `\`${member.user.id}\``,

          inline:
            true
        }
      ],

      0xED4245
    );

    const goodbyeChannel =
      getLogChannel(
        member.guild,
        GOODBYE_CHANNEL_NAME
      );

    if (
      goodbyeChannel
    ) {

      const goodbyeEmbed =
        new EmbedBuilder()

          .setAuthor({

            name:
              member.user.tag,

            iconURL:
              member.user.displayAvatarURL()
          })

          .setTitle(
            "😢 Un membre nous quitte..."
          )

          .setDescription(
            `**${member.user.tag}** a quitté **${member.guild.name}**.`
          )

          .addFields(

            {
              name:
                "🆔 ID",

              value:
                member.user.id
            },

            {
              name:
                "👥 Membres restants",

              value:
                `${member.guild.memberCount}`
            }
          )

          .setThumbnail(
            member.user.displayAvatarURL({
              size:
                256
            })
          )

          .setColor(
            0xED4245
          )

          .setFooter({

            text:
              member.guild.name
          })

          .setTimestamp();

      goodbyeChannel.send({

        embeds:
          [goodbyeEmbed]

      }).catch(
        () => {}
      );
    }
  }
);


// ======================================================
// TIMEOUT DIRECTEMENT DEPUIS DISCORD
// ======================================================

client.on(
  "guildMemberUpdate",
  async (
    oldMember,
    newMember
  ) => {

    // ================================================
    // RÔLES AJOUTÉS / RETIRÉS
    // ================================================

    const addedRoles =
      newMember.roles.cache.filter(
        r =>
          !oldMember.roles.cache.has(
            r.id
          )
      );

    const removedRoles =
      oldMember.roles.cache.filter(
        r =>
          !newMember.roles.cache.has(
            r.id
          )
      );

    if (
      addedRoles.size ||
      removedRoles.size
    ) {

      let roleExecutor =
        null;

      try {

        const logs =
          await newMember.guild.fetchAuditLogs({

            type:
              AuditLogEvent.MemberRoleUpdate,

            limit:
              5
          });

        const entry =
          logs.entries.find(
            e =>

              e.target?.id ===
                newMember.user.id &&

              Date.now() -
                e.createdTimestamp <
                15000
          );

        if (entry) {

          roleExecutor =
            entry.executor;
        }

      } catch (error) {

        console.error(
          "Impossible de lire les logs d'audit (rôles) :",
          error
        );
      }

      const roleFields = [

        {
          name:
            "👤 Membre",

          value:
            `${newMember}`,

          inline:
            false
        }
      ];

      if (addedRoles.size) {

        roleFields.push({

          name:
            "✅ Rôle(s) ajouté(s)",

          value:
            addedRoles
              .map(
                r =>
                  `${r}`
              )
              .join(", "),

          inline:
            false
        });
      }

      if (removedRoles.size) {

        roleFields.push({

          name:
            "❌ Rôle(s) retiré(s)",

          value:
            removedRoles
              .map(
                r =>
                  `${r}`
              )
              .join(", "),

          inline:
            false
        });
      }

      roleFields.push({

        name:
          "🛡️ Effectué par",

        value:
          roleExecutor
            ? `${roleExecutor}`
            : "Automatique / inconnu",

        inline:
          false
      });

      await sendLog(

        newMember.guild,

        "🎭 Rôle(s) modifié(s)",

        null,

        LOG_CHANNEL_NAME,

        roleFields,

        0x5865F2
      );
    }


    const oldTimeout =
      oldMember.communicationDisabledUntilTimestamp ||
      null;

    const newTimeout =
      newMember.communicationDisabledUntilTimestamp ||
      null;

    if (
      oldTimeout ===
      newTimeout
    ) {
      return;
    }


    // ================================================
    // TIMEOUT RETIRÉ
    // ================================================

    if (!newTimeout) {

      if (
        consumeBotAction(
          newMember.guild.id,
          newMember.user.id,
          "timeout"
        )
      ) {
        return;
      }

      let executor =
        null;

      let reason =
        "Timeout retiré";

      try {

        const logs =
          await newMember.guild.fetchAuditLogs({

            type:
              AuditLogEvent.MemberUpdate,

            limit:
              10
          });

        const entry =
          logs.entries.find(
            e =>

              e.target?.id ===
              newMember.user.id &&

              Date.now() -
                e.createdTimestamp <
                15000
          );

        if (entry) {

          executor =
            entry.executor;

          reason =
            entry.reason ||
            reason;
        }

      } catch (error) {

        console.error(
          "Audit timeout remove :",
          error
        );
      }

      await sendLog(

        newMember.guild,

        "🔓 Timeout retiré",

        null,

        MODERATION_LOG_CHANNEL_NAME,

        [

          {
            name:
              "👤 Membre",

            value:
              `${newMember.user.tag} (\`${newMember.user.id}\`)`,

            inline:
              false
          },

          {
            name:
              "🛡️ Modérateur",

            value:
              `${executor?.tag || "Inconnu"} (\`${executor?.id || "Inconnu"}\`)`,

            inline:
              false
          },

          {
            name:
              "📝 Raison",

            value:
              reason,

            inline:
              false
          }
        ],

        0x57F287
      );

      return;
    }


    // ================================================
    // TIMEOUT AJOUTÉ PAR LE BOT
    // ================================================

    if (
      consumeBotAction(
        newMember.guild.id,
        newMember.user.id,
        "timeout"
      )
    ) {
      return;
    }


    let executor =
      null;

    let reason =
      "Aucune raison fournie";

    try {

      const logs =
        await newMember.guild.fetchAuditLogs({

          type:
            AuditLogEvent.MemberUpdate,

          limit:
            10
        });

      const entry =
        logs.entries.find(
          e =>

            e.target?.id ===
            newMember.user.id &&

            Date.now() -
              e.createdTimestamp <
              15000
        );

      if (entry) {

        executor =
          entry.executor;

        reason =
          entry.reason ||
          reason;
      }

    } catch (error) {

      console.error(
        "Impossible de lire les logs d'audit (timeout) :",
        error
      );
    }

    const expiresAt =
      new Date(
        newTimeout
      );

    const durationMs =
      newTimeout -
      Date.now();

    await sendModerationLog({

      guild:
        newMember.guild,

      title:
        "🔨 Exclusion (timeout)",

      color:
        0xFEE75C,

      type:
        "timeout",

      memberUser:
        newMember.user,

      moderator:
        executor ||
        {
          tag:
            "Inconnu",

          id:
            "Inconnu"
        },

      reason,

      duration:
        formatDuration(
          durationMs
        ),

      expires:
        expiresAt
    });
  }
);


// ======================================================
// BAN DIRECTEMENT DEPUIS DISCORD
// ======================================================

client.on(
  "guildBanAdd",
  async ban => {

    if (
      consumeBotAction(
        ban.guild.id,
        ban.user.id,
        "ban"
      )
    ) {
      return;
    }

    let executor =
      null;

    let reason =
      ban.reason ||
      "Aucune raison fournie";

    try {

      const logs =
        await ban.guild.fetchAuditLogs({

          type:
            AuditLogEvent.MemberBanAdd,

          limit:
            10
        });

      const entry =
        logs.entries.find(
          e =>

            e.target?.id ===
            ban.user.id &&

            Date.now() -
              e.createdTimestamp <
              15000
        );

      if (entry) {

        executor =
          entry.executor;

        reason =
          entry.reason ||
          reason;
      }

    } catch (error) {

      console.error(
        "Impossible de lire les logs d'audit (ban) :",
        error
      );
    }

    await sendModerationLog({

      guild:
        ban.guild,

      title:
        "🔨 Bannissement",

      color:
        0xED4245,

      type:
        "ban",

      memberUser:
        ban.user,

      moderator:
        executor ||
        {
          tag:
            "Inconnu",

          id:
            "Inconnu"
        },

      reason
    });
  }
);


// ======================================================
// DÉBAN DIRECTEMENT DEPUIS DISCORD
// ======================================================

client.on(
  "guildBanRemove",
  async ban => {

    if (
      consumeBotAction(
        ban.guild.id,
        ban.user.id,
        "unban"
      )
    ) {
      return;
    }

    removeTempBan(
      ban.guild.id,
      ban.user.id
    );

    let executor =
      null;

    let reason =
      "Aucune raison fournie";

    try {

      const logs =
        await ban.guild.fetchAuditLogs({

          type:
            AuditLogEvent.MemberBanRemove,

          limit:
            10
        });

      const entry =
        logs.entries.find(
          e =>

            e.target?.id ===
            ban.user.id &&

            Date.now() -
              e.createdTimestamp <
              15000
        );

      if (entry) {

        executor =
          entry.executor;

        reason =
          entry.reason ||
          reason;
      }

    } catch (error) {

      console.error(
        "Impossible de lire les logs d'audit (déban) :",
        error
      );
    }

    await sendModerationLog({

      guild:
        ban.guild,

      title:
        "🔓 Débannissement",

      color:
        0x57F287,

      type:
        "unban",

      memberUser:
        ban.user,

      moderator:
        executor ||
        {
          tag:
            "Inconnu",

          id:
            "Inconnu"
        },

      reason
    });
  }
);


// ======================================================
// MESSAGE SUPPRIMÉ
// ======================================================

client.on(
  "messageDelete",
  async message => {

    if (
      !message.guild ||
      message.author?.bot
    ) {
      return;
    }

    // Ignore les salons privés (staff) : seuls les salons publics sont logués
    const isPublicChannel =
      message.channel
        .permissionsFor(
          message.guild.roles.everyone
        )
        ?.has(
          PermissionFlagsBits.ViewChannel
        );

    if (!isPublicChannel) {
      return;
    }

    const channel =
      getLogChannel(
        message.guild,
        LOG_CHANNEL_NAME
      );

    if (!channel) {
      return;
    }

    // Vérifie si un modérateur a supprimé ce message (via les logs d'audit)
    let executor =
      null;

    try {

      const logs =
        await message.guild.fetchAuditLogs({

          type:
            AuditLogEvent.MessageDelete,

          limit:
            5
        });

      const entry =
        logs.entries.find(
          e =>

            e.target?.id ===
              message.author?.id &&

            e.extra?.channel?.id ===
              message.channel.id &&

            Date.now() -
              e.createdTimestamp <
              15000
        );

      if (entry) {

        executor =
          entry.executor;
      }

    } catch (error) {

      console.error(
        "Impossible de lire les logs d'audit (message supprimé) :",
        error
      );
    }

    const attachmentsText =
      message.attachments?.size
        ? [...message.attachments.values()]
            .map(a => a.name)
            .join(", ")
        : null;

    const embed =
      new EmbedBuilder()

        .setAuthor({

          name:
            message.author?.tag ||
            "Utilisateur inconnu",

          iconURL:
            message.author?.displayAvatarURL()
        })

        .setTitle(
          "🗑️ Message supprimé"
        )

        .addFields(

          {
            name:
              "👤 Auteur",

            value:
              message.author
                ? `${message.author}`
                : "Utilisateur inconnu",

            inline:
              true
          },

          {
            name:
              "📍 Salon",

            value:
              `${message.channel}`,

            inline:
              true
          },

          {
            name:
              "🆔 ID du message",

            value:
              `\`${message.id}\``,

            inline:
              true
          }
        );

    if (
      executor &&
      executor.id !==
        message.author?.id
    ) {

      embed.addFields({

        name:
          "🛡️ Supprimé par",

        value:
          `${executor}`,

        inline:
          true
      });
    }

    embed.addFields({

      name:
        "💬 Contenu",

      value:
        cleanText(
          message.content,
          "Contenu indisponible"
        ),

      inline:
        false
    });

    if (attachmentsText) {

      embed.addFields({

        name:
          "📎 Pièce(s) jointe(s)",

        value:
          cleanText(
            attachmentsText
          ),

        inline:
          false
      });
    }

    embed

      .setThumbnail(
        message.author?.displayAvatarURL({
          extension:
            "png",

          size:
            256
        }) ??
        null
      )

      .setColor(
        0xED4245
      )

      .setFooter({

        text:
          `${message.guild.name} • Support & Logs`,

        iconURL:
          message.guild.iconURL()
      })

      .setTimestamp();

    channel.send({
      embeds:
        [embed]
    }).catch(
      () => {}
    );
  }
);


// ======================================================
// MESSAGE MODIFIÉ
// ======================================================

client.on(
  "messageUpdate",
  (
    oldMessage,
    newMessage
  ) => {

    if (
      !newMessage.guild ||
      newMessage.author?.bot
    ) {
      return;
    }

    if (
      oldMessage.content ===
      newMessage.content
    ) {
      return;
    }

    sendLog(

      newMessage.guild,

      "✏️ Message modifié",

      null,

      LOG_CHANNEL_NAME,

      [

        {
          name:
            "👤 Auteur",

          value:
            `${newMessage.author?.tag || "Inconnu"} (\`${newMessage.author?.id || "Inconnu"}\`)`,

          inline:
            false
        },

        {
          name:
            "📍 Salon",

          value:
            `${newMessage.channel}`,

          inline:
            true
        },

        {
          name:
            "📝 Avant",

          value:
            oldMessage.content ||
            "Vide",

          inline:
            false
        },

        {
          name:
            "📝 Après",

          value:
            newMessage.content ||
            "Vide",

          inline:
            false
        }
      ],

      0xFEE75C
    );
  }
);


// ======================================================
// SALON CRÉÉ
// ======================================================

client.on(
  "channelCreate",
  async channel => {

    if (
      !channel.guild
    ) {
      return;
    }

    let executor =
      null;

    try {

      const logs =
        await channel.guild.fetchAuditLogs({

          type:
            AuditLogEvent.ChannelCreate,

          limit:
            5
        });

      const entry =
        logs.entries.find(
          e =>

            e.target?.id ===
              channel.id &&

            Date.now() -
              e.createdTimestamp <
              15000
        );

      if (entry) {

        executor =
          entry.executor;
      }

    } catch (error) {

      console.error(
        "Impossible de lire les logs d'audit (salon créé) :",
        error
      );
    }

    await sendLog(

      channel.guild,

      "📁 Salon créé",

      null,

      LOG_CHANNEL_NAME,

      [

        {
          name:
            "📍 Salon",

          value:
            `${channel} (\`${channel.name}\`)`,

          inline:
            false
        },

        {
          name:
            "🛡️ Créé par",

          value:
            executor
              ? `${executor}`
              : "Inconnu",

          inline:
            false
        }
      ],

      0x57F287
    );
  }
);


// ======================================================
// SALON SUPPRIMÉ
// ======================================================

client.on(
  "channelDelete",
  async channel => {

    if (
      !channel.guild
    ) {
      return;
    }

    let executor =
      null;

    try {

      const logs =
        await channel.guild.fetchAuditLogs({

          type:
            AuditLogEvent.ChannelDelete,

          limit:
            5
        });

      const entry =
        logs.entries.find(
          e =>

            e.target?.id ===
              channel.id &&

            Date.now() -
              e.createdTimestamp <
              15000
        );

      if (entry) {

        executor =
          entry.executor;
      }

    } catch (error) {

      console.error(
        "Impossible de lire les logs d'audit (salon supprimé) :",
        error
      );
    }

    await sendLog(

      channel.guild,

      "🗑️ Salon supprimé",

      null,

      LOG_CHANNEL_NAME,

      [

        {
          name:
            "📍 Salon",

          value:
            `\`${channel.name}\``,

          inline:
            false
        },

        {
          name:
            "🛡️ Supprimé par",

          value:
            executor
              ? `${executor}`
              : "Inconnu",

          inline:
            false
        }
      ],

      0xED4245
    );
  }
);


// ======================================================
// RÔLE CRÉÉ
// ======================================================

client.on(
  "roleCreate",
  async role => {

    let executor =
      null;

    try {

      const logs =
        await role.guild.fetchAuditLogs({

          type:
            AuditLogEvent.RoleCreate,

          limit:
            5
        });

      const entry =
        logs.entries.find(
          e =>

            e.target?.id ===
              role.id &&

            Date.now() -
              e.createdTimestamp <
              15000
        );

      if (entry) {

        executor =
          entry.executor;
      }

    } catch (error) {

      console.error(
        "Impossible de lire les logs d'audit (rôle créé) :",
        error
      );
    }

    await sendLog(

      role.guild,

      "🎭 Rôle créé",

      null,

      LOG_CHANNEL_NAME,

      [

        {
          name:
            "🏷️ Rôle",

          value:
            `${role}`,

          inline:
            false
        },

        {
          name:
            "🛡️ Créé par",

          value:
            executor
              ? `${executor}`
              : "Inconnu",

          inline:
            false
        }
      ],

      0x57F287
    );
  }
);


// ======================================================
// RÔLE SUPPRIMÉ
// ======================================================

client.on(
  "roleDelete",
  async role => {

    let executor =
      null;

    try {

      const logs =
        await role.guild.fetchAuditLogs({

          type:
            AuditLogEvent.RoleDelete,

          limit:
            5
        });

      const entry =
        logs.entries.find(
          e =>

            e.target?.id ===
              role.id &&

            Date.now() -
              e.createdTimestamp <
              15000
        );

      if (entry) {

        executor =
          entry.executor;
      }

    } catch (error) {

      console.error(
        "Impossible de lire les logs d'audit (rôle supprimé) :",
        error
      );
    }

    await sendLog(

      role.guild,

      "🗑️ Rôle supprimé",

      null,

      LOG_CHANNEL_NAME,

      [

        {
          name:
            "🏷️ Rôle",

          value:
            `\`${role.name}\``,

          inline:
            false
        },

        {
          name:
            "🛡️ Supprimé par",

          value:
            executor
              ? `${executor}`
              : "Inconnu",

          inline:
            false
        }
      ],

      0xED4245
    );
  }
);


// ======================================================
// BOOST DU SERVEUR
// ======================================================

client.on(
  "messageCreate",
  async message => {

    if (
      !message.guild
    ) {
      return;
    }

    const boostTypes = [

      MessageType.UserPremiumGuildSubscription,
      MessageType.UserPremiumGuildSubscriptionTier1,
      MessageType.UserPremiumGuildSubscriptionTier2,
      MessageType.UserPremiumGuildSubscriptionTier3
    ];

    if (
      !boostTypes.includes(
        message.type
      )
    ) {
      return;
    }

    const boostChannel =
      getLogChannel(
        message.guild,
        BOOST_CHANNEL_NAME
      );

    if (!boostChannel) {
      return;
    }

    // Discord inclut le nombre de boosts dans le texte du message
    // système (ex: "a boosté le serveur 2 fois !"). On le récupère si présent.
    const countMatch =
      message.content.match(
        /(\d+)/
      );

    const count =
      countMatch
        ? Number(
            countMatch[1]
          )
        : 1;

    const embed =
      new EmbedBuilder()

        .setTitle(
          "🚀 Boost du serveur !"
        )

        .setDescription(

          count > 1

            ? `${message.author} a boosté le serveur **${count} fois** !\n\nMerci pour ton boost, toute l'équipe de la **𝒁𝒆𝒏𝒚𝑿𝒙 Team** te remercie chaleureusement 💜`

            : `${message.author} a boosté le serveur !\n\nMerci pour ton boost, toute l'équipe de la **𝒁𝒆𝒏𝒚𝑿𝒙 Team** te remercie chaleureusement 💜`
        )

        .setThumbnail(
          message.author.displayAvatarURL({
            extension:
              "png",

            size:
              256
          })
        )

        .setColor(
          0xF47FFF
        )

        .setFooter({

          text:
            `${message.guild.name} • Boost`,

          iconURL:
            message.guild.iconURL()
        })

        .setTimestamp();

    await boostChannel.send({
      embeds:
        [embed]
    }).catch(
      () => {}
    );
  }
);


// ======================================================
// ERREURS
// ======================================================

client.on(
  "error",
  error => {

    console.error(
      "Erreur Discord :",
      error
    );
  }
);


// ======================================================
// CONNEXION
// ======================================================

client.login(
  process.env.DISCORD_TOKEN
);
