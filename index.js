require("dotenv").config();
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  AuditLogEvent,
} = require("discord.js");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,       // role/timeout için şart
    GatewayIntentBits.GuildVoiceStates,   // ses logları
    GatewayIntentBits.GuildModeration,    // ban/timeout olayları için iyi
  ],
});

// ---- Audit log retry ayarları ----
const AUDIT_MAX_AGE_MS = 30000;
const RETRIES = 4;
const RETRY_DELAY_MS = 1200;

client.once("ready", () => {
  console.log(`Bot aktif: ${client.user.tag}`);
});

// ---------- yardımcılar ----------
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function getLogChannel(guild) {
  return guild.channels.cache.get(process.env.LOG_CHANNEL_ID);
}

function safeSend(guild, embed) {
  const ch = getLogChannel(guild);
  if (!ch) return;
  ch.send({ embeds: [embed] }).catch(() => {});
}

function makeEmbed(title, color) {
  return new EmbedBuilder().setTitle(title).setColor(color).setTimestamp();
}

// Audit log gecikirse retry
async function findAuditRetry(guild, type, targetId) {
  for (let i = 0; i < RETRIES; i++) {
    const logs = await guild.fetchAuditLogs({ type, limit: 10 });
    const now = Date.now();

    const entry = logs.entries.find((e) => {
      const tid = e.target?.id || e.targetId;
      const fresh = now - e.createdTimestamp < AUDIT_MAX_AGE_MS;
      return tid === targetId && fresh;
    });

    if (entry) return entry;
    await sleep(RETRY_DELAY_MS);
  }
  return null;
}

// =====================================================
// VOICE LOGS (join/leave/move + kim attı/kim taşıdı)
// =====================================================
client.on("voiceStateUpdate", async (oldState, newState) => {
  try {
    const member = newState.member || oldState.member;
    if (!member || member.user.bot) return;

    const guild = member.guild;
    const oldCh = oldState.channel;
    const newCh = newState.channel;

    // Server Mute (kim susturdu)
    if (oldState.serverMute !== newState.serverMute) {
      const entry = await findAuditRetry(guild, AuditLogEvent.MemberUpdate, member.id);

      const embed = makeEmbed("🔇 Server Mute", newState.serverMute ? "Red" : "Green")
        .addFields(
          { name: "Kullanıcı", value: member.user.tag },
          { name: "Durum", value: newState.serverMute ? "Susturuldu" : "Susturma açıldı" },
          { name: "Yapan", value: entry?.executor?.tag || "Bilinmiyor" }
        );

      safeSend(guild, embed);
    }

    // Server Deafen (kim sağırlaştırdı)
    if (oldState.serverDeaf !== newState.serverDeaf) {
      const entry = await findAuditRetry(guild, AuditLogEvent.MemberUpdate, member.id);

      const embed = makeEmbed("🎧 Server Deafen", newState.serverDeaf ? "Red" : "Green")
        .addFields(
          { name: "Kullanıcı", value: member.user.tag },
          { name: "Durum", value: newState.serverDeaf ? "Sağırlaştırıldı" : "Sağırlık açıldı" },
          { name: "Yapan", value: entry?.executor?.tag || "Bilinmiyor" }
        );

      safeSend(guild, embed);
    }

    // Ses Girişi
    if (!oldCh && newCh) {
      const embed = makeEmbed("🔊 Ses Girişi", "Green")
        .addFields(
          { name: "Kullanıcı", value: member.user.tag },
          { name: "Kanal", value: newCh.name }
        );
      safeSend(guild, embed);
      return;
    }

    // Sesten Çıkış (kendi çıktı mı / kim attı mı)
    if (oldCh && !newCh) {
      const entry = await findAuditRetry(guild, AuditLogEvent.MemberDisconnect, member.id);

      const embed = makeEmbed(entry ? "👢 Ses Atma" : "🚪 Sesten Çıkış", entry ? "Red" : "Grey")
        .addFields(
          { name: "Kullanıcı", value: member.user.tag },
          { name: "Kanal", value: oldCh.name },
          {
            name: entry ? "Atan" : "Not",
            value: entry ? entry.executor.tag : "Kendi çıktı / bağlantı koptu (Discord bazen audit yazmaz)"
          }
        );

      safeSend(guild, embed);
      return;
    }

    // Kanal Değişimi (kendi geçti mi / kim taşıdı mı)
    if (oldCh && newCh && oldCh.id !== newCh.id) {
      const entry = await findAuditRetry(guild, AuditLogEvent.MemberMove, member.id);

      const embed = makeEmbed(entry ? "🚚 Ses Taşıma" : "🔁 Kanal Değişimi", entry ? "Orange" : "Blue")
        .addFields(
          { name: "Kullanıcı", value: member.user.tag },
          { name: "Nereden", value: oldCh.name },
          { name: "Nereye", value: newCh.name },
          { name: entry ? "Taşıyan" : "Not", value: entry ? entry.executor.tag : "Kendi geçti" }
        );

      safeSend(guild, embed);
      return;
    }
  } catch (e) {
    console.error("voiceStateUpdate error:", e);
  }
});

// =====================================================
// ROLE CREATE / DELETE
// =====================================================
client.on("roleCreate", async (role) => {
  try {
    const entry = await findAuditRetry(role.guild, AuditLogEvent.RoleCreate, role.id);

    const embed = makeEmbed("🆕 Rol Oluşturuldu", "Green")
      .addFields(
        { name: "Rol", value: role.name },
        { name: "Oluşturan", value: entry?.executor?.tag || "Bilinmiyor" }
      );

    safeSend(role.guild, embed);
  } catch (e) {
    console.error("roleCreate error:", e);
  }
});

client.on("roleDelete", async (role) => {
  try {
    const entry = await findAuditRetry(role.guild, AuditLogEvent.RoleDelete, role.id);

    const embed = makeEmbed("🗑️ Rol Silindi", "Red")
      .addFields(
        { name: "Rol", value: role.name },
        { name: "Silen", value: entry?.executor?.tag || "Bilinmiyor" }
      );

    safeSend(role.guild, embed);
  } catch (e) {
    console.error("roleDelete error:", e);
  }
});

// =====================================================
// MEMBER UPDATE: ROLE ADD/REMOVE + TIMEOUT (FIXED)
// =====================================================
client.on("guildMemberUpdate", async (oldMember, newMember) => {
  try {
    const guild = newMember.guild;

    // ---------- ROLE ADD/REMOVE ----------
    const oldRoles = oldMember.roles.cache;
    const newRoles = newMember.roles.cache;

    const added = newRoles.find((r) => !oldRoles.has(r.id));
    const removed = oldRoles.find((r) => !newRoles.has(r.id));

    if (added || removed) {
      const entry = await findAuditRetry(guild, AuditLogEvent.MemberRoleUpdate, newMember.id);

      if (added) {
        const embed = makeEmbed("➕ Rol Verildi", "Green")
          .addFields(
            { name: "Kullanıcı", value: newMember.user.tag },
            { name: "Rol", value: added.name },
            { name: "Veren", value: entry?.executor?.tag || "Bilinmiyor" }
          );
        safeSend(guild, embed);
      }

      if (removed) {
        const embed = makeEmbed("➖ Rol Alındı", "Red")
          .addFields(
            { name: "Kullanıcı", value: newMember.user.tag },
            { name: "Rol", value: removed.name },
            { name: "Alan", value: entry?.executor?.tag || "Bilinmiyor" }
          );
        safeSend(guild, embed);
      }
    }

    // ---------- TIMEOUT (timestamp ile garanti) ----------
    const oldTs = oldMember.communicationDisabledUntilTimestamp ?? null;
    const newTs = newMember.communicationDisabledUntilTimestamp ?? null;

    if (oldTs !== newTs) {
      const entry = await findAuditRetry(guild, AuditLogEvent.MemberUpdate, newMember.id);

      let durum = "Timeout değişti";
      if (!oldTs && newTs) durum = "Timeout verildi";
      else if (oldTs && !newTs) durum = "Timeout kaldırıldı";
      else if (oldTs && newTs) durum = "Timeout güncellendi/uzatıldı";

      const embed = makeEmbed("⏳ Timeout", newTs ? "Orange" : "Green")
        .addFields(
          { name: "Kullanıcı", value: newMember.user.tag },
          { name: "Durum", value: durum },
          { name: "Bitiş", value: newTs ? `<t:${Math.floor(newTs / 1000)}:F>` : "Yok" },
          { name: "Yapan", value: entry?.executor?.tag || "Bilinmiyor" }
        );

      safeSend(guild, embed);
    }
  } catch (e) {
    console.error("guildMemberUpdate error:", e);
  }
});

// =====================================================
// CHANNEL PERMISSION OVERWRITES (create/update/delete)
// =====================================================
client.on("channelUpdate", async (oldChannel, newChannel) => {
  try {
    const g = newChannel.guild;

    // Update
    const u = await findAuditRetry(g, AuditLogEvent.ChannelOverwriteUpdate, newChannel.id);
    if (u) {
      const embed = makeEmbed("🔧 Kanal İzni Güncellendi", "Orange")
        .addFields(
          { name: "Kanal", value: newChannel.name },
          { name: "Yapan", value: u.executor.tag }
        );
      safeSend(g, embed);
      return;
    }

    // Create
    const c = await findAuditRetry(g, AuditLogEvent.ChannelOverwriteCreate, newChannel.id);
    if (c) {
      const embed = makeEmbed("➕ Kanal İzni Eklendi", "Green")
        .addFields(
          { name: "Kanal", value: newChannel.name },
          { name: "Yapan", value: c.executor.tag }
        );
      safeSend(g, embed);
      return;
    }

    // Delete
    const d = await findAuditRetry(g, AuditLogEvent.ChannelOverwriteDelete, newChannel.id);
    if (d) {
      const embed = makeEmbed("➖ Kanal İzni Silindi", "Red")
        .addFields(
          { name: "Kanal", value: newChannel.name },
          { name: "Yapan", value: d.executor.tag }
        );
      safeSend(g, embed);
      return;
    }
  } catch (e) {
    console.error("channelUpdate error:", e);
  }
});

// =====================================================
// BAN / UNBAN
// =====================================================
client.on("guildBanAdd", async (ban) => {
  try {
    const guild = ban.guild;
    const user = ban.user;

    const entry = await findAuditRetry(guild, AuditLogEvent.MemberBanAdd, user.id);

    const embed = makeEmbed("⛔ Ban Atıldı", "Red")
      .addFields(
        { name: "Kullanıcı", value: user.tag },
        { name: "Banlayan", value: entry?.executor?.tag || "Bilinmiyor" },
        { name: "Sebep", value: entry?.reason || "Yok" }
      );

    safeSend(guild, embed);
  } catch (e) {
    console.error("guildBanAdd error:", e);
  }
});

client.on("guildBanRemove", async (ban) => {
  try {
    const guild = ban.guild;
    const user = ban.user;

    const entry = await findAuditRetry(guild, AuditLogEvent.MemberBanRemove, user.id);

    const embed = makeEmbed("✅ Ban Kaldırıldı", "Green")
      .addFields(
        { name: "Kullanıcı", value: user.tag },
        { name: "Kaldıran", value: entry?.executor?.tag || "Bilinmiyor" }
      );

    safeSend(guild, embed);
  } catch (e) {
    console.error("guildBanRemove error:", e);
  }
});

// =====================================================
// KICK (member remove + audit kick)
// =====================================================
client.on("guildMemberRemove", async (member) => {
  try {
    const guild = member.guild;

    // Kick mi? Audit kaydı varsa kick deriz
    const entry = await findAuditRetry(guild, AuditLogEvent.MemberKick, member.id);
    if (!entry) return; // normal leave olabilir

    const embed = makeEmbed("🥾 Kick Atıldı", "Red")
      .addFields(
        { name: "Kullanıcı", value: member.user.tag },
        { name: "Atan", value: entry.executor.tag },
        { name: "Sebep", value: entry.reason || "Yok" }
      );

    safeSend(guild, embed);
  } catch (e) {
    console.error("guildMemberRemove error:", e);
  }
});

client.login(process.env.TOKEN);
