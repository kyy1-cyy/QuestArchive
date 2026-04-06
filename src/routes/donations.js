import express from 'express';
import { Client } from 'basic-ftp';
import { config } from '../utils/config.js';
import { requireAdmin } from '../utils/auth.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

function sanitizeFilename(name) {
    const base = String(name || '').replace(/[\\/]/g, '_').trim();
    return base.replace(/[^\w.\- ]+/g, '_').slice(0, 180) || 'upload.zip';
}

function makeDonationKey(filename) {
    const clean = sanitizeFilename(filename)
        .replace(/\s+/g, '_')
        .replace(/_+/g, '_')
        .toLowerCase();
    return clean;
}

async function getFtpClient() {
    const client = new Client();
    await client.access({
        host: process.env.ULTRACC_HOST,
        user: process.env.ULTRACC_USER,
        password: process.env.ULTRACC_PASS,
        port: parseInt(process.env.ULTRACC_PORT || '21', 10),
        secure: false
    });
    return client;
}

router.get('/check-status', async (req, res) => {
    const packageName = String(req.query.package || '').trim();
    const clientVersion = parseInt(req.query.version || '0', 10);

    if (!packageName) return res.status(400).json({ error: 'package is required' });

    try {
        const { readDB } = await import('../utils/db.js');
        const games = await readDB();

        // 1. Check Library Database
        const existingGame = games.find(g => 
            (g.packageName && g.packageName === packageName) || 
            (g.fileKey && g.fileKey.includes(packageName))
        );

        let serverVersion = 0;
        if (existingGame) {
            serverVersion = parseInt(existingGame.versionCode || existingGame.version || '0', 10);
        } else {
            // Check FTP to see if someone already donated it
            try {
                const client = await getFtpClient();
                const dir = process.env.ULTRACC_DONATIONS_DIR || '/Quest Donations';
                await client.ensureDir(dir);
                const list = await client.list(dir);
                const rawMatch = list.find(obj => obj.name.toLowerCase().includes(packageName.toLowerCase()));
                if (rawMatch) {
                    const vMatch = rawMatch.name.match(/v(\d+)/i);
                    serverVersion = vMatch ? parseInt(vMatch[1], 10) : 1; 
                }
                client.close();
            } catch (e) {
                // Ignore FTP search errors for donations check
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
    if (!process.env.ULTRACC_HOST) return res.status(500).json({ error: 'Ultracc FTP not configured in .env' });

    const { filename } = req.body ?? {};
    if (!filename || typeof filename !== 'string') {
        return res.status(400).json({ error: 'filename is required' });
    }
    if (!filename.toLowerCase().endsWith('.zip')) {
        return res.status(400).json({ error: 'Only .zip files are allowed' });
    }

    const key = makeDonationKey(filename);
    const uploadId = `_tmp_${Date.now()}_${key}`;

    try {
        const client = await getFtpClient();
        const dir = process.env.ULTRACC_DONATIONS_DIR || '/Quest Donations';
        await client.ensureDir(dir);
        
        // Ensure empty file to begin appending
        const emptyBuf = Buffer.alloc(0);
        const { Readable } = await import('stream');
        const emptyStream = Readable.from(emptyBuf);
        await client.uploadFrom(emptyStream, `${dir}/${uploadId}`);
        client.close();

        res.json({ uploadId: uploadId, key });
    } catch (err) {
        next(err);
    }
});

router.put('/put-part', async (req, res, next) => {
    if (!process.env.ULTRACC_HOST) return res.status(500).json({ error: 'Ultracc FTP not configured' });
    const key = String(req.query.key || '');
    const uploadId = String(req.query.uploadId || '');
    const partNumber = Number(req.query.partNumber || 0);

    if (!key || !uploadId || !partNumber) {
        return res.status(400).json({ error: 'key, uploadId, partNumber required' });
    }

    try {
        const client = await getFtpClient();
        const dir = process.env.ULTRACC_DONATIONS_DIR || '/Quest Donations';
        await client.cd(dir);
        
        // Append chunk stream directly to the temp file
        await client.appendFrom(req, uploadId);
        client.close();

        res.json({ ETag: `part-${partNumber}` });
    } catch (err) {
        console.error(`[DONO FTP] Part ${partNumber} fail:`, err.message);
        res.status(500).json({ error: err.message });
    }
});

router.post('/complete', async (req, res, next) => {
    if (!process.env.ULTRACC_HOST) return res.status(500).json({ error: 'Ultracc FTP not configured' });
    const { key, uploadId } = req.body ?? {};
    if (!key || !uploadId) return res.status(400).json({ error: 'Missing data' });

    try {
        const client = await getFtpClient();
        const dir = process.env.ULTRACC_DONATIONS_DIR || '/Quest Donations';
        await client.cd(dir);
        
        // Rename the temp file to the final key
        await client.rename(uploadId, key);
        client.close();

        res.json({ success: true });
    } catch (err) {
        next(err);
    }
});

router.post('/abort', async (req, res, next) => {
    if (!process.env.ULTRACC_HOST) return res.status(500).json({ error: 'Ultracc FTP not configured' });
    const { key, uploadId } = req.body ?? {};
    if (!key || !uploadId) return res.status(400).json({ error: 'Missing data' });

    try {
        const client = await getFtpClient();
        const dir = process.env.ULTRACC_DONATIONS_DIR || '/Quest Donations';
        await client.cd(dir);
        await client.remove(uploadId).catch(() => {});
        client.close();
        res.json({ success: true });
    } catch (err) {
        next(err);
    }
});

router.get('/list', async (req, res, next) => {
    if (!requireAdmin(req, res)) return;
    try {
        const client = await getFtpClient();
        const dir = process.env.ULTRACC_DONATIONS_DIR || '/Quest Donations';
        await client.ensureDir(dir);
        const list = await client.list(dir);
        client.close();

        const items = list
            .filter(o => o.type === 1 && o.name.toLowerCase().endsWith('.zip') && !o.name.startsWith('_tmp_'))
            .map(o => ({
                key: o.name,
                lastModified: new Date(o.modifiedAt || Date.now()).toISOString(),
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
        // Instead of presigned URL, we just proxy it since FTP has no presigned URLs
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
        const client = await getFtpClient();
        const dir = process.env.ULTRACC_DONATIONS_DIR || '/Quest Donations';
        await client.cd(dir);
        
        res.setHeader('Content-Disposition', `attachment; filename="${key}"`);
        res.setHeader('Content-Type', 'application/zip');
        
        // Pass response as writable stream
        await client.downloadTo(res, key);
        client.close();
    } catch (err) {
        next(err);
    }
});

export default router;
