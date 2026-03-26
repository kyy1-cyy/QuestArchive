import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import { requireAdmin } from '../utils/auth.js';
import { config } from '../utils/config.js';

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

export default router;
