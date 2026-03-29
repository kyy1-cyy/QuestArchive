import express from 'express';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../utils/config.js';
import { s3Client } from '../utils/s3.js';
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

async function checkObjectExists(key) {
    try {
        const { HeadObjectCommand } = await import('@aws-sdk/client-s3');
        await s3Client.send(new HeadObjectCommand({
            Bucket: config.R2.BUCKET_NAME,
            Key: key
        }));
        return true;
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
            downloads: Number(g.downloads || 0)
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

        // Use the internal proxy URL instead of direct R2 link
        const url = `/api/download/${game.publicId}`;

        // We still need to know the file size for chunk planning
        const fileKey = await resolveGameFileKey(game) || (game.title.toLowerCase().endsWith('.zip') ? game.title : `${game.title}.zip`);
        
        let fileSize = null;
        try {
            const { HeadObjectCommand } = await import('@aws-sdk/client-s3');
            const head = await s3Client.send(new HeadObjectCommand({ Bucket: config.R2.BUCKET_NAME, Key: fileKey }));
            fileSize = head.ContentLength;
        } catch (_) { }

        const CHUNK_SIZE = 10 * 1024 * 1024;
        let chunks = [];
        if (fileSize && fileSize > CHUNK_SIZE) {
            const totalChunks = Math.ceil(fileSize / CHUNK_SIZE);
            for (let i = 0; i < totalChunks; i++) {
                const start = i * CHUNK_SIZE;
                const end = Math.min(start + CHUNK_SIZE - 1, fileSize - 1);
                chunks.push({ index: i, start, end });
            }
        }

        res.json({
            title: game.title,
            url, 
            fileSize,
            chunkSize: CHUNK_SIZE,
            chunks,
            supportsRange: fileSize !== null
        });
    } catch (err) {
        next(err);
    }
});

router.get('/download-info-by-title', async (req, res, next) => {
    if (!ensureCloudflare(req, res)) return;
    try {
        const games = await readDB();
        const game = findGameByTitle(games, req.query.title);
        if (!game) return res.status(404).json({ error: 'Game not found' });

        issueDownloadTicket(req, res, game.publicId);

        const url = `/api/download/${game.publicId}`;

        const fileKey = await resolveGameFileKey(game) || (game.title.toLowerCase().endsWith('.zip') ? game.title : `${game.title}.zip`);

        let fileSize = null;
        try {
            const { HeadObjectCommand } = await import('@aws-sdk/client-s3');
            const head = await s3Client.send(new HeadObjectCommand({ Bucket: config.R2.BUCKET_NAME, Key: fileKey }));
            fileSize = head.ContentLength;
        } catch (_) { }

        const CHUNK_SIZE = 10 * 1024 * 1024;
        let chunks = [];
        if (fileSize && fileSize > CHUNK_SIZE) {
            const totalChunks = Math.ceil(fileSize / CHUNK_SIZE);
            for (let i = 0; i < totalChunks; i++) {
                const start = i * CHUNK_SIZE;
                const end = Math.min(start + CHUNK_SIZE - 1, fileSize - 1);
                chunks.push({ index: i, start, end });
            }
        }

        res.json({
            title: game.title,
            url,
            fileSize,
            chunkSize: CHUNK_SIZE,
            chunks,
            supportsRange: fileSize !== null
        });
    } catch (err) {
        next(err);
    }
});

import { findKeyByHash } from '../utils/md5-map.js';

router.get('/download/:id', downloadLimiter, async (req, res, next) => {
    if (!ensureCloudflare(req, res)) return;
    try {
        const games = await readDB();
        const reqId = req.params.id;
        const game = games.find(g => g.publicId === reqId) || games.find(g => g.id === reqId);

        if (!game) return res.status(404).send('Game not found');

        try {
            if (!requireDownloadTicket(req, res, game.publicId)) {
                return res.status(403).send('Download link expired. Please click download again.');
            }
            // Rolling Ticket: Refresh the cookie timer for another 3 minutes!
            issueDownloadTicket(req, res, game.publicId);

            const fileKey = await resolveGameFileKey(game);
            if (!fileKey) return res.status(404).send('File not found');
            await streamFromR2(fileKey, req, res, game.id);
        } catch (s3Err) {
            throw s3Err;
        }
    } catch (err) {
        next(err);
    }
});

async function streamFromR2(key, req, res, gameId) {
    const command = new GetObjectCommand({
        Bucket: config.R2.BUCKET_NAME,
        Key: key,
        Range: req.headers.range
    });

    const s3Res = await s3Client.send(command);
    
    if (s3Res.ContentRange) res.setHeader('Content-Range', s3Res.ContentRange);
    if (s3Res.AcceptRanges) res.setHeader('Accept-Ranges', s3Res.AcceptRanges);
    if (s3Res.ContentType) res.setHeader('Content-Type', s3Res.ContentType);
    if (s3Res.ContentLength) res.setHeader('Content-Length', s3Res.ContentLength);
    
    res.status(s3Res.$metadata.httpStatusCode || 200);
    
    if (!req.headers.range) {
        incrementDownloadCount(gameId).catch(e => logger.error('Incr error', e));
    }

    if (s3Res.Body) {
        s3Res.Body.pipe(res);
    } else {
        res.end();
    }
}

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
