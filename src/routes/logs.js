import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import { requireAdmin, requireSystemAdmin } from '../utils/auth.js';
import { config } from '../utils/config.js';
import { readJsonFromR2, writeJsonToR2 } from '../utils/s3-helpers.js';

const router = express.Router();

router.get('/server-logs', async (req, res, next) => {
    if (!requireAdmin(req, res)) return;
    try {
        const logPath = path.join(config.PATHS.ROOT, 'logs', 'combined.log');
        const content = await fs.readFile(logPath, 'utf8');
        const lines = content.trim().split('\n').reverse().slice(0, 100);
        res.json({ logs: lines.map(l => {
            try { return JSON.parse(l); } catch { return { message: l }; }
        })});
    } catch (err) {
        if (err.code === 'ENOENT') return res.json({ logs: [] });
        next(err);
    }
});

router.get('/silent-logs', async (req, res, next) => {
    if (!requireSystemAdmin(req, res)) return;
    try {
        let logs = await readJsonFromR2(config.B2.SILENT_LOGS_KEY, []);
        if (!Array.isArray(logs)) logs = [];
        res.json({ logs });
    } catch (err) {
        next(err);
    }
});

router.post('/silent-logs/clear', async (req, res, next) => {
    // Owner-only: even admins cannot clear logs
    const { getAuthenticatedUser } = await import('../utils/auth.js');
    const user = getAuthenticatedUser(req);
    if (!user || user.role !== 'owner') return res.status(404).send('Not Found');
    try {
        await writeJsonToR2(config.B2.SILENT_LOGS_KEY, []);
        res.json({ success: true });
    } catch (err) {
        next(err);
    }
});

export default router;
