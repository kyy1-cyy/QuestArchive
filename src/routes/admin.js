import express from 'express';
import { config } from '../utils/config.js';
import { readDB, writeDB, makePublicId } from '../utils/db.js';
import { requireAdmin, ensureEnv } from '../utils/auth.js';
import { ensureMd5MapFresh } from '../utils/md5-map.js';
import { logger } from '../utils/logger.js';
import { runMigration, getMigrationStatus } from '../utils/migration.js';

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
    
    const { title, version, description, thumbnailUrl, hashId, category } = req.body;
    if (!title) return res.status(400).json({ error: 'Title is required' });
    if (hashId && !/^[a-f0-9]{32}$/i.test(String(hashId))) {
        return res.status(400).json({ error: 'hashId must be a 32-character hex MD5' });
    }

    const newGame = {
        id: Date.now().toString(),
        publicId: makePublicId(),
        title,
        hashId: hashId ? String(hashId).toLowerCase() : '',
        category: category || 'Uncategorized',
        description: description || '',
        thumbnailUrl: thumbnailUrl || 'https://via.placeholder.com/300x400?text=No+Image'
    };

    try {
        const games = await readDB();
        games.push(newGame);
        await writeDB(games);
        res.status(201).json(newGame);
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

router.get('/md5-map', async (req, res, next) => {
    if (!requireAdmin(req, res)) return;
    if (!ensureEnv(req, res, ['R2.ENDPOINT', 'R2.ACCESS_KEY_ID', 'R2.SECRET_ACCESS_KEY'])) return;

    try {
        const force = String(req.query.force || '') === '1';
        const map = await ensureMd5MapFresh({ force });
        const items = Object.entries(map)
            .map(([hash, folder]) => ({ hash, folder }))
            .sort((a, b) => a.folder.localeCompare(b.folder));

        res.json({ items, key: config.R2.MD5_MAP_KEY });
    } catch (err) {
        next(err);
    }
});

router.post('/migrate/start', async (req, res, next) => {
    if (!requireAdmin(req, res)) return;
    // Don't await the migration, it runs in background
    runMigration().catch(err => logger.error('Migration failed', { error: err.message }));
    res.json({ success: true, message: 'Migration started in background' });
});

router.get('/migrate/status', (req, res) => {
    if (!requireAdmin(req, res)) return;
    res.json(getMigrationStatus());
});

export default router;
