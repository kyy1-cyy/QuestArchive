import express from 'express';
import { config } from '../utils/config.js';
import { requireAdmin, ensureEnv } from '../utils/auth.js';
import { ensureMd5MapFresh } from '../utils/md5-map.js';
import { logger } from '../utils/logger.js';
import { runMigration, getMigrationStatus } from '../utils/migration.js';

const router = express.Router();

router.get('/md5-map', async (req, res, next) => {
    if (!requireAdmin(req, res)) return;
    if (!ensureEnv(req, res, ['B2.ENDPOINT', 'B2.KEY_ID', 'B2.APP_KEY'])) return;

    try {
        const force = String(req.query.force || '') === '1';
        const map = await ensureMd5MapFresh({ force });
        const items = Object.entries(map)
            .map(([hash, folder]) => ({ hash, folder }))
            .sort((a, b) => a.folder.localeCompare(b.folder));

        res.json({ items, key: config.B2.MD5_MAP_KEY });
    } catch (err) {
        next(err);
    }
});

router.post('/migrate/start', async (req, res, next) => {
    if (!requireAdmin(req, res)) return;
    runMigration().catch(err => logger.error('Migration failed', { error: err.message }));
    res.json({ success: true, message: 'Migration started in background' });
});

router.get('/migrate/status', (req, res) => {
    if (!requireAdmin(req, res)) return;
    res.json(getMigrationStatus());
});

export default router;
