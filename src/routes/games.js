import express from 'express';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../utils/config.js';
import { s3Client, s3DownloadClient } from '../utils/s3.js';
import { readDB, incrementDownloadCount } from '../utils/db.js';
import { ensureCloudflare } from '../utils/auth.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

const downloadLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 5,
    message: { error: 'Download limit exceeded. Please wait a minute.' },
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => Boolean(req.headers.range)
});

async function resolveGameFileKey(game) {
    const hashId = String(game.hashId || '').trim().toLowerCase();
    
    if (/^[a-f0-9]{32}$/.test(hashId)) {
        const mapped = await findKeyByHash(hashId);
        if (mapped && await checkObjectExists(mapped)) return mapped;
    }

    const titleKey = game.title.toLowerCase().endsWith('.zip') ? game.title : `${game.title}.zip`;
    if (await checkObjectExists(titleKey)) return titleKey;

    return null;
}

function issueDownloadTicket(req, res, publicId) {
    const token = jwt.sign(
        { dl: true, publicId: String(publicId) },
        config.JWT_SECRET,
        { expiresIn: '3m' }
    );

    res.cookie('dl_ticket', token, {
        httpOnly: true,
        secure: req.hostname !== 'localhost' && req.hostname !== '127.0.0.1',
        sameSite: 'lax',
        path: '/api',
        maxAge: 3 * 60 * 1000
    });
}

function requireDownloadTicket(req, res, publicId) {
    const token = req.cookies?.dl_ticket;
    if (!token) return false;
    try {
        const payload = jwt.verify(token, config.JWT_SECRET);
        return Boolean(payload?.dl) && String(payload?.publicId) === String(publicId);
    } catch {
        return false;
    }
}

const usedDownloadTickets = new Map();
function markTicketUsed(token) {
    usedDownloadTickets.set(token, Date.now());
    if (usedDownloadTickets.size > 2000) {
        const entries = Array.from(usedDownloadTickets.entries()).sort((a, b) => a[1] - b[1]);
        for (const [k] of entries.slice(0, 500)) usedDownloadTickets.delete(k);
    }
}

function isTicketUsed(token) {
    const ts = usedDownloadTickets.get(token);
    if (!ts) return false;
    if (Date.now() - ts > 5 * 60 * 1000) {
        usedDownloadTickets.delete(token);
        return false;
    }
    return true;
}

import { findKeyByHash } from '../utils/md5-map.js';
import { getBucketFileCache, incrementDownloadCount } from '../utils/db.js';

async function checkObjectExists(key) {
    try {
        const files = await getBucketFileCache();
        return files.includes(key);
    } catch (e) {
        return false;
    }
}

router.get('/games', async (req, res, next) => {
    try {
        const games = await readDB();
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.json(games.map(g => ({
            title: g.title || '',
            version: g.version || '1.0',
            description: g.description || '',
            thumbnailUrl: g.thumbnailUrl || '',
            lastUpdated: g.lastUpdated || '',
            downloads: Number(g.downloads || 0),
            publicId: g.publicId
        })));
    } catch (err) {
        next(err);
    }
});

function findGameByTitle(games, title) {
    const t = String(title || '').trim();
    if (!t) return null;
    return games.find(g => String(g.title || '').trim() === t) || null;
}

router.get('/download-info/:id', async (req, res, next) => {
    if (!ensureCloudflare(req, res)) return;
    try {
        const games = await readDB();
        const reqId = String(req.params.id || '');
        const game = games.find(g => g.publicId === reqId) || games.find(g => g.id === reqId);

        if (!game) return res.status(404).json({ error: 'Game not found' });

        issueDownloadTicket(req, res, game.publicId);

        const url = `/api/download/${game.publicId}`;
        const fileKey = await resolveGameFileKey(game) || (game.title.toLowerCase().endsWith('.zip') ? game.title : `${game.title}.zip`);
        
        let fileSize = null;
        try {
            // Direct call for info is only done once per download
            const { HeadObjectCommand } = await import('@aws-sdk/client-s3');
            const head = await s3Client.send(new HeadObjectCommand({ Bucket: config.B2.BUCKET_NAME, Key: fileKey }));
            fileSize = head.ContentLength;
        } catch (_) { }

        res.json({
            title: game.title,
            url, 
            fileSize,
            supportsRange: true
        });
    } catch (err) {
        next(err);
    }
});

router.get('/download/:id', downloadLimiter, async (req, res, next) => {
    if (!ensureCloudflare(req, res)) return;
    try {
        const games = await readDB();
        const reqId = req.params.id;
        const game = games.find(g => g.publicId === reqId) || games.find(g => g.id === reqId);

        if (!game) return res.status(404).send('Game not found');

        if (!requireDownloadTicket(req, res, game.publicId)) {
            return res.status(403).send('Download link expired. Please click download again.');
        }

        // Rolling ticket refresh
        issueDownloadTicket(req, res, game.publicId);

        const fileKey = await resolveGameFileKey(game);
        if (!fileKey) return res.status(404).send('File not found');

        // B2 Strategy: 302 Redirect to a short-lived presigned URL (fast & secure)
        try {
            const command = new GetObjectCommand({
                Bucket: config.B2.BUCKET_NAME,
                Key: fileKey,
                ResponseContentDisposition: `attachment; filename="${game.title.replace(/"/g, '_')}.zip"`
            });

            // URL expires in 60 seconds (just enough for the browser to start the request)
            const signedUrl = await getSignedUrl(s3DownloadClient, command, { expiresIn: 60 });
            
            if (!req.headers.range) {
                incrementDownloadCount(game.publicId).catch(e => logger.error('Incr error', e));
            }

            res.redirect(signedUrl);
        } catch (s3Err) {
            logger.error('Presign error', s3Err);
            res.status(500).send('Storage connection error');
        }
    } catch (err) {
        next(err);
    }
});

router.post('/download-complete', async (req, res) => {
    try {
        const { publicId } = req.body ?? {};
        const pid = String(publicId || '').trim();
        if (!pid) return res.status(400).json({ error: 'publicId is required' });

        const token = req.cookies?.dl_ticket;
        if (!token) return res.status(403).json({ error: 'Expired' });
        if (isTicketUsed(token)) return res.json({ success: true });
        if (!requireDownloadTicket(req, res, pid)) return res.status(403).json({ error: 'Expired' });

        const games = await readDB();
        const game = games.find(g => g.publicId === pid) || null;
        if (!game) return res.status(404).json({ error: 'Game not found' });

        markTicketUsed(token);
        await incrementDownloadCount(game.publicId);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed' });
    }
});

export default router;
