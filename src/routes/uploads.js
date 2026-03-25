import express from 'express';
import { CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../utils/config.js';
import { s3Client } from '../utils/s3.js';
import { requireAdmin, ensureEnv } from '../utils/auth.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

router.post('/init', async (req, res, next) => {
    if (!requireAdmin(req, res)) return;
    if (!ensureEnv(req, res, ['R2.ENDPOINT', 'R2.ACCESS_KEY_ID', 'R2.SECRET_ACCESS_KEY', 'R2.BUCKET_NAME'])) return;

    const { filename, prefix, hashId } = req.body ?? {};
    if (!filename || typeof filename !== 'string') {
        return res.status(400).json({ error: 'filename is required' });
    }
    if (!filename.toLowerCase().endsWith('.zip')) {
        return res.status(400).json({ error: 'Only .zip files are allowed' });
    }
    if (hashId && !/^[a-f0-9]{32}$/i.test(String(hashId))) {
        return res.status(400).json({ error: 'hashId must be a 32-character hex MD5' });
    }

    const cleanFilename = filename.replace(/[\\/]/g, '_').trim();
    const cleanPrefix = (typeof prefix === 'string' ? prefix : '').trim().replace(/^\//, '').replace(/\\/g, '/');
    const finalName = hashId ? `${String(hashId).toLowerCase()}.zip` : cleanFilename;
    const key = cleanPrefix ? `${cleanPrefix.replace(/\/+$/, '')}/${finalName}` : finalName;

    try {
        const command = new CreateMultipartUploadCommand({
            Bucket: config.R2.BUCKET_NAME,
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
    if (!requireAdmin(req, res)) return;
    if (!ensureEnv(req, res, ['R2.ENDPOINT', 'R2.ACCESS_KEY_ID', 'R2.SECRET_ACCESS_KEY', 'R2.BUCKET_NAME'])) return;

    const { key, uploadId, partNumber } = req.body ?? {};
    if (!key || !uploadId || !partNumber) {
        return res.status(400).json({ error: 'key, uploadId, partNumber are required' });
    }

    try {
        const command = new UploadPartCommand({
            Bucket: config.R2.BUCKET_NAME,
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
    if (!requireAdmin(req, res)) return;
    const { key, uploadId, parts } = req.body ?? {};
    if (!key || !uploadId || !parts) {
        return res.status(400).json({ error: 'key, uploadId, parts are required' });
    }

    try {
        const command = new CompleteMultipartUploadCommand({
            Bucket: config.R2.BUCKET_NAME,
            Key: key,
            UploadId: uploadId,
            MultipartUpload: { Parts: parts }
        });
        await s3Client.send(command);
        res.json({ success: true });
    } catch (err) {
        next(err);
    }
});

router.post('/abort', async (req, res, next) => {
    if (!requireAdmin(req, res)) return;
    const { key, uploadId } = req.body ?? {};
    if (!key || !uploadId) return res.status(400).json({ error: 'key and uploadId are required' });

    try {
        await s3Client.send(new AbortMultipartUploadCommand({
            Bucket: config.R2.BUCKET_NAME,
            Key: key,
            UploadId: uploadId
        }));
        res.json({ success: true });
    } catch (err) {
        next(err);
    }
});

export default router;
