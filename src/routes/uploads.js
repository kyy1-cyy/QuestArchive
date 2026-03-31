import express from 'express';
import { CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../utils/config.js';
import { s3Client } from '../utils/s3.js';
import { requireAdmin, ensureEnv } from '../utils/auth.js';
import { logger } from '../utils/logger.js';
import { hashId, readJsonFromB2, writeJsonToB2 } from '../utils/s3-helpers.js';
import { refreshBucketFileCache } from '../utils/db.js';

const router = express.Router();

router.get('/hash', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const filename = String(req.query.filename || '');
    if (!filename || !filename.toLowerCase().endsWith('.zip')) {
        return res.status(400).json({ error: 'filename (.zip) is required' });
    }
    const baseName = filename.split('/').pop().replace(/\.zip$/i, '');
    const hash = hashId(baseName);
    res.json({ hash, fileName: filename.split('/').pop() });
});

router.post('/init', async (req, res, next) => {
    if (!requireAdmin(req, res)) return;
    if (!ensureEnv(req, res, ['B2.ENDPOINT', 'B2.KEY_ID', 'B2.APP_KEY', 'B2.BUCKET_NAME'])) return;

    const { filename, prefix } = req.body ?? {};
    if (!filename || typeof filename !== 'string') {
        return res.status(400).json({ error: 'filename is required' });
    }
    if (!filename.toLowerCase().endsWith('.zip')) {
        return res.status(400).json({ error: 'Only .zip files are allowed' });
    }

    const cleanFilename = filename.replace(/[\\/]/g, '_').trim();
    const cleanPrefix = (typeof prefix === 'string' ? prefix : '').trim().replace(/^\//, '').replace(/\\/g, '/');
    const finalName = cleanFilename;
    const key = cleanPrefix ? `${cleanPrefix.replace(/\/+$/, '')}/${finalName}` : finalName;

    try {
        const command = new CreateMultipartUploadCommand({
            Bucket: config.B2.BUCKET_NAME,
            Key: key,
            ContentType: 'application/zip'
        });
        const result = await s3Client.send(command);
        const baseName = finalName.replace(/\.zip$/i, '');
        res.json({ uploadId: result.UploadId, key, hash: hashId(baseName), fileName: finalName });
    } catch (err) {
        next(err);
    }
});

router.post('/part-url', async (req, res, next) => {
    if (!requireAdmin(req, res)) return;
    if (!ensureEnv(req, res, ['B2.ENDPOINT', 'B2.KEY_ID', 'B2.APP_KEY', 'B2.BUCKET_NAME'])) return;

    const { key, uploadId, partNumber } = req.body ?? {};
    if (!key || !uploadId || !partNumber) {
        return res.status(400).json({ error: 'key, uploadId, partNumber are required' });
    }

    try {
        const command = new UploadPartCommand({
            Bucket: config.B2.BUCKET_NAME,
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
            Bucket: config.B2.BUCKET_NAME,
            Key: key,
            UploadId: uploadId,
            MultipartUpload: { Parts: parts }
        });
        await s3Client.send(command);

        if (String(key).toLowerCase().endsWith('.zip')) {
            const baseName = String(key).split('/').pop().replace(/\.zip$/i, '');
            const hash = hashId(baseName);
            const map = await readJsonFromB2(config.B2.MD5_MAP_KEY, {});
            map[hash] = String(key).split('/').pop();
            await writeJsonToB2(config.B2.MD5_MAP_KEY, map);
        }

        // Trigger cache refresh in background
        refreshBucketFileCache().catch(e => logger.error('Cache refresh after upload failed', e));

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
            Bucket: config.B2.BUCKET_NAME,
            Key: key,
            UploadId: uploadId
        }));
        res.json({ success: true });
    } catch (err) {
        next(err);
    }
});

export default router;
