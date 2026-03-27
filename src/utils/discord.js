import { config } from './config.js';
import { logger } from './logger.js';

export async function sendWebhook(game) {
    if (!config.DISCORD_WEBHOOK_URL) {
        return;
    }

    try {
        const payload = {
            content: `**New Game Added to Archive**`,
            embeds: [
                {
                    title: game.title,
                    description: game.description || 'No description provided.',
                    color: 3447003,
                    fields: [
                        { name: 'Version', value: game.version || '1.0', inline: true },
                        { name: 'Hash ID', value: game.hashId || 'Unknown', inline: true }
                    ],
                    thumbnail: game.thumbnailUrl ? { url: game.thumbnailUrl } : undefined,
                    timestamp: new Date().toISOString()
                }
            ]
        };

        const response = await fetch(config.DISCORD_WEBHOOK_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            logger.error(`Discord webhook failed with status ${response.status}`);
        }
    } catch (err) {
        logger.error('Failed to send Discord webhook:', err);
    }
}
