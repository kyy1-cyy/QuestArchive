import express from 'express';
import rateLimit from 'express-rate-limit';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../utils/config.js';
import { s3Client } from '../utils/s3.js';
import { readDB, incrementDownloadCount } from '../utils/db.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

const downloadLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 5,
    message: { error: 'Download limit exceeded. Please wait a minute.' },
    standardHeaders: true,
    legacyHeaders: false,
});

async function resolveGameFileKey(game) {
    const hashId = String(game.hashId || '').trim().toLowerCase();
    
    // Strategy 1: MD5 named zip
    if (/^[a-f0-9]{32}$/.test(hashId)) {
        const key = `${hashId}.zip`;
        const exists = await checkObjectExists(key);
        if (exists) return key;
        
        // Strategy 2: Lookup in MD5 map
        const mapped = await findKeyByHash(hashId);
        if (mapped && await checkObjectExists(mapped)) return mapped;
    }

    // Strategy 3: Original Title fallback
    const titleKey = game.title.toLowerCase().endsWith('.zip') ? game.title : `${game.title}.zip`;
    if (await checkObjectExists(titleKey)) return titleKey;

    return null;
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
        res.json(games);
    } catch (err) {
        next(err);
    }
});

router.get('/download-info/:id', async (req, res, next) => {
    try {
        const games = await readDB();
        const reqId = String(req.params.id || '');
        const game = games.find(g => g.publicId === reqId) || games.find(g => g.id === reqId);

        if (!game) return res.status(404).json({ error: 'Game not found' });

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
            fileKey,
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
    try {
        const games = await readDB();
        const reqId = req.params.id;
        const game = games.find(g => g.publicId === reqId) || games.find(g => g.id === reqId);

        if (!game) return res.status(404).send('Game not found');

        const hashId = String(game.hashId || '').trim().toLowerCase();
        let fileKey = null;

        // Strategy 1: Try MD5-named zip directly
        if (/^[a-f0-9]{32}$/.test(hashId)) {
            fileKey = `${hashId}.zip`;
        } else {
            fileKey = game.title.toLowerCase().endsWith('.zip') ? game.title : `${game.title}.zip`;
        }
        
        try {
            // Attempt to stream the primary key
            await streamFromR2(fileKey, req, res, game.id);
        } catch (s3Err) {
            // Strategy 2: If primary key fails, try looking up the original name in the MD5 map
            if (s3Err.name === 'NoSuchKey' && /^[a-f0-9]{32}$/.test(hashId)) {
                const mappedKey = await findKeyByHash(hashId);
                if (mappedKey && mappedKey !== fileKey) {
                    try {
                        return await streamFromR2(mappedKey, req, res, game.id);
                    } catch (secondErr) {
                        return res.status(404).send(`File not found: ${fileKey} or ${mappedKey}`);
                    }
                }
            }
            if (s3Err.name === 'NoSuchKey') {
                return res.status(404).send(`File not found: ${fileKey}`);
            }
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
    
    incrementDownloadCount(gameId).catch(e => logger.error('Incr error', e));

    if (s3Res.Body) {
        s3Res.Body.pipe(res);
    } else {
        res.end();
    }
}

export default router;
