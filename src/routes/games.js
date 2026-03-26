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

function encodeKeyForPublicUrl(key) {
    return key.split('/').map(encodeURIComponent).join('/');
}

function resolveFileKey(game) {
    const hashId = String(game.hashId || '').trim().toLowerCase();
    if (/^[a-f0-9]{32}$/.test(hashId)) {
        return `${hashId}.zip`;
    }
    const title = String(game.title || '').trim();
    return title.toLowerCase().endsWith('.zip') ? title : `${title}.zip`;
}

async function buildDownloadUrl(fileKey) {
    if (config.R2.PUBLIC_DOMAIN) {
        return `${config.R2.PUBLIC_DOMAIN}/${encodeKeyForPublicUrl(fileKey)}`;
    }
    const command = new GetObjectCommand({
        Bucket: config.R2.BUCKET_NAME,
        Key: fileKey
    });
    return getSignedUrl(s3Client, command, { expiresIn: 3600 });
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

        if (!game) {
            return res.status(404).json({ error: 'Game not found' });
        }

        const fileKey = resolveFileKey(game);
        const url = await buildDownloadUrl(fileKey);

        let fileSize = null;
        try {
            const headRes = await fetch(url, { method: 'HEAD' });
            if (headRes.ok) {
                const cl = headRes.headers.get('content-length');
                if (cl) fileSize = parseInt(cl, 10);
            }
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

router.get('/download/:id', downloadLimiter, async (req, res, next) => {
    try {
        const games = await readDB();
        const reqId = String(req.params.id || '');
        const game = games.find(g => g.publicId === reqId) || games.find(g => g.id === reqId);

        if (!game) {
            return res.status(404).send('Game not found');
        }

        const fileKey = resolveFileKey(game);
        const url = await buildDownloadUrl(fileKey);

        incrementDownloadCount(game.id).catch(err => {
            logger.error('Failed to increment download count', { error: err.message, gameId: game.id });
        });

        res.redirect(302, url);
    } catch (err) {
        next(err);
    }
});

export default router;
