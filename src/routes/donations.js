import express from 'express';
import SftpClient from 'ssh2-sftp-client';
import { requireAdmin } from '../utils/auth.js';

const router = express.Router();

function sanitizeFilename(name) {
    const base = String(name || '').replace(/[\\/]/g, '_').trim();
    return base.replace(/[^\w.\- ]+/g, '_').slice(0, 180) || 'upload.zip';
}

function makeDonationKey(filename) {
    return sanitizeFilename(filename).replace(/\s+/g, '_').toLowerCase();
}

async function getSftpClient() {
    const sftp = new SftpClient();
    await sftp.connect({
        host: process.env.ULTRACC_HOST,
        username: process.env.ULTRACC_USER,
        password: process.env.ULTRACC_PASS,
        port: 22, // Always use robust port 22 for Ultra.cc SSH/SFTP
        readyTimeout: 20000,
        retries: 2
    });
    return sftp;
}

function getDonationsDir() {
    const raw = process.env.ULTRACC_DONATIONS_DIR || 'Quest Donations';
    // Strip leading slashes to prevent SFTP from touching the Linux root /
    return raw.replace(/^\/+/, '');
}

router.get('/check-status', async (req, res) => {
    const packageName = String(req.query.package || '').trim();
    const clientVersion = parseInt(req.query.version || '0', 10);

    if (!packageName) return res.status(400).json({ error: 'package is required' });

    try {
        const { readDB } = await import('../utils/db.js');
        const games = await readDB();

        const existingGame = games.find(g => 
            (g.packageName && g.packageName === packageName) || 
            (g.fileKey && g.fileKey.includes(packageName))
        );

        let serverVersion = 0;
        if (existingGame) {
            serverVersion = parseInt(existingGame.versionCode || existingGame.version || '0', 10);
        } else {
            try {
                const sftp = await getSftpClient();
                const dir = getDonationsDir();
                const exists = await sftp.exists(dir);
                if (exists) {
                    const list = await sftp.list(dir);
                    const rawMatch = list.find(obj => obj.name.toLowerCase().includes(packageName.toLowerCase()));
                    if (rawMatch) {
                        const vMatch = rawMatch.name.match(/v(\d+)/i);
                        serverVersion = vMatch ? parseInt(vMatch[1], 10) : 1; 
                    }
                }
                await sftp.end();
            } catch (e) {
                // Ignore search errors
            }
        }

        if (serverVersion > 0) {
            if (clientVersion > serverVersion) {
                return res.json({ status: 'update', message: `Update found! You have v${clientVersion}, we have v${serverVersion}.`, serverVersion });
            } else if (clientVersion === serverVersion) {
                return res.json({ status: 'exists', message: `We already have v${serverVersion} of this game.`, serverVersion });
            } else {
                return res.json({ status: 'older', message: `Archive has a newer version (v${serverVersion}). You have v${clientVersion}.`, serverVersion });
            }
        }

        res.json({ status: 'new', message: 'New game! Feel free to donate.' });
    } catch (err) {
        console.error('[DONO] check-status error:', err);
        res.status(500).json({ error: 'Failed to verify archive status. Please try again.' });
    }
});

router.post('/init', async (req, res, next) => {
    if (!process.env.ULTRACC_HOST) return res.status(500).json({ error: 'Ultracc SFTP not configured in .env' });

    const { filename } = req.body ?? {};
    if (!filename || typeof filename !== 'string') return res.status(400).json({ error: 'filename is required' });
    if (!filename.toLowerCase().endsWith('.zip')) return res.status(400).json({ error: 'Only .zip files are allowed' });

    const key = makeDonationKey(filename);
    const uploadId = `_tmp_${Date.now()}_${key}`;

    try {
        const sftp = await getSftpClient();
        const dir = getDonationsDir();
        const exists = await sftp.exists(dir);
        if (!exists) await sftp.mkdir(dir, true);
        
        await sftp.put(Buffer.alloc(0), `${dir}/${uploadId}`);
        await sftp.end();

        res.json({ uploadId: uploadId, key });
    } catch (err) {
        next(err);
    }
});

router.put('/put-part', async (req, res, next) => {
    if (!process.env.ULTRACC_HOST) return res.status(500).json({ error: 'Ultracc SFTP not configured' });
    const key = String(req.query.key || '');
    const uploadId = String(req.query.uploadId || '');
    const partNumber = Number(req.query.partNumber || 0);

    if (!key || !uploadId || !partNumber) return res.status(400).json({ error: 'key, uploadId, partNumber required' });

    try {
        const sftp = await getSftpClient();
        const dir = getDonationsDir();
        
        // Append chunk stream directly using SFTP append
        await sftp.append(req, `${dir}/${uploadId}`);
        await sftp.end();

        res.json({ ETag: `part-${partNumber}` });
    } catch (err) {
        console.error(`[DONO SFTP] Part ${partNumber} fail:`, err.message);
        res.status(500).json({ error: err.message });
    }
});

router.post('/complete', async (req, res, next) => {
    if (!process.env.ULTRACC_HOST) return res.status(500).json({ error: 'Ultracc SFTP not configured' });
    const { key, uploadId } = req.body ?? {};
    if (!key || !uploadId) return res.status(400).json({ error: 'Missing data' });

    try {
        const sftp = await getSftpClient();
        const dir = getDonationsDir();
        
        await sftp.rename(`${dir}/${uploadId}`, `${dir}/${key}`);
        await sftp.end();

        res.json({ success: true });
    } catch (err) {
        next(err);
    }
});

router.post('/abort', async (req, res, next) => {
    if (!process.env.ULTRACC_HOST) return res.status(500).json({ error: 'Ultracc SFTP not configured' });
    const { key, uploadId } = req.body ?? {};
    if (!key || !uploadId) return res.status(400).json({ error: 'Missing data' });

    try {
        const sftp = await getSftpClient();
        const dir = getDonationsDir();
        await sftp.delete(`${dir}/${uploadId}`).catch(() => {});
        await sftp.end();
        res.json({ success: true });
    } catch (err) {
        next(err);
    }
});

router.get('/list', async (req, res, next) => {
    if (!requireAdmin(req, res)) return;
    try {
        const sftp = await getSftpClient();
        const dir = getDonationsDir();
        const exists = await sftp.exists(dir);
        if (!exists) await sftp.mkdir(dir, true);
        
        const list = await sftp.list(dir);
        await sftp.end();

        const items = list
            .filter(o => o.type === '-' && o.name.toLowerCase().endsWith('.zip') && !o.name.startsWith('_tmp_'))
            .map(o => ({
                key: o.name,
                lastModified: new Date(o.modifyTime || Date.now()).toISOString(),
                size: o.size
            }))
            .sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified));
            
        res.json({ items });
    } catch (err) {
        next(err);
    }
});

router.get('/download-url', async (req, res, next) => {
    if (!requireAdmin(req, res)) return;
    const key = String(req.query.key || '');
    if (!key) return res.status(400).json({ error: 'Invalid key' });

    try {
        res.json({ url: `/api/donations/download-proxy?key=${encodeURIComponent(key)}` });
    } catch (err) {
        next(err);
    }
});

router.get('/download-proxy', async (req, res, next) => {
    if (!requireAdmin(req, res)) return;
    const key = String(req.query.key || '');
    if (!key) return res.status(400).json({ error: 'Invalid key' });

    try {
        const sftp = await getSftpClient();
        const dir = getDonationsDir();
        
        res.setHeader('Content-Disposition', `attachment; filename="${key}"`);
        res.setHeader('Content-Type', 'application/zip');
        
        await sftp.get(`${dir}/${key}`, res);
        await sftp.end();
    } catch (err) {
        next(err);
    }
});

export default router;
