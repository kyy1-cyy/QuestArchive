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
        const logPath = path.join(config.PATHS.DATA, 'silent_logs.json');
        const data = await fs.readFile(logPath, 'utf8').catch(() => '[]');
        res.json({ logs: JSON.parse(data || '[]') });
    } catch (err) {
        res.json({ logs: [] });
    }
});

router.post('/silent-logs/clear', async (req, res, next) => {
    const { getAuthenticatedUser } = await import('../utils/auth.js');
    const user = getAuthenticatedUser(req, res);
    if (!user || user.role !== 'owner') return;
    try {
        const logPath = path.join(config.PATHS.DATA, 'silent_logs.json');
        await fs.writeFile(logPath, '[]');
        res.json({ success: true });
    } catch (err) {
        next(err);
    }
});

export default router;
