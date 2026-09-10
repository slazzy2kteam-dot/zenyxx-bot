const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  SlashCommandBuilder,
  PermissionFlagsBits,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  AttachmentBuilder,
  AuditLogEvent
} = require("discord.js");

const { createCanvas, loadImage } = require("@napi-rs/canvas");
const express = require("express");
const fs = require("fs");

// ======================================================
// CONFIGURATION
// ======================================================

const TOKEN = process.env.TOKEN;

const LOG_CHANNEL_NAME = "📋・logs";
const TICKET_LOG_CHANNEL_NAME = "🚫-logs-tickets";
const MOD_LOG_CHANNEL_NAME = "🚫-logs-moderation";
const ARRIVAL_CHANNEL_NAME = "🔨-arrivé-des-membres";
const GOODBYE_CHANNEL_NAME = "✈️・𝗮𝘂𝗿𝗲𝘃𝗼𝗶𝗿";
const WELCOME_CHANNEL_NAME = "👋-bienvenue";

const CASE_FILE = "./cases.json";

// ======================================================
// CLIENT DISCORD
// ======================================================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildModeration
  ],
  partials: [
    Partials.Channel,
    Partials.Message,
    Partials.User,
    Partials.GuildMember
  ]
});

// ======================================================
// EXPRESS KEEP ALIVE
// ======================================================

const app = express();

app.get("/", (req, res) => {
  res.send("Bot Discord opérationnel !");
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Serveur web lancé sur le port ${PORT}`);
});

// ======================================================
// DONNÉES DES TICKETS
// ======================================================

const ticketCategories = {
  "candidature": {
    label: "Candidature",
    emoji: "📩",
    description: "Pour postuler au staff"
  },

  "aide": {
    label: "Aide",
    emoji: "❓",
    description: "Besoin d'aide"
  },

  "plainte": {
    label: "Plainte",
    emoji: "⚠️",
    description: "Signaler un problème"
  },

  "autre": {
    label: "Autre",
    emoji: "📌",
    description: "Autre demande"
  }
};

const candidatureCategories = {
  "twitch": "Twitch",
  "youtube": "YouTube",
  "discord": "Discord",
  "tiktok": "TikTok"
};

// ======================================================
// STOCKAGE DES TEMPBAN
// ======================================================

const guildData = new Map();

// ======================================================
// CASES
// ======================================================

let casesData = {
  nextCase: 1,
  cases: []
};

if (fs.existsSync(CASE_FILE)) {
  try {
    casesData = JSON.parse(fs.readFileSync(CASE_FILE, "utf8"));

    if (!casesData.nextCase) {
      casesData.nextCase = 1;
    }

    if (!Array.isArray(casesData.cases)) {
      casesData.cases = [];
    }
  } catch (error) {
    console.error("Impossible de lire cases.json :", error);
  }
}

function saveCases() {
  try {
    fs.writeFileSync(
      CASE_FILE,
      JSON.stringify(casesData, null, 2)
    );
  } catch (error) {
    console.error("Erreur sauvegarde cases :", error);
  }
}

function createCase({
  guild,
  user,
  moderator,
  action,
  reason,
  duration = null,
  expiresAt = null,
  proof = null
}) {
  const caseId = casesData.nextCase++;

  const newCase = {
    id: caseId,
    guildId: guild.id,
    userId: user.id,
    userTag: user.tag,
    moderatorId: moderator?.id || null,
    moderatorTag: moderator?.tag || "Inconnu",
    action,
    reason: reason || "Aucune raison fournie",
    duration,
    expiresAt,
    proof,
    createdAt: Date.now()
  };

  casesData.cases.push(newCase);

  saveCases();

  return newCase;
}

function getCase(caseId, guildId) {
  return casesData.cases.find(
    c => c.id === Number(caseId) && c.guildId === guildId
  );
}

// ======================================================
// OUTILS
// ======================================================

function getLogChannel(guild, name) {
  return guild.channels.cache.find(
    channel =>
      channel.name === name &&
      channel.type === ChannelType.GuildText
  );
}

function formatDuration(ms) {
  if (!ms) return "Permanent";

  let seconds = Math.floor(ms / 1000);

  const weeks = Math.floor(seconds / 604800);
  seconds %= 604800;

  const days = Math.floor(seconds / 86400);
  seconds %= 86400;

  const hours = Math.floor(seconds / 3600);
  seconds %= 3600;

  const minutes = Math.floor(seconds / 60);
  seconds %= 60;

  const parts = [];

  if (weeks) parts.push(`${weeks} semaine${weeks > 1 ? "s" : ""}`);
  if (days) parts.push(`${days} jour${days > 1 ? "s" : ""}`);
  if (hours) parts.push(`${hours} heure${hours > 1 ? "s" : ""}`);
  if (minutes) parts.push(`${minutes} minute${minutes > 1 ? "s" : ""}`);
  if (seconds) parts.push(`${seconds} seconde${seconds > 1 ? "s" : ""}`);

  return parts.join(", ") || "Moins d'une seconde";
}

function parseDuration(input) {
  if (!input) return null;

  const match = input
    .toLowerCase()
    .trim()
    .match(/^(\d+)\s*(s|sec|secs|m|min|mins|h|hr|hrs|d|j|jour|jours|w|sem|semaine|semaines)$/);

  if (!match) return null;

  const value = Number(match[1]);
  const unit = match[2];

  let multiplier;

  if (["s", "sec", "secs"].includes(unit)) {
    multiplier = 1000;
  } else if (["m", "min", "mins"].includes(unit)) {
    multiplier = 60 * 1000;
  } else if (["h", "hr", "hrs"].includes(unit)) {
    multiplier = 60 * 60 * 1000;
  } else if (
    ["d", "j", "jour", "jours"].includes(unit)
  ) {
    multiplier = 24 * 60 * 60 * 1000;
  } else {
    multiplier = 7 * 24 * 60 * 60 * 1000;
  }

  return value * multiplier;
}

// ======================================================
// LOG MODÉRATION
// ======================================================

async function sendModerationLog({
  guild,
  action,
  target,
  moderator,
  reason,
  duration = null,
  expiresAt = null,
  proof = null,
  caseData = null
}) {
  const channel = getLogChannel(
    guild,
    MOD_LOG_CHANNEL_NAME
  );

  if (!channel) return;

  const actionEmojis = {
    KICK: "👢",
    BAN: "🔨",
    TEMPBAN: "⏳",
    TIMEOUT: "🔇",
    WARN: "⚠️",
    UNBAN: "🔓",
    CLEARWARNINGS: "🧹"
  };

  const emoji = actionEmojis[action] || "🛡️";

  const embed = new EmbedBuilder()
    .setAuthor({
      name: moderator?.tag || "Modérateur inconnu",
      iconURL: moderator?.displayAvatarURL?.() || null
    })
    .setTitle(`${emoji} ${action}`)
    .setThumbnail(
      target?.displayAvatarURL?.({
        size: 256
      }) || null
    )
    .addFields(
      {
        name: "👤 Membre",
        value: target
          ? `${target} \`${target.user?.tag || target.tag || "Inconnu"}\``
          : "Inconnu",
        inline: false
      },
      {
        name: "🆔 ID",
        value: target?.id || "Inconnu",
        inline: true
      },
      {
        name: "👮 Modérateur",
        value: moderator
          ? `${moderator}`
          : "Inconnu",
        inline: true
      },
      {
        name: "📄 Raison",
        value: reason || "Aucune raison fournie",
        inline: false
      }
    )
    .setColor(
      action === "UNBAN"
        ? 0x57F287
        : action === "WARN"
        ? 0xFEE75C
        : 0xED4245
    )
    .setTimestamp();

  if (duration) {
    embed.addFields({
      name: "⏱️ Durée",
      value: formatDuration(duration),
      inline: true
    });
  }

  if (expiresAt) {
    embed.addFields({
      name: "⌛ Expiration",
      value: `<t:${Math.floor(expiresAt / 1000)}:F>\n(<t:${Math.floor(expiresAt / 1000)}:R>)`,
      inline: true
    });
  }

  if (proof) {
    embed.addFields({
      name: "📎 Preuve",
      value: proof,
      inline: false
    });
  }

  if (caseData) {
    embed.addFields({
      name: "📁 Case",
      value: `#${caseData.id}`,
      inline: true
    });
  }

  embed.setFooter({
    text: `${guild.name} • ${action}`
  });

  await channel.send({
    embeds: [embed]
  }).catch(() => {});
}

// ======================================================
// LOG GÉNÉRAL
// ======================================================

async function sendLog(guild, title, description, color = 0x5865F2) {
  const channel = getLogChannel(
    guild,
    LOG_CHANNEL_NAME
  );

  if (!channel) return;

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(color)
    .setTimestamp();

  await channel.send({
    embeds: [embed]
  }).catch(() => {});
}

// ======================================================
// IMAGE DE BIENVENUE
// ======================================================

async function generateWelcomeImage(member) {
  const canvas = createCanvas(1200, 500);
  const ctx = canvas.getContext("2d");

  // Fond
  const gradient = ctx.createLinearGradient(
    0,
    0,
    canvas.width,
    canvas.height
  );

  gradient.addColorStop(0, "#111827");
  gradient.addColorStop(1, "#1f2937");

  ctx.fillStyle = gradient;
  ctx.fillRect(
    0,
    0,
    canvas.width,
    canvas.height
  );

  // Cercle avatar
  const avatar = await loadImage(
    member.user.displayAvatarURL({
      extension: "png",
      size: 256
    })
  );

  ctx.save();

  ctx.beginPath();
  ctx.arc(
    600,
    190,
    100,
    0,
    Math.PI * 2
  );

  ctx.closePath();
  ctx.clip();

  ctx.drawImage(
    avatar,
    500,
    90,
    200,
    200
  );

  ctx.restore();

  // Texte bienvenue
  ctx.textAlign = "center";

  ctx.font = "bold 54px Sans";
  ctx.fillStyle = "#ffffff";

  ctx.fillText(
    "BIENVENUE !",
    600,
    350
  );

  ctx.font = "bold 36px Sans";

  ctx.fillText(
    member.user.username,
    600,
    405
  );

  ctx.font = "26px Sans";

  ctx.fillStyle = "#cbd5e1";

  ctx.fillText(
    `Tu es le membre #${member.guild.memberCount}`,
    600,
    450
  );

  return canvas.toBuffer("image/png");
}

// ======================================================
// COMMANDES
// ======================================================

const commands = [
  new SlashCommandBuilder()
    .setName("kick")
    .setDescription("Expulse un membre")
    .addUserOption(option =>
      option
        .setName("membre")
        .setDescription("Membre à expulser")
        .setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName("raison")
        .setDescription("Raison de l'expulsion")
        .setRequired(false)
    )
    .setDefaultMemberPermissions(
      PermissionFlagsBits.KickMembers
    ),

  new SlashCommandBuilder()
    .setName("ban")
    .setDescription("Bannit définitivement un membre")
    .addUserOption(option =>
      option
        .setName("membre")
        .setDescription("Membre à bannir")
        .setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName("raison")
        .setDescription("Raison du bannissement")
        .setRequired(false)
    )
    .addStringOption(option =>
      option
        .setName("preuve")
        .setDescription("Lien ou preuve")
        .setRequired(false)
    )
    .setDefaultMemberPermissions(
      PermissionFlagsBits.BanMembers
    ),

  new SlashCommandBuilder()
    .setName("tempban")
    .setDescription("Bannit temporairement un membre")
    .addUserOption(option =>
      option
        .setName("membre")
        .setDescription("Membre à bannir")
        .setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName("durée")
        .setDescription("Exemple : 1d, 4d, 7d, 2h")
        .setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName("raison")
        .setDescription("Raison")
        .setRequired(false)
    )
    .addStringOption(option =>
      option
        .setName("preuve")
        .setDescription("Lien ou preuve")
        .setRequired(false)
    )
    .setDefaultMemberPermissions(
      PermissionFlagsBits.BanMembers
    ),

  new SlashCommandBuilder()
    .setName("timeout")
    .setDescription("Met un membre en timeout")
    .addUserOption(option =>
      option
        .setName("membre")
        .setDescription("Membre")
        .setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName("durée")
        .setDescription("Exemple : 10m, 1h, 1d")
        .setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName("raison")
        .setDescription("Raison")
        .setRequired(false)
    )
    .addStringOption(option =>
      option
        .setName("preuve")
        .setDescription("Lien ou preuve")
        .setRequired(false)
    )
    .setDefaultMemberPermissions(
      PermissionFlagsBits.ModerateMembers
    ),

  new SlashCommandBuilder()
    .setName("warn")
    .setDescription("Avertit un membre")
    .addUserOption(option =>
      option
        .setName("membre")
        .setDescription("Membre")
        .setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName("raison")
        .setDescription("Raison de l'avertissement")
        .setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName("preuve")
        .setDescription("Lien ou preuve")
        .setRequired(false)
    )
    .setDefaultMemberPermissions(
      PermissionFlagsBits.ModerateMembers
    ),

  new SlashCommandBuilder()
    .setName("warnings")
    .setDescription("Affiche les avertissements d'un membre")
    .addUserOption(option =>
      option
        .setName("membre")
        .setDescription("Membre")
        .setRequired(true)
    )
    .setDefaultMemberPermissions(
      PermissionFlagsBits.ModerateMembers
    ),

  new SlashCommandBuilder()
    .setName("clearwarnings")
    .setDescription("Supprime les avertissements d'un membre")
    .addUserOption(option =>
      option
        .setName("membre")
        .setDescription("Membre")
        .setRequired(true)
    )
    .setDefaultMemberPermissions(
      PermissionFlagsBits.ModerateMembers
    ),

  new SlashCommandBuilder()
    .setName("unban")
    .setDescription("Débannit un utilisateur")
    .addStringOption(option =>
      option
        .setName("id")
        .setDescription("ID Discord de l'utilisateur")
        .setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName("raison")
        .setDescription("Raison")
        .setRequired(false)
    )
    .setDefaultMemberPermissions(
      PermissionFlagsBits.BanMembers
    ),

  new SlashCommandBuilder()
    .setName("case")
    .setDescription("Affiche les informations d'un case")
    .addIntegerOption(option =>
      option
        .setName("numero")
        .setDescription("Numéro du case")
        .setRequired(true)
    )
    .setDefaultMemberPermissions(
      PermissionFlagsBits.ModerateMembers
    ),

  new SlashCommandBuilder()
    .setName("clear")
    .setDescription("Supprime des messages")
    .addIntegerOption(option =>
      option
        .setName("nombre")
        .setDescription("Nombre de messages")
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(100)
    )
    .setDefaultMemberPermissions(
      PermissionFlagsBits.ManageMessages
    ),

  new SlashCommandBuilder()
    .setName("ticket-panel")
    .setDescription("Envoie le panneau de création de ticket")
    .setDefaultMemberPermissions(
      PermissionFlagsBits.ManageChannels
    )
].map(command => command.toJSON());

// ======================================================
// READY
// ======================================================

client.once("ready", async () => {
  console.log(`Connecté en tant que ${client.user.tag}`);

  try {
    await client.application.commands.set(commands);

    console.log("Commandes slash enregistrées.");
  } catch (error) {
    console.error(
      "Erreur enregistrement commandes :",
      error
    );
  }

  restoreTempBans();
});

// ======================================================
// RESTAURATION DES TEMPBAN
// ======================================================

function restoreTempBans() {
  for (const guild of client.guilds.cache.values()) {
    if (!guildData.has(guild.id)) {
      guildData.set(guild.id, {
        tempbans: new Map()
      });
    }

    const data = guildData.get(guild.id);

    if (!data.tempbans) {
      data.tempbans = new Map();
    }

    for (const caseData of casesData.cases) {
      if (
        caseData.guildId !== guild.id ||
        caseData.action !== "TEMPBAN" ||
        !caseData.expiresAt
      ) {
        continue;
      }

      const remaining =
        caseData.expiresAt - Date.now();

      if (remaining <= 0) {
        unbanUserAutomatically(
          guild,
          caseData.userId,
          caseData.id
        );
      } else {
        scheduleTempBanExpiration(
          guild,
          caseData.userId,
          caseData.expiresAt,
          caseData.id
        );
      }
    }
  }
}

function scheduleTempBanExpiration(
  guild,
  userId,
  expiresAt,
  caseId
) {
  const remaining =
    expiresAt - Date.now();

  if (remaining <= 0) {
    unbanUserAutomatically(
      guild,
      userId,
      caseId
    );

    return;
  }

  setTimeout(() => {
    unbanUserAutomatically(
      guild,
      userId,
      caseId
    );
  }, Math.min(remaining, 2147483647));
}

async function unbanUserAutomatically(
  guild,
  userId,
  caseId
) {
  try {
    await guild.members.unban(
      userId,
      `Fin du bannissement temporaire — Case #${caseId}`
    );

    const channel = getLogChannel(
      guild,
      MOD_LOG_CHANNEL_NAME
    );

    if (channel) {
      const embed = new EmbedBuilder()
        .setTitle("🔓 Fin du bannissement temporaire")
        .setDescription(
          `Le bannissement temporaire de <@${userId}> est terminé.`
        )
        .addFields({
          name: "📁 Case",
          value: `#${caseId}`
        })
        .setColor(0x57F287)
        .setTimestamp();

      channel.send({
        embeds: [embed]
      }).catch(() => {});
    }
  } catch (error) {
    console.error(
      `Erreur unban automatique ${userId} :`,
      error.message
    );
  }
}

// ======================================================
// INTERACTIONS
// ======================================================

client.on("interactionCreate", async interaction => {
  if (
    !interaction.isChatInputCommand() &&
    !interaction.isStringSelectMenu() &&
    !interaction.isButton()
  ) {
    return;
  }

  // ====================================================
  // COMMANDES SLASH
  // ====================================================

  if (interaction.isChatInputCommand()) {
    const { commandName } = interaction;

    // --------------------------------------------------
    // KICK
    // --------------------------------------------------

    if (commandName === "kick") {
      const member =
        interaction.options.getMember("membre");

      const reason =
        interaction.options.getString("raison") ||
        "Aucune raison fournie";

      if (!member) {
        return interaction.reply({
          content: "❌ Membre introuvable.",
          ephemeral: true
        });
      }

      if (!member.kickable) {
        return interaction.reply({
          content:
            "❌ Je ne peux pas expulser ce membre.",
          ephemeral: true
        });
      }

      const caseData = createCase({
        guild: interaction.guild,
        user: member.user,
        moderator: interaction.user,
        action: "KICK",
        reason
      });

      await member.kick(reason);

      await sendModerationLog({
        guild: interaction.guild,
        action: "KICK",
        target: member,
        moderator: interaction.user,
        reason,
        caseData
      });

      return interaction.reply({
        content:
          `👢 **${member.user.tag}** a été expulsé.\n📁 Case **#${caseData.id}**`,
        ephemeral: true
      });
    }

    // --------------------------------------------------
    // BAN
    // --------------------------------------------------

    if (commandName === "ban") {
      const member =
        interaction.options.getMember("membre");

      const reason =
        interaction.options.getString("raison") ||
        "Aucune raison fournie";

      const proof =
        interaction.options.getString("preuve");

      if (!member) {
        return interaction.reply({
          content: "❌ Membre introuvable.",
          ephemeral: true
        });
      }

      if (!member.bannable) {
        return interaction.reply({
          content:
            "❌ Je ne peux pas bannir ce membre.",
          ephemeral: true
        });
      }

      const caseData = createCase({
        guild: interaction.guild,
        user: member.user,
        moderator: interaction.user,
        action: "BAN",
        reason,
        proof
      });

      await member.ban({
        reason
      });

      await sendModerationLog({
        guild: interaction.guild,
        action: "BAN",
        target: member,
        moderator: interaction.user,
        reason,
        proof,
        caseData
      });

      return interaction.reply({
        content:
          `🔨 **${member.user.tag}** a été banni.\n📁 Case **#${caseData.id}**`,
        ephemeral: true
      });
    }

    // --------------------------------------------------
    // TEMPBAN
    // --------------------------------------------------

    if (commandName === "tempban") {
      const member =
        interaction.options.getMember("membre");

      const durationInput =
        interaction.options.getString("durée");

      const duration =
        parseDuration(durationInput);

      const reason =
        interaction.options.getString("raison") ||
        "Aucune raison fournie";

      const proof =
        interaction.options.getString("preuve");

      if (!member) {
        return interaction.reply({
          content: "❌ Membre introuvable.",
          ephemeral: true
        });
      }

      if (!duration) {
        return interaction.reply({
          content:
            "❌ Durée invalide. Exemple : `10m`, `2h`, `4d`, `1w`.",
          ephemeral: true
        });
      }

      if (!member.bannable) {
        return interaction.reply({
          content:
            "❌ Je ne peux pas bannir ce membre.",
          ephemeral: true
        });
      }

      const expiresAt =
        Date.now() + duration;

      const caseData = createCase({
        guild: interaction.guild,
        user: member.user,
        moderator: interaction.user,
        action: "TEMPBAN",
        reason,
        duration,
        expiresAt,
        proof
      });

      await member.ban({
        reason: `Tempban ${formatDuration(duration)} — ${reason}`
      });

      scheduleTempBanExpiration(
        interaction.guild,
        member.id,
        expiresAt,
        caseData.id
      );

      await sendModerationLog({
        guild: interaction.guild,
        action: "TEMPBAN",
        target: member,
        moderator: interaction.user,
        reason,
        duration,
        expiresAt,
        proof,
        caseData
      });

      return interaction.reply({
        content:
          `⏳ **${member.user.tag}** a été banni pendant **${formatDuration(duration)}**.\n📁 Case **#${caseData.id}**`,
        ephemeral: true
      });
    }

    // --------------------------------------------------
    // TIMEOUT
    // --------------------------------------------------

    if (commandName === "timeout") {
      const member =
        interaction.options.getMember("membre");

      const durationInput =
        interaction.options.getString("durée");

      const duration =
        parseDuration(durationInput);

      const reason =
        interaction.options.getString("raison") ||
        "Aucune raison fournie";

      const proof =
        interaction.options.getString("preuve");

      if (!member) {
        return interaction.reply({
          content: "❌ Membre introuvable.",
          ephemeral: true
        });
      }

      if (!duration) {
        return interaction.reply({
          content:
            "❌ Durée invalide. Exemple : `10m`, `1h`, `1d`.",
          ephemeral: true
        });
      }

      const maxTimeout =
        28 * 24 * 60 * 60 * 1000;

      if (duration > maxTimeout) {
        return interaction.reply({
          content:
            "❌ Un timeout ne peut pas dépasser 28 jours.",
          ephemeral: true
        });
      }

      if (!member.moderatable) {
        return interaction.reply({
          content:
            "❌ Je ne peux pas mettre ce membre en timeout.",
          ephemeral: true
        });
      }

      const expiresAt =
        Date.now() + duration;

      const caseData = createCase({
        guild: interaction.guild,
        user: member.user,
        moderator: interaction.user,
        action: "TIMEOUT",
        reason,
        duration,
        expiresAt,
        proof
      });

      await member.timeout(
        duration,
        reason
      );

      await sendModerationLog({
        guild: interaction.guild,
        action: "TIMEOUT",
        target: member,
        moderator: interaction.user,
        reason,
        duration,
        expiresAt,
        proof,
        caseData
      });

      return interaction.reply({
        content:
          `🔇 **${member.user.tag}** est en timeout pendant **${formatDuration(duration)}**.\n📁 Case **#${caseData.id}**`,
        ephemeral: true
      });
    }

    // --------------------------------------------------
    // WARN
    // --------------------------------------------------

    if (commandName === "warn") {
      const member =
        interaction.options.getMember("membre");

      const reason =
        interaction.options.getString("raison");

      const proof =
        interaction.options.getString("preuve");

      if (!member) {
        return interaction.reply({
          content: "❌ Membre introuvable.",
          ephemeral: true
        });
      }

      const caseData = createCase({
        guild: interaction.guild,
        user: member.user,
        moderator: interaction.user,
        action: "WARN",
        reason,
        proof
      });

      await sendModerationLog({
        guild: interaction.guild,
        action: "WARN",
        target: member,
        moderator: interaction.user,
        reason,
        proof,
        caseData
      });

      return interaction.reply({
        content:
          `⚠️ **${member.user.tag}** a reçu un avertissement.\n📁 Case **#${caseData.id}**`,
        ephemeral: true
      });
    }

    // --------------------------------------------------
    // WARNINGS
    // --------------------------------------------------

    if (commandName === "warnings") {
      const member =
        interaction.options.getMember("membre");

      if (!member) {
        return interaction.reply({
          content: "❌ Membre introuvable.",
          ephemeral: true
        });
      }

      const warnings =
        casesData.cases.filter(
          c =>
            c.guildId === interaction.guild.id &&
            c.userId === member.id &&
            c.action === "WARN"
        );

      if (!warnings.length) {
        return interaction.reply({
          content:
            `✅ **${member.user.tag}** n'a aucun avertissement.`,
          ephemeral: true
        });
      }

      const list = warnings
        .slice(-10)
        .reverse()
        .map(
          c =>
            `**Case #${c.id}** — ${c.reason}\n` +
            `👮 ${c.moderatorTag} • <t:${Math.floor(c.createdAt / 1000)}:R>`
        )
        .join("\n\n");

      const embed = new EmbedBuilder()
        .setTitle(`⚠️ Avertissements de ${member.user.tag}`)
        .setDescription(list)
        .setColor(0xFEE75C)
        .setTimestamp();

      return interaction.reply({
        embeds: [embed],
        ephemeral: true
      });
    }

    // --------------------------------------------------
    // CLEAR WARNINGS
    // --------------------------------------------------

    if (commandName === "clearwarnings") {
      const member =
        interaction.options.getMember("membre");

      if (!member) {
        return interaction.reply({
          content: "❌ Membre introuvable.",
          ephemeral: true
        });
      }

      const before =
        casesData.cases.length;

      casesData.cases =
        casesData.cases.filter(
          c =>
            !(
              c.guildId === interaction.guild.id &&
              c.userId === member.id &&
              c.action === "WARN"
            )
        );

      saveCases();

      const removed =
        before - casesData.cases.length;

      const caseData = createCase({
        guild: interaction.guild,
        user: member.user,
        moderator: interaction.user,
        action: "CLEARWARNINGS",
        reason: `${removed} avertissement(s) supprimé(s)`
      });

      await sendModerationLog({
        guild: interaction.guild,
        action: "CLEARWARNINGS",
        target: member,
        moderator: interaction.user,
        reason: `${removed} avertissement(s) supprimé(s)`,
        caseData
      });

      return interaction.reply({
        content:
          `🧹 **${removed}** avertissement(s) supprimé(s) pour **${member.user.tag}**.`,
        ephemeral: true
      });
    }

    // --------------------------------------------------
    // UNBAN
    // --------------------------------------------------

    if (commandName === "unban") {
      const userId =
        interaction.options.getString("id");

      const reason =
        interaction.options.getString("raison") ||
        "Aucune raison fournie";

      let user;

      try {
        user = await client.users.fetch(userId);
      } catch {
        return interaction.reply({
          content:
            "❌ Utilisateur introuvable.",
          ephemeral: true
        });
      }

      try {
        await interaction.guild.members.unban(
          userId,
          reason
        );
      } catch (error) {
        return interaction.reply({
          content:
            "❌ Impossible de débannir cet utilisateur.",
          ephemeral: true
        });
      }

      const caseData = createCase({
        guild: interaction.guild,
        user,
        moderator: interaction.user,
        action: "UNBAN",
        reason
      });

      await sendModerationLog({
        guild: interaction.guild,
        action: "UNBAN",
        target: user,
        moderator: interaction.user,
        reason,
        caseData
      });

      return interaction.reply({
        content:
          `🔓 **${user.tag}** a été débanni.\n📁 Case **#${caseData.id}**`,
        ephemeral: true
      });
    }

    // --------------------------------------------------
    // CASE
    // --------------------------------------------------

    if (commandName === "case") {
      const caseId =
        interaction.options.getInteger("numero");

      const caseData =
        getCase(
          caseId,
          interaction.guild.id
        );

      if (!caseData) {
        return interaction.reply({
          content:
            `❌ Le case **#${caseId}** n'existe pas.`,
          ephemeral: true
        });
      }

      const embed = new EmbedBuilder()
        .setTitle(`📁 Case #${caseData.id}`)
        .addFields(
          {
            name: "👤 Utilisateur",
            value:
              `<@${caseData.userId}>\n\`${caseData.userTag}\``
          },
          {
            name: "🆔 ID",
            value: caseData.userId,
            inline: true
          },
          {
            name: "🛡️ Action",
            value: caseData.action,
            inline: true
          },
          {
            name: "👮 Modérateur",
            value:
              caseData.moderatorTag,
            inline: true
          },
          {
            name: "📄 Raison",
            value:
              caseData.reason ||
              "Aucune raison"
          }
        )
        .setColor(0x5865F2)
        .setTimestamp(caseData.createdAt);

      if (caseData.duration) {
        embed.addFields({
          name: "⏱️ Durée",
          value:
            formatDuration(
              caseData.duration
            ),
          inline: true
        });
      }

      if (caseData.expiresAt) {
        embed.addFields({
          name: "⌛ Expiration",
          value:
            `<t:${Math.floor(caseData.expiresAt / 1000)}:F>`,
          inline: true
        });
      }

      if (caseData.proof) {
        embed.addFields({
          name: "📎 Preuve",
          value: caseData.proof
        });
      }

      return interaction.reply({
        embeds: [embed],
        ephemeral: true
      });
    }

    // --------------------------------------------------
    // CLEAR
    // --------------------------------------------------

    if (commandName === "clear") {
      const amount =
        interaction.options.getInteger("nombre");

      try {
        const deleted =
          await interaction.channel.bulkDelete(
            amount,
            true
          );

        await interaction.reply({
          content:
            `🧹 **${deleted.size}** message(s) supprimé(s).`,
          ephemeral: true
        });

        await sendLog(
          interaction.guild,
          "🧹 Messages supprimés",
          `${interaction.user} a supprimé **${deleted.size}** message(s) dans ${interaction.channel}.`,
          0x5865F2
        );
      } catch (error) {
        await interaction.reply({
          content:
            "❌ Impossible de supprimer les messages.",
          ephemeral: true
        });
      }

      return;
    }

    // --------------------------------------------------
    // TICKET PANEL
    // --------------------------------------------------

    if (commandName === "ticket-panel") {
      const menu =
        new StringSelectMenuBuilder()
          .setCustomId("ticket_category")
          .setPlaceholder("Sélectionne la catégorie de ton ticket")
          .addOptions(
            Object.entries(ticketCategories).map(
              ([value, data]) => ({
                label: data.label,
                description: data.description,
                value,
                emoji: data.emoji
              })
            )
          );

      const row =
        new ActionRowBuilder()
          .addComponents(menu);

      const embed =
        new EmbedBuilder()
          .setTitle("🎫 Ouvrir un ticket")
          .setDescription(
            "Sélectionne la catégorie correspondant à ta demande."
          )
          .setColor(0x5865F2);

      await interaction.channel.send({
        embeds: [embed],
        components: [row]
      });

      return interaction.reply({
        content:
          "✅ Panneau de ticket envoyé.",
        ephemeral: true
      });
    }
  }

  // ====================================================
  // MENU CATÉGORIE TICKET
  // ====================================================

  if (
    interaction.isStringSelectMenu() &&
    interaction.customId === "ticket_category"
  ) {
    const category =
      interaction.values[0];

    if (category === "candidature") {
      const menu =
        new StringSelectMenuBuilder()
          .setCustomId("ticket_candidature")
          .setPlaceholder(
            "Choisis le domaine de ta candidature"
          )
          .addOptions(
            Object.entries(
              candidatureCategories
            ).map(([value, label]) => ({
              label,
              value,
              emoji: "📩"
            }))
          );

      const row =
        new ActionRowBuilder()
          .addComponents(menu);

      return interaction.reply({
        content:
          "📩 Choisis le domaine de ta candidature :",
        components: [row],
        ephemeral: true
      });
    }

    await createTicket(
      interaction,
      category
    );
  }

  // ====================================================
  // MENU CANDIDATURE
  // ====================================================

  if (
    interaction.isStringSelectMenu() &&
    interaction.customId === "ticket_candidature"
  ) {
    const type =
      interaction.values[0];

    await createTicket(
      interaction,
      "candidature",
      candidatureCategories[type]
    );
  }

  // ====================================================
  // BOUTON FERMETURE TICKET
  // ====================================================

  if (
    interaction.isButton() &&
    interaction.customId === "close_ticket"
  ) {
    await closeTicket(interaction);
  }
});

// ======================================================
// CRÉATION TICKET
// ======================================================

async function createTicket(
  interaction,
  category,
  subCategory = null
) {
  const guild =
    interaction.guild;

  const existing =
    guild.channels.cache.find(
      channel =>
        channel.type === ChannelType.GuildText &&
        channel.topic === `ticket:${interaction.user.id}`
    );

  if (existing) {
    return interaction.reply({
      content:
        `❌ Tu as déjà un ticket ouvert : ${existing}`,
      ephemeral: true
    });
  }

  let categoryChannel = null;

  const possibleNames = [
    `tickets-${category}`,
    `ticket-${category}`,
    category
  ];

  categoryChannel =
    guild.channels.cache.find(
      channel =>
        channel.type === ChannelType.GuildCategory &&
        possibleNames.includes(
          channel.name.toLowerCase()
        )
    );

  const safeName =
    `ticket-${interaction.user.username}`
      .toLowerCase()
      .replace(/[^a-z0-9-_]/g, "")
      .slice(0, 80);

  const overwrites = [
    {
      id: guild.roles.everyone.id,
      deny: ["ViewChannel"]
    },
    {
      id: interaction.user.id,
      allow: [
        "ViewChannel",
        "SendMessages",
        "ReadMessageHistory"
      ]
    }
  ];

  if (guild.members.me) {
    overwrites.push({
      id: guild.members.me.id,
      allow: [
        "ViewChannel",
        "SendMessages",
        "ReadMessageHistory",
        "ManageChannels"
      ]
    });
  }

  const channel =
    await guild.channels.create({
      name: safeName || "ticket",
      type: ChannelType.GuildText,
      parent:
        categoryChannel?.id || null,
      topic:
        `ticket:${interaction.user.id}`,
      permissionOverwrites:
        overwrites
    });

  const closeButton =
    new ButtonBuilder()
      .setCustomId("close_ticket")
      .setLabel("Fermer le ticket")
      .setEmoji("🔒")
      .setStyle(ButtonStyle.Danger);

  const row =
    new ActionRowBuilder()
      .addComponents(closeButton);

  const embed =
    new EmbedBuilder()
      .setTitle("🎫 Ticket ouvert")
      .setDescription(
        `Bienvenue ${interaction.user} !\n\n` +
        `Un membre du staff viendra s'occuper de ta demande.\n\n` +
        `**Catégorie :** ${ticketCategories[category]?.label || category}` +
        (
          subCategory
            ? `\n**Domaine :** ${subCategory}`
            : ""
        )
      )
      .setColor(0x5865F2)
      .setTimestamp();

  await channel.send({
    content:
      `${interaction.user}`,
    embeds: [embed],
    components: [row]
  });

  const logChannel =
    getLogChannel(
      guild,
      TICKET_LOG_CHANNEL_NAME
    );

  if (logChannel) {
    const logEmbed =
      new EmbedBuilder()
        .setTitle("🎫 Ticket créé")
        .addFields(
          {
            name: "👤 Utilisateur",
            value:
              `${interaction.user} \`${interaction.user.tag}\``
          },
          {
            name: "📂 Catégorie",
            value:
              ticketCategories[category]?.label || category
          },
          {
            name: "📌 Salon",
            value:
              `${channel}`
          }
        )
        .setColor(0x57F287)
        .setTimestamp();

    if (subCategory) {
      logEmbed.addFields({
        name: "📋 Domaine",
        value: subCategory
      });
    }

    logChannel.send({
      embeds: [logEmbed]
    }).catch(() => {});
  }

  return interaction.reply({
    content:
      `✅ Ton ticket a été créé : ${channel}`,
    ephemeral: true
  });
}

// ======================================================
// FERMETURE TICKET
// ======================================================

async function closeTicket(interaction) {
  const channel =
    interaction.channel;

  if (!channel || channel.type !== ChannelType.GuildText) {
    return interaction.reply({
      content:
        "❌ Ce salon n'est pas un ticket.",
      ephemeral: true
    });
  }

  const messages =
    await fetchAllMessages(channel);

  const transcript =
    messages
      .reverse()
      .map(message => {
        const date =
          new Date(
            message.createdTimestamp
          ).toLocaleString("fr-FR");

        const content =
          message.content || "[Aucun texte]";

        return `[${date}] ${message.author.tag}: ${content}`;
      })
      .join("\n");

  const fileName =
    `transcript-${channel.name}.txt`;

  const filePath =
    `./${fileName}`;

  fs.writeFileSync(
    filePath,
    transcript || "Aucun message."
  );

  const logChannel =
    getLogChannel(
      interaction.guild,
      TICKET_LOG_CHANNEL_NAME
    );

  if (logChannel) {
    const embed =
      new EmbedBuilder()
        .setTitle("🔒 Ticket fermé")
        .addFields(
          {
            name: "🎫 Ticket",
            value: channel.name
          },
          {
            name: "👮 Fermé par",
            value:
              `${interaction.user} \`${interaction.user.tag}\``
          }
        )
        .setColor(0xED4245)
        .setTimestamp();

    await logChannel.send({
      embeds: [embed],
      files: [
        new AttachmentBuilder(
          filePath,
          {
            name: fileName
          }
        )
      ]
    }).catch(() => {});
  }

  await interaction.reply({
    content:
      "🔒 Fermeture du ticket dans quelques secondes..."
  });

  setTimeout(() => {
    fs.unlink(
      filePath,
      () => {}
    );

    channel.delete().catch(() => {});
  }, 3000);
}

// ======================================================
// RÉCUPÉRATION DE TOUS LES MESSAGES
// ======================================================

async function fetchAllMessages(channel) {
  const allMessages = [];
  let lastId;

  while (true) {
    const options = {
      limit: 100
    };

    if (lastId) {
      options.before = lastId;
    }

    const messages =
      await channel.messages.fetch(options);

    if (!messages.size) {
      break;
    }

    allMessages.push(
      ...messages.values()
    );

    lastId =
      messages.last().id;

    if (messages.size < 100) {
      break;
    }
  }

  return allMessages;
}

// ======================================================
// MEMBRE REJOINT
// ======================================================

client.on("guildMemberAdd", member => {
  const welcomeChannel =
    getLogChannel(
      member.guild,
      WELCOME_CHANNEL_NAME
    );

  if (welcomeChannel) {
    const accountAgeDays =
      Math.floor(
        (Date.now() -
          member.user.createdTimestamp) /
          (1000 * 60 * 60 * 24)
      );

    const welcomeEmbed =
      new EmbedBuilder()
        .setAuthor({
          name: member.user.tag,
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
            name: "🆔 ID",
            value:
              `${member.user.id}`
          },
          {
            name: "🕒 Compte créé",
            value:
              `il y a ${accountAgeDays} jour${accountAgeDays !== 1 ? "s" : ""}`
          },
          {
            name: "📥 Rejoint",
            value:
              `<t:${Math.floor(
                Date.now() / 1000
              )}:F>`
          }
        )
        .setThumbnail(
          member.user.displayAvatarURL({
            size: 256
          })
        )
        .setColor(0x57F287)
        .setFooter({
          text:
            `Membre #${member.guild.memberCount} | ${member.guild.name}`
        })
        .setTimestamp();

    welcomeChannel
      .send({
        content: `${member}`,
        embeds: [welcomeEmbed]
      })
      .catch(() => {});
  }

  // Message public avec image de bienvenue générée
  const publicWelcomeChannel =
    getLogChannel(
      member.guild,
      ARRIVAL_CHANNEL_NAME
    );

  if (publicWelcomeChannel) {
    generateWelcomeImage(member)
      .then(buffer => {
        const attachment =
          new AttachmentBuilder(
            buffer,
            {
              name: "bienvenue.png"
            }
          );

        publicWelcomeChannel
          .send({
            content:
              `👋 Bienvenue ${member} !`,
            files: [attachment]
          })
          .catch(() => {});
      })
      .catch(err => {
        console.error(
          "Erreur génération image bienvenue :",
          err
        );

        publicWelcomeChannel
          .send(
            `👋 Bienvenue ${member} sur **${member.guild.name}** !`
          )
          .catch(() => {});
      });
  }

  // IMPORTANT :
  // Aucun log d'arrivée n'est envoyé dans 📋・logs.
});

// ======================================================
// MEMBRE QUITTE
// ======================================================

client.on("guildMemberRemove", async member => {
  // ----------------------------------------------------
  // Vérification si c'était un KICK
  // ----------------------------------------------------

  try {
    const auditLogs =
      await member.guild.fetchAuditLogs({
        type: AuditLogEvent.MemberKick,
        limit: 10
      });

    const kickEntry =
      auditLogs.entries.find(
        entry =>
          entry.target?.id === member.id &&
          Date.now() -
            entry.createdTimestamp <
            10000
      );

    if (kickEntry) {
      const moderator =
        kickEntry.executor;

      const reason =
        kickEntry.reason ||
        "Aucune raison fournie";

      const caseData =
        createCase({
          guild: member.guild,
          user: member.user,
          moderator,
          action: "KICK",
          reason
        });

      await sendModerationLog({
        guild: member.guild,
        action: "KICK",
        target: member,
        moderator,
        reason,
        caseData
      });

      return;
    }
  } catch (error) {
    console.error(
      "Erreur détection kick :",
      error
    );
  }

  // ----------------------------------------------------
  // Départ normal
  // ----------------------------------------------------

  const goodbyeChannel =
    getLogChannel(
      member.guild,
      GOODBYE_CHANNEL_NAME
    );

  if (goodbyeChannel) {
    const goodbyeEmbed =
      new EmbedBuilder()
        .setAuthor({
          name: member.user.tag,
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
            name: "🆔 ID",
            value:
              `${member.user.id}`
          },
          {
            name: "👥 Membres restants",
            value:
              `${member.guild.memberCount}`
          }
        )
        .setThumbnail(
          member.user.displayAvatarURL({
            size: 256
          })
        )
        .setColor(0xED4245)
        .setFooter({
          text:
            member.guild.name
        })
        .setTimestamp();

    goodbyeChannel
      .send({
        embeds: [goodbyeEmbed]
      })
      .catch(() => {});
  }

  // IMPORTANT :
  // Aucun log de départ n'est envoyé dans 📋・logs.
});

// ======================================================
// LOGS MESSAGES SUPPRIMÉS
// ======================================================

client.on(
  "messageDelete",
  async message => {
    if (!message.guild) return;

    if (message.author?.bot) return;

    const channel =
      getLogChannel(
        message.guild,
        LOG_CHANNEL_NAME
      );

    if (!channel) return;

    const content =
      message.content ||
      "*Aucun contenu texte*";

    const embed =
      new EmbedBuilder()
        .setTitle("🗑️ Message supprimé")
        .addFields(
          {
            name: "👤 Auteur",
            value:
              message.author
                ? `${message.author} \`${message.author.tag}\``
                : "Inconnu"
          },
          {
            name: "📍 Salon",
            value:
              `${message.channel}`
          },
          {
            name: "💬 Contenu",
            value:
              content.slice(0, 1024)
          }
        )
        .setColor(0xED4245)
        .setTimestamp();

    channel.send({
      embeds: [embed]
    }).catch(() => {});
  }
);

// ======================================================
// LOGS MESSAGES MODIFIÉS
// ======================================================

client.on(
  "messageUpdate",
  async (oldMessage, newMessage) => {
    if (!oldMessage.guild) return;

    if (oldMessage.author?.bot) return;

    if (
      oldMessage.content ===
      newMessage.content
    ) {
      return;
    }

    const channel =
      getLogChannel(
        oldMessage.guild,
        LOG_CHANNEL_NAME
      );

    if (!channel) return;

    const oldContent =
      oldMessage.content ||
      "*Aucun contenu*";

    const newContent =
      newMessage.content ||
      "*Aucun contenu*";

    const embed =
      new EmbedBuilder()
        .setTitle("✏️ Message modifié")
        .addFields(
          {
            name: "👤 Auteur",
            value:
              oldMessage.author
                ? `${oldMessage.author} \`${oldMessage.author.tag}\``
                : "Inconnu"
          },
          {
            name: "📍 Salon",
            value:
              `${oldMessage.channel}`
          },
          {
            name: "📝 Avant",
            value:
              oldContent.slice(0, 1024)
          },
          {
            name: "📝 Après",
            value:
              newContent.slice(0, 1024)
          }
        )
        .setColor(0xFEE75C)
        .setTimestamp();

    channel.send({
      embeds: [embed]
    }).catch(() => {});
  }
);

// ======================================================
// AUDIT LOG BAN
// ======================================================

client.on(
  "guildBanAdd",
  async ban => {
    try {
      const logs =
        await ban.guild.fetchAuditLogs({
          type: AuditLogEvent.MemberBanAdd,
          limit: 10
        });

      const entry =
        logs.entries.find(
          e =>
            e.target?.id === ban.user.id &&
            Date.now() -
              e.createdTimestamp <
              10000
        );

      if (!entry) return;

      const moderator =
        entry.executor;

      const reason =
        entry.reason ||
        "Aucune raison fournie";

      // Évite de recréer une case si le ban vient
      // déjà d'une commande de notre bot.
      const recentExisting =
        casesData.cases.find(
          c =>
            c.guildId === ban.guild.id &&
            c.userId === ban.user.id &&
            ["BAN", "TEMPBAN"].includes(
              c.action
            ) &&
            Date.now() - c.createdAt <
              10000
        );

      if (recentExisting) return;

      const caseData =
        createCase({
          guild: ban.guild,
          user: ban.user,
          moderator,
          action: "BAN",
          reason
        });

      await sendModerationLog({
        guild: ban.guild,
        action: "BAN",
        target: ban.user,
        moderator,
        reason,
        caseData
      });
    } catch (error) {
      console.error(
        "Erreur audit ban :",
        error
      );
    }
  }
);

// ======================================================
// AUDIT LOG UNBAN
// ======================================================

client.on(
  "guildBanRemove",
  async ban => {
    try {
      const logs =
        await ban.guild.fetchAuditLogs({
          type: AuditLogEvent.MemberBanRemove,
          limit: 10
        });

      const entry =
        logs.entries.find(
          e =>
            e.target?.id === ban.user.id &&
            Date.now() -
              e.createdTimestamp <
              10000
        );

      if (!entry) return;

      const moderator =
        entry.executor;

      const reason =
        entry.reason ||
        "Aucune raison fournie";

      const recentExisting =
        casesData.cases.find(
          c =>
            c.guildId === ban.guild.id &&
            c.userId === ban.user.id &&
            c.action === "UNBAN" &&
            Date.now() - c.createdAt <
              10000
        );

      if (recentExisting) return;

      const caseData =
        createCase({
          guild: ban.guild,
          user: ban.user,
          moderator,
          action: "UNBAN",
          reason
        });

      await sendModerationLog({
        guild: ban.guild,
        action: "UNBAN",
        target: ban.user,
        moderator,
        reason,
        caseData
      });
    } catch (error) {
      console.error(
        "Erreur audit unban :",
        error
      );
    }
  }
);

// ======================================================
// AUDIT LOG TIMEOUT
// ======================================================

client.on(
  "guildMemberUpdate",
  async (oldMember, newMember) => {
    const oldTimeout =
      oldMember.communicationDisabledUntilTimestamp;

    const newTimeout =
      newMember.communicationDisabledUntilTimestamp;

    if (
      oldTimeout === newTimeout
    ) {
      return;
    }

    // Timeout ajouté
    if (
      !oldTimeout &&
      newTimeout
    ) {
      try {
        const logs =
          await newMember.guild.fetchAuditLogs({
            type: AuditLogEvent.MemberUpdate,
            limit: 10
          });

        const entry =
          logs.entries.find(
            e =>
              e.target?.id === newMember.id &&
              Date.now() -
                e.createdTimestamp <
                10000
          );

        if (!entry) return;

        const moderator =
          entry.executor;

        const recentExisting =
          casesData.cases.find(
            c =>
              c.guildId ===
                newMember.guild.id &&
              c.userId ===
                newMember.id &&
              c.action === "TIMEOUT" &&
              Date.now() -
                c.createdAt <
                10000
          );

        if (recentExisting) return;

        const duration =
          newTimeout -
          Date.now();

        const reason =
          entry.reason ||
          "Aucune raison fournie";

        const caseData =
          createCase({
            guild: newMember.guild,
            user: newMember.user,
            moderator,
            action: "TIMEOUT",
            reason,
            duration,
            expiresAt: newTimeout
          });

        await sendModerationLog({
          guild: newMember.guild,
          action: "TIMEOUT",
          target: newMember,
          moderator,
          reason,
          duration,
          expiresAt: newTimeout,
          caseData
        });
      } catch (error) {
        console.error(
          "Erreur audit timeout :",
          error
        );
      }
    }
  }
);

// ======================================================
// ERREURS CLIENT
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

client.on(
  "warn",
  warning => {
    console.warn(
      "Discord warning :",
      warning
    );
  }
);

// ======================================================
// CONNEXION
// ======================================================

if (!TOKEN) {
  console.error(
    "❌ TOKEN manquant dans les variables d'environnement."
  );
} else {
  client.login(TOKEN);
}
