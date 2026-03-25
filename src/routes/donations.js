import express from 'express';
import { CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../utils/config.js';
import { s3Client } from '../utils/s3.js';
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

router.post('/init', async (req, res, next) => {
    if (!ensureEnv(req, res, ['R2.ENDPOINT', 'R2.ACCESS_KEY_ID', 'R2.SECRET_ACCESS_KEY', 'DONATIONS.BUCKET_NAME'])) return;

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
        const result = await s3Client.send(command);
        res.json({ uploadId: result.UploadId, key });
    } catch (err) {
        next(err);
    }
});

router.post('/part-url', async (req, res, next) => {
    if (!ensureEnv(req, res, ['R2.ENDPOINT', 'R2.ACCESS_KEY_ID', 'R2.SECRET_ACCESS_KEY', 'DONATIONS.BUCKET_NAME'])) return;

    const { key, uploadId, partNumber } = req.body ?? {};
    if (!key || !uploadId || !partNumber) {
        return res.status(400).json({ error: 'key, uploadId, partNumber are required' });
    }

    try {
        const command = new UploadPartCommand({
            Bucket: config.DONATIONS.BUCKET_NAME,
            Key: key,
            UploadId: uploadId,
            PartNumber: Number(partNumber)
        });
        const url = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
        res.json({ url });
    } catch (err) {
        next(err);
    }
});

router.post('/complete', async (req, res, next) => {
    if (!ensureEnv(req, res, ['R2.ENDPOINT', 'R2.ACCESS_KEY_ID', 'R2.SECRET_ACCESS_KEY', 'DONATIONS.BUCKET_NAME'])) return;
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
        await s3Client.send(command);
        res.json({ success: true });
    } catch (err) {
        next(err);
    }
});

router.post('/abort', async (req, res, next) => {
    if (!ensureEnv(req, res, ['R2.ENDPOINT', 'R2.ACCESS_KEY_ID', 'R2.SECRET_ACCESS_KEY', 'DONATIONS.BUCKET_NAME'])) return;
    const { key, uploadId } = req.body ?? {};
    if (!key || !uploadId) return res.status(400).json({ error: 'Missing data' });

    try {
        await s3Client.send(new AbortMultipartUploadCommand({
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
        const result = await s3Client.send(command);
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
        if (config.DONATIONS.PUBLIC_DOMAIN) {
            return res.json({ url: `${config.DONATIONS.PUBLIC_DOMAIN}/${encodeURIComponent(key)}` });
        }
        const command = new GetObjectCommand({
            Bucket: config.DONATIONS.BUCKET_NAME,
            Key: key
        });
        const url = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
        res.json({ url });
    } catch (err) {
        next(err);
    }
});

export default router;
