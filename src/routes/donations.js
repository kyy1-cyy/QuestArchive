import express from 'express';
import { CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../utils/config.js';
import { s3DonationsClient } from '../utils/s3.js';
import { requireAdmin, ensureEnv } from '../utils/auth.js';
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
    return `donation/${clean}`;
}

router.get('/check-status', async (req, res) => {
    const packageName = String(req.query.package || '').trim();
    const clientVersion = parseInt(req.query.version || '0', 10);

    if (!packageName) return res.status(400).json({ error: 'package is required' });

    try {
        const { getBucketFileCache, readDB } = await import('../utils/db.js');
        const [allFiles, games] = await Promise.all([getBucketFileCache(), readDB()]);

        // 1. Try to find the package in our current library
        const existingGame = games.find(g => 
            (g.packageName && g.packageName === packageName) || 
            (g.fileKey && g.fileKey.includes(packageName))
        );

        if (existingGame) {
            const serverVersion = parseInt(existingGame.versionCode || existingGame.version || '0', 10);
            
            if (serverVersion > 0 && clientVersion > 0) {
                if (clientVersion > serverVersion) {
                    return res.json({ status: 'update', message: `Update found! You have v${clientVersion}, we have v${serverVersion}.`, serverVersion });
                } else if (clientVersion === serverVersion) {
                    return res.json({ status: 'exists', message: `We already have v${serverVersion} of this game.`, serverVersion });
                } else {
                    return res.json({ status: 'older', message: `You have an older version (v${clientVersion}). We already have v${serverVersion}.`, serverVersion });
                }
            }
            return res.json({ status: 'exists', message: `This game is already in our archive.`, serverVersion });
        }

        // 2. Check if it's already in the archive but not indexed yet
        // We check the raw file list from storage (game_cache.json) for the package name
        const inCache = allFiles.some(f => f.toLowerCase().includes(packageName.toLowerCase()));
        if (inCache) {
            return res.json({ status: 'exists', message: `This game is already in our archive (pending indexing).` });
        }

        res.json({ status: 'new', message: 'New game! Feel free to donate.' });
    } catch (err) {
        console.error('[DONO] check-status error:', err);
        res.json({ status: 'new', message: 'Proceed with upload.' });
    }
});

router.post('/init', async (req, res, next) => {
    if (!ensureEnv(req, res, ['DONATIONS.ENDPOINT', 'DONATIONS.KEY_ID', 'DONATIONS.APP_KEY', 'DONATIONS.BUCKET_NAME'])) return;

    const { filename } = req.body ?? {};
    if (!filename || typeof filename !== 'string') {
        return res.status(400).json({ error: 'filename is required' });
    }
    if (!filename.toLowerCase().endsWith('.zip')) {
        return res.status(400).json({ error: 'Only .zip files are allowed' });
    }

    const key = makeDonationKey(filename);

    try {
        const command = new CreateMultipartUploadCommand({
            Bucket: config.DONATIONS.BUCKET_NAME,
            Key: key,
            ContentType: 'application/zip'
        });
        const result = await s3DonationsClient.send(command);
        res.json({ uploadId: result.UploadId, key });
    } catch (err) {
        next(err);
    }
});

router.put('/put-part', async (req, res, next) => {
    if (!ensureEnv(req, res, ['DONATIONS.ENDPOINT', 'DONATIONS.KEY_ID', 'DONATIONS.APP_KEY', 'DONATIONS.BUCKET_NAME'])) return;
    const key = String(req.query.key || '');
    const uploadId = String(req.query.uploadId || '');
    const partNumber = Number(req.query.partNumber || 0);

    if (!key || !uploadId || !partNumber) {
        return res.status(400).json({ error: 'key, uploadId, partNumber required' });
    }

    const contentLength = parseInt(req.headers['content-length'], 10);
    try {
        const command = new UploadPartCommand({
            Bucket: config.DONATIONS.BUCKET_NAME,
            Key: key,
            UploadId: uploadId,
            PartNumber: partNumber,
            Body: req,
            ContentLength: contentLength
        });
        const result = await s3DonationsClient.send(command);
        res.json({ ETag: result.ETag });
    } catch (err) {
        console.error(`[DONO] Part ${partNumber} fail:`, err.message);
        res.status(500).json({ error: err.message });
    }
});

router.post('/complete', async (req, res, next) => {
    if (!ensureEnv(req, res, ['DONATIONS.ENDPOINT', 'DONATIONS.KEY_ID', 'DONATIONS.APP_KEY', 'DONATIONS.BUCKET_NAME'])) return;
    const { key, uploadId, parts } = req.body ?? {};
    if (!key || !uploadId || !parts) return res.status(400).json({ error: 'Missing data' });

    try {
        const command = new CompleteMultipartUploadCommand({
            Bucket: config.DONATIONS.BUCKET_NAME,
            Key: key,
            UploadId: uploadId,
            MultipartUpload: {
                Parts: parts
                    .map(p => ({ ETag: p.ETag, PartNumber: Number(p.PartNumber) }))
                    .sort((a, b) => a.PartNumber - b.PartNumber)
            }
        });
        await s3DonationsClient.send(command);
        res.json({ success: true });
    } catch (err) {
        next(err);
    }
});

router.post('/abort', async (req, res, next) => {
    if (!ensureEnv(req, res, ['DONATIONS.ENDPOINT', 'DONATIONS.KEY_ID', 'DONATIONS.APP_KEY', 'DONATIONS.BUCKET_NAME'])) return;
    const { key, uploadId } = req.body ?? {};
    if (!key || !uploadId) return res.status(400).json({ error: 'Missing data' });

    try {
        await s3DonationsClient.send(new AbortMultipartUploadCommand({
            Bucket: config.DONATIONS.BUCKET_NAME,
            Key: key,
            UploadId: uploadId
        }));
        res.json({ success: true });
    } catch (err) {
        next(err);
    }
});

router.get('/list', async (req, res, next) => {
    if (!requireAdmin(req, res)) return;
    try {
        const command = new ListObjectsV2Command({
            Bucket: config.DONATIONS.BUCKET_NAME,
            Prefix: 'donation/'
        });
        const result = await s3DonationsClient.send(command);
        const items = (result.Contents || [])
            .filter(o => o.Key && o.Key.toLowerCase().endsWith('.zip'))
            .map(o => ({
                key: o.Key,
                lastModified: o.LastModified ? o.LastModified.toISOString() : null,
                size: o.Size
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
    if (!key || !key.startsWith('donation/')) return res.status(400).json({ error: 'Invalid key' });

    try {
        const command = new GetObjectCommand({
            Bucket: config.DONATIONS.BUCKET_NAME,
            Key: key
        });
        const url = await getSignedUrl(s3DonationsClient, command, { expiresIn: 3600 });
        res.json({ url });
    } catch (err) {
        next(err);
    }
});

export default router;
