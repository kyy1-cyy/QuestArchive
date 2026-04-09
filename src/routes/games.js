import express from 'express';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Readable } from 'stream';
import https from 'https';
import http from 'http';
import { config } from '../utils/config.js';
import { s3Client } from '../utils/s3.js';
import { getBucketFileCache, readDB, incrementDownloadCount } from '../utils/db.js';
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
    // Priority 1: DIRECT FILE KEY from database.json (Secret aliasing)
    if (game.fileKey && await checkObjectExists(game.fileKey)) return game.fileKey;

    // Priority 2: Fallback to hashId if we haven't migrated this entry yet
    const hashId = String(game.hashId || '').trim().toLowerCase();
    if (/^[a-f0-9]{32}$/.test(hashId)) {
        const { findKeyByHash } = await import('../utils/md5-map.js');
        const mapped = await findKeyByHash(hashId);
        if (mapped && await checkObjectExists(mapped)) return mapped;
    }

    // Priority 3: Blind title guess
    const titleKey = game.title.toLowerCase().endsWith('.zip') ? game.title : `${game.title}.zip`;
    if (await checkObjectExists(titleKey)) return titleKey;

    return null;
}

function issueDownloadTicket(req, res, id) {
    const token = jwt.sign(
        { dl: true, id: String(id) },
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

function requireDownloadTicket(req, res, id) {
    const token = req.cookies?.dl_ticket;
    if (!token) return false;
    try {
        const payload = jwt.verify(token, config.JWT_SECRET);
        return Boolean(payload?.dl) && String(payload?.id) === String(id);
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

async function checkObjectExists(key) {
    try {
        const files = await getBucketFileCache();
        return files.includes(key);
    } catch (e) {
        return false;
    }
}

import { getPackageNameFromList } from '../utils/game-list.js';

router.get('/games', async (req, res, next) => {
    try {
        const games = await readDB();
        
        // Optimize: Pre-fetch and cache the game list results for the entire request
        // This ensures O(1) matching after the first O(G) scan of the CSV
        // But since getPackageNameFromList already has an internal cache, we just call it.
        
        const mappedGames = await Promise.all(games.map(async (g) => {
            let thumb = g.thumbnailUrl || '';
            if (thumb.startsWith('.meta/')) {
                thumb = buildPublicDownloadUrl(thumb);
            }
            
            let size = g.fileSize || 0;
            // If size is missing, try to resolve it from the game list cache
            if (!size && g.fileKey) {
                const result = await getPackageNameFromList(g.fileKey);
                if (result?.fileSize) size = result.fileSize;
            }

            return {
                id: g.id || g.publicId,
                title: g.title || '',
                version: g.version || null,
                description: g.description || '',
                thumbnailUrl: thumb,
                lastUpdated: g.lastUpdated || '',
                downloads: Number(g.downloads || 0),
                fileSize: size
            };
        }));

        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.json(mappedGames);
    } catch (err) {
        next(err);
    }
});

function findGameByTitle(games, title) {
    const t = String(title || '').trim();
    if (!t) return null;
    return games.find(g => String(g.title || '').trim() === t)
        || games.find(g => String(g.title || '').trim().toLowerCase() === t.toLowerCase())
        || null;
}

function encodeObjectKeyForUrl(key) {
    return String(key || '')
        .split('/')
        .filter(Boolean)
        .map(part => encodeURIComponent(part))
        .join('/');
}

function buildPublicDownloadUrl(fileKey) {
    const base = String(config.B2.DOWNLOAD_BASE_URL || '').replace(/\/$/, '');
    if (!base) return '';
    const bucket = encodeURIComponent(String(config.B2.BUCKET_NAME || '').trim());
    const keyPath = encodeObjectKeyForUrl(fileKey);
    if (!bucket || !keyPath) return '';
    return `${base}/${bucket}/${keyPath}`;
}

async function pipeUpstreamToResponse(upstream, res) {
    const headersToCopy = [
        'content-type',
        'content-length',
        'content-range',
        'accept-ranges',
        'etag',
        'last-modified'
    ];
    for (const h of headersToCopy) {
        const v = upstream.headers.get(h);
        if (v) res.setHeader(h, v);
    }

    if (!upstream.body) {
        res.end();
        return;
    }

    Readable.fromWeb(upstream.body).pipe(res);
}

async function sendDownloadInfo(req, res, game) {
    issueDownloadTicket(req, res, game.id || game.publicId);

    const fileKey = await resolveGameFileKey(game) || (game.title.toLowerCase().endsWith('.zip') ? game.title : `${game.title}.zip`);
    
    let fileSize = null;
    let chunks = [];

    try {
        const { HeadObjectCommand } = await import('@aws-sdk/client-s3');
        const head = await s3Client.send(new HeadObjectCommand({ Bucket: config.B2.BUCKET_NAME, Key: fileKey }));
        fileSize = head.ContentLength;
        
        if (fileSize) {
            const chunkSize = 25 * 1024 * 1024;
            let index = 0;
            for (let i = 0; i < fileSize; i += chunkSize) {
                chunks.push({
                    index,
                    start: i,
                    end: Math.min(i + chunkSize - 1, fileSize - 1)
                });
                index += 1;
            }
        }
    } catch (e) {}

    res.json({
        title: game.title,
        url: `/api/download/${game.id || game.publicId}`,
        fileSize,
        supportsRange: true,
        chunks
    });
}

async function serveGameDownload(req, res, game, { requireTicket = true } = {}) {
    const gameId = game.id || game.publicId;
    if (requireTicket && !requireDownloadTicket(req, res, gameId)) {
        res.status(403).send('Download link expired. Please click download again.');
        return;
    }

    issueDownloadTicket(req, res, gameId);

    const fileKey = await resolveGameFileKey(game);
    if (!fileKey) {
        res.status(404).send('File not found');
        return;
    }

    if (!req.headers.range) {
        incrementDownloadCount(gameId).catch(e => logger.error('Incr error', e));
    }

    // Build the upstream URL (Cloudflare proxy or direct B2 presigned)
    let upstreamUrl = buildPublicDownloadUrl(fileKey);
    if (!upstreamUrl) {
        // Fallback: presigned URL directly to B2
        try {
            const command = new GetObjectCommand({
                Bucket: config.B2.BUCKET_NAME,
                Key: fileKey,
                ResponseContentDisposition: `attachment; filename="${game.title.replace(/"/g, '_')}.zip"`
            });
            upstreamUrl = await getSignedUrl(s3Client, command, { expiresIn: 300 });
        } catch (s3Err) {
            res.status(500).send('Storage connection error');
            return;
        }
    }

    // Stream from Cloudflare/B2 to browser via https.get (forces IPv4)
    const parsedUrl = new URL(upstreamUrl);
    const reqModule = parsedUrl.protocol === 'https:' ? https : http;
    const reqOptions = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'GET',
        family: 4,
        headers: {},
        timeout: 300000
    };
    if (req.headers.range) reqOptions.headers.Range = req.headers.range;

    const upstream = reqModule.request(reqOptions, (upstreamRes) => {
        res.status(upstreamRes.statusCode);
        const headersToForward = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag'];
        for (const h of headersToForward) {
            if (upstreamRes.headers[h]) res.setHeader(h, upstreamRes.headers[h]);
        }
        res.setHeader('content-disposition', `attachment; filename="${game.title.replace(/"/g, '_')}.zip"`);
        upstreamRes.pipe(res);
    });

    upstream.on('error', (err) => {
        if (!res.headersSent) {
            res.status(500).json({ error: 'fetch failed' });
        }
    });

    upstream.end();
}

router.get('/download-info-by-title', async (req, res, next) => {
    if (!ensureCloudflare(req, res)) return;
    try {
        const games = await readDB();
        const game = findGameByTitle(games, req.query.title);

        if (!game) return res.status(404).json({ error: 'Game not found' });

        await sendDownloadInfo(req, res, game);
    } catch (err) {
        next(err);
    }
});

router.get('/download-info/:id', async (req, res, next) => {
    if (!ensureCloudflare(req, res)) return;
    try {
        const games = await readDB();
        const reqId = String(req.params.id || '');
        const game = games.find(g => g.publicId === reqId) || games.find(g => g.id === reqId);

        if (!game) return res.status(404).json({ error: 'Game not found' });

        await sendDownloadInfo(req, res, game);
    } catch (err) {
        next(err);
    }
});

router.get('/download-by-title', downloadLimiter, async (req, res, next) => {
    if (!ensureCloudflare(req, res)) return;
    try {
        const games = await readDB();
        const game = findGameByTitle(games, req.query.title);

        if (!game) return res.status(404).send('Game not found');

        await serveGameDownload(req, res, game, { requireTicket: false });
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
        await serveGameDownload(req, res, game, { requireTicket: true });
    } catch (err) {
        next(err);
    }
});

router.get('/cache-timestamp', async (req, res) => {
    try {
        const games = await readDB();
        // Create a timestamp based on the latest game update
        const latestTimestamp = games.reduce((latest, game) => {
            const gameTime = new Date(game.lastUpdated || 0).getTime();
            return gameTime > latest ? gameTime : latest;
        }, 0);
        
        res.setHeader('Cache-Control', 'no-cache');
        res.send(latestTimestamp.toString());
    } catch (err) {
        res.status(500).send('0');
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
