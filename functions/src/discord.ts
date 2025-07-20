import { Client, GatewayIntentBits, GuildMember, TextChannel } from 'discord.js';
import * as logger from 'firebase-functions/logger';
import { DISCORD_CONFIG } from './config';

let discordClient: Client | null = null;

// Initialize Discord client
export const initializeDiscordClient = async (): Promise<Client> => {
  if (discordClient && discordClient.isReady()) {
    return discordClient;
  }

  if (!DISCORD_CONFIG.BOT_TOKEN) {
    throw new Error('Discord bot token not configured');
  }

  try {
    discordClient = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
      ]
    });

    await discordClient.login(DISCORD_CONFIG.BOT_TOKEN);
    
    // Wait for client to be ready
    if (!discordClient.isReady()) {
      await new Promise((resolve) => {
        discordClient!.once('ready', resolve);
      });
    }

    logger.info('Discord bot client initialized successfully');
    return discordClient;
  } catch (error) {
    logger.error('Failed to initialize Discord client:', error);
    throw error;
  }
};

// Create a Discord invite for a user
export const createDiscordInvite = async (userId: string, userEmail: string): Promise<string> => {
  try {
    const client = await initializeDiscordClient();
    
    if (!DISCORD_CONFIG.GUILD_ID) {
      throw new Error('Discord guild ID not configured');
    }

    const guild = await client.guilds.fetch(DISCORD_CONFIG.GUILD_ID);
    if (!guild) {
      throw new Error('Discord guild not found');
    }

    // Check if user is already in the server
    try {
      const existingMember = await guild.members.fetch({ user: userId, force: true });
      if (existingMember) {
        logger.info(`User ${userEmail} is already a member of the Discord server`);
        return `discord://discord.com/channels/${DISCORD_CONFIG.GUILD_ID}`;
      }
    } catch (error) {
      // User not found in guild, which is expected for new users
      logger.info(`User ${userEmail} not found in guild, creating invite`, { error: error instanceof Error ? error.message : String(error) });
    }

    // Get the first available text channel to create invite from
    const channels = await guild.channels.fetch();
    const textChannel = channels.find((channel) => 
      channel?.type === 0 && // Text channel
      channel?.permissionsFor(guild.members.me!)?.has('CreateInstantInvite')
    ) as TextChannel;

    if (!textChannel) {
      throw new Error('No suitable channel found to create invite');
    }

    // Create invite
    const invite = await textChannel.createInvite({
      maxAge: DISCORD_CONFIG.INVITE_MAX_AGE,
      maxUses: DISCORD_CONFIG.INVITE_MAX_USES,
      unique: DISCORD_CONFIG.INVITE_UNIQUE,
      reason: `Auto-invite for user ${userEmail} (${userId})`
    });

    logger.info(`Created Discord invite for user ${userEmail}: ${invite.url}`);
    return invite.url;
  } catch (error) {
    logger.error(`Failed to create Discord invite for user ${userEmail}:`, error);
    throw error;
  }
};

// Send welcome message to user (if they're in the server)
export const sendWelcomeMessage = async (discordUserId: string, username: string): Promise<void> => {
  try {
    const client = await initializeDiscordClient();
    
    if (!DISCORD_CONFIG.GUILD_ID) {
      throw new Error('Discord guild ID not configured');
    }

    const guild = await client.guilds.fetch(DISCORD_CONFIG.GUILD_ID);
    if (!guild) {
      throw new Error('Discord guild not found');
    }

    // Try to find the member
    let member: GuildMember;
    try {
      member = await guild.members.fetch(discordUserId);
    } catch (error) {
      logger.warn(`User ${username} (${discordUserId}) not found in Discord server for welcome message`, { error: error instanceof Error ? error.message : String(error) });
      return;
    }

    // Send welcome DM
    try {
      const user = await client.users.fetch(discordUserId);
      await user.send(DISCORD_CONFIG.WELCOME_MESSAGE(username));
      logger.info(`Sent welcome DM to ${username}`);
    } catch (error) {
      logger.warn(`Failed to send welcome DM to ${username}, trying channel message:`, error);
      
      // Fallback: send message in welcome channel if configured
      if (DISCORD_CONFIG.WELCOME_CHANNEL_ID) {
        try {
          const welcomeChannel = await guild.channels.fetch(DISCORD_CONFIG.WELCOME_CHANNEL_ID) as TextChannel;
          if (welcomeChannel) {
            await welcomeChannel.send(`${member} ${DISCORD_CONFIG.WELCOME_MESSAGE(username)}`);
            logger.info(`Sent welcome message in channel for ${username}`);
          }
        } catch (channelError) {
          logger.warn(`Failed to send welcome message in channel for ${username}:`, channelError);
        }
      }
    }

    // Assign auto role if configured
    if (DISCORD_CONFIG.AUTO_ROLE_ID) {
      try {
        const role = await guild.roles.fetch(DISCORD_CONFIG.AUTO_ROLE_ID);
        if (role && !member.roles.cache.has(DISCORD_CONFIG.AUTO_ROLE_ID)) {
          await member.roles.add(role, `Auto-role for Discord OAuth user ${username}`);
          logger.info(`Assigned auto-role to ${username}`);
        }
      } catch (roleError) {
        logger.warn(`Failed to assign auto-role to ${username}:`, roleError);
      }
    }
  } catch (error) {
    logger.error(`Failed to send welcome message to ${username}:`, error);
  }
};

// Handle user joining via OAuth (called from auth webhook)
export const handleDiscordOAuthJoin = async (
  clerkUserId: string, 
  discordUserId: string, 
  userEmail: string, 
  username: string
): Promise<{ inviteUrl?: string; alreadyMember?: boolean }> => {
  try {
    logger.info(`Handling Discord OAuth join for user ${userEmail} (Clerk: ${clerkUserId}, Discord: ${discordUserId})`);

    const client = await initializeDiscordClient();
    
    if (!DISCORD_CONFIG.GUILD_ID) {
      throw new Error('Discord guild ID not configured');
    }

    const guild = await client.guilds.fetch(DISCORD_CONFIG.GUILD_ID);
    if (!guild) {
      throw new Error('Discord guild not found');
    }

    // Check if user is already in the server
    try {
      const existingMember = await guild.members.fetch(discordUserId);
      if (existingMember) {
        logger.info(`User ${userEmail} is already a member, sending welcome message`);
        await sendWelcomeMessage(discordUserId, username);
        return { alreadyMember: true };
      }
    } catch (error) {
      // User not in server, continue with invite creation
      logger.info(`User ${userEmail} not in server, creating invite`, { error: error instanceof Error ? error.message : String(error) });
    }

    // Create invite for the user
    const inviteUrl = await createDiscordInvite(clerkUserId, userEmail);
    
    return { inviteUrl };
  } catch (error) {
    logger.error(`Failed to handle Discord OAuth join for ${userEmail}:`, error);
    throw error;
  }
};

// Cleanup function to properly disconnect Discord client
export const cleanupDiscordClient = async (): Promise<void> => {
  if (discordClient) {
    await discordClient.destroy();
    discordClient = null;
    logger.info('Discord client disconnected');
  }
}; 