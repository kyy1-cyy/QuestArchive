import express from 'express';
import { config } from '../utils/config.js';
import { readDB, writeDB, makePublicId } from '../utils/db.js';
import { requireAdmin, ensureEnv } from '../utils/auth.js';
import { ensureMd5MapFresh } from '../utils/md5-map.js';
import { logger } from '../utils/logger.js';
import { runMigration, getMigrationStatus } from '../utils/migration.js';
import { sendWebhook } from '../utils/discord.js';

const router = express.Router();

router.get('/database', async (req, res, next) => {
    if (!requireAdmin(req, res)) return;
    try {
        const games = await readDB();
        res.json(games);
    } catch (err) {
        next(err);
    }
});

router.post('/database', async (req, res, next) => {
    if (!requireAdmin(req, res)) return;
    
    const { title, version, description, thumbnailUrl, hashId } = req.body;
    if (!title || !hashId) {
        return res.status(400).json({ error: 'Title and Hash ID are required' });
    }
    if (hashId && !/^[a-f0-9]{32}$/i.test(String(hashId))) {
        return res.status(400).json({ error: 'hashId must be a 32-character hex MD5' });
    }

    const newGame = {
        id: makePublicId(),
        publicId: makePublicId(),
        title,
        version: version || '1.0',
        description: description || '',
        thumbnailUrl: thumbnailUrl || '',
        hashId: hashId.trim().toLowerCase(),
        lastUpdated: new Date().toISOString(),
        downloads: 0
    };

    try {
        const games = await readDB();
        games.push(newGame);
        await writeDB(games);
        res.status(201).json(newGame);
        
        sendWebhook(newGame);
    } catch (err) {
        next(err);
    }
});

router.post('/database/bulk-delete', async (req, res, next) => {
    if (!requireAdmin(req, res)) return;

    const { ids } = req.body;
    if (!Array.isArray(ids)) {
        return res.status(400).json({ error: 'Invalid payload' });
    }

    try {
        let games = await readDB();
        games = games.filter(g => !ids.includes(g.id));
        await writeDB(games);
        res.json({ success: true });
    } catch (err) {
        next(err);
    }
});

export default router;
