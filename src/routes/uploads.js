import { CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
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
    console.log(`[UPLOAD] Hash computed: ${hash} for file: ${filename}`);
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

    console.log(`[UPLOAD] Init multipart: key=${key}, bucket=${config.B2.BUCKET_NAME}`);

    try {
        const command = new CreateMultipartUploadCommand({
            Bucket: config.B2.BUCKET_NAME,
            Key: key,
            ContentType: 'application/zip'
        });
        const result = await s3Client.send(command);
        const baseName = finalName.replace(/\.zip$/i, '');
        console.log(`[UPLOAD] Multipart created: uploadId=${result.UploadId}`);
        res.json({ uploadId: result.UploadId, key, hash: hashId(baseName), fileName: finalName });
    } catch (err) {
        console.error(`[UPLOAD] Init FAILED:`, err.message);
        next(err);
    }
});

// Server-side part upload: browser sends part here, server forwards to B2
// This avoids CORS issues entirely - browser never talks to B2 directly
router.put('/put-part', async (req, res, next) => {
    if (!requireAdmin(req, res)) return;

    const key = String(req.query.key || '');
    const uploadId = String(req.query.uploadId || '');
    const partNumber = Number(req.query.partNumber || 0);

    if (!key || !uploadId || !partNumber) {
        return res.status(400).json({ error: 'key, uploadId, partNumber query params required' });
    }

    const contentLength = parseInt(req.headers['content-length'], 10);
    console.log(`[UPLOAD] put-part: part=${partNumber}, size=${(contentLength/1024/1024).toFixed(1)}MB, key=${key}`);
    const startTime = Date.now();

    try {
        // Stream directly to B2 — no buffering in memory
        const command = new UploadPartCommand({
            Bucket: config.B2.BUCKET_NAME,
            Key: key,
            UploadId: uploadId,
            PartNumber: partNumber,
            Body: req,
            ContentLength: contentLength
        });
        const result = await s3Client.send(command);
        console.log(`[UPLOAD] part ${partNumber}: done in ${Date.now() - startTime}ms, ETag=${result.ETag}`);

        res.json({ ETag: result.ETag });
    } catch (err) {
        console.error(`[UPLOAD] part ${partNumber} FAILED:`, err.message);
        res.status(500).json({ error: `Part ${partNumber} upload failed: ${err.message}` });
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
        console.log(`[UPLOAD] Presigned URL generated for part ${partNumber}`);
        res.json({ url });
    } catch (err) {
        console.error(`[UPLOAD] part-url FAILED:`, err.message);
        next(err);
    }
});

router.post('/complete', async (req, res, next) => {
    if (!requireAdmin(req, res)) return;
    const { key, uploadId, parts } = req.body ?? {};
    if (!key || !uploadId || !parts) {
        return res.status(400).json({ error: 'key, uploadId, parts are required' });
    }

    console.log(`[UPLOAD] Complete START: key=${key}, ${parts.length} parts`);
    const startTime = Date.now();

    try {
        const command = new CompleteMultipartUploadCommand({
            Bucket: config.B2.BUCKET_NAME,
            Key: key,
            UploadId: uploadId,
            MultipartUpload: { Parts: parts }
        });
        await s3Client.send(command);
        console.log(`[UPLOAD] CompleteMultipart done in ${Date.now() - startTime}ms`);

        if (String(key).toLowerCase().endsWith('.zip')) {
            const baseName = String(key).split('/').pop().replace(/\.zip$/i, '');
            const hash = hashId(baseName);
            const mapStart = Date.now();
            const map = await readJsonFromB2(config.B2.MD5_MAP_KEY, {});
            map[hash] = String(key);
            await writeJsonToB2(config.B2.MD5_MAP_KEY, map);
            console.log(`[UPLOAD] MD5 map updated in ${Date.now() - mapStart}ms: ${hash} -> ${key}`);
        }

        refreshBucketFileCache().catch(e => logger.error('Cache refresh after upload failed', e));

        console.log(`[UPLOAD] Complete TOTAL: ${Date.now() - startTime}ms`);
        res.json({ success: true });
    } catch (err) {
        console.error(`[UPLOAD] Complete FAILED:`, err.message);
        next(err);
    }
});

router.put('/direct', async (req, res, next) => {
    if (!requireAdmin(req, res)) return;
    if (!ensureEnv(req, res, ['B2.ENDPOINT', 'B2.KEY_ID', 'B2.APP_KEY', 'B2.BUCKET_NAME'])) return;

    const filename = String(req.query.filename || '').trim();
    const prefix = String(req.query.prefix || '').trim();

    if (!filename || !filename.toLowerCase().endsWith('.zip')) {
        return res.status(400).json({ error: 'filename (.zip) is required' });
    }

    const cleanFilename = filename.replace(/[\\/]/g, '_').trim();
    const cleanPrefix = prefix.replace(/^\//, '').replace(/\\/g, '/');
    const finalName = cleanFilename;
    const key = cleanPrefix ? `${cleanPrefix.replace(/\/+$/, '')}/${finalName}` : finalName;

    console.log(`[UPLOAD] Direct upload START: key=${key}`);

    try {
        const uploader = new Upload({
            client: s3Client,
            params: {
                Bucket: config.B2.BUCKET_NAME,
                Key: key,
                Body: req,
                ContentType: 'application/zip'
            },
            partSize: 200 * 1024 * 1024,
            queueSize: 4,
            leavePartsOnError: false
        });
        
        await uploader.done();

        const baseName = finalName.replace(/\.zip$/i, '');
        const hash = hashId(baseName);
        res.json({ success: true, key, hash, fileName: finalName });

        // Post-upload updates
        setImmediate(async () => {
            try {
                const map = await readJsonFromB2(config.B2.MD5_MAP_KEY, {});
                map[hash] = String(key);
                await writeJsonToB2(config.B2.MD5_MAP_KEY, map);
                await refreshBucketFileCache();
            } catch (e) {
                logger.error('Post-upload update failed', e);
            }
        });
    } catch (err) {
        console.error(`[UPLOAD] Direct upload FAILED:`, err.message);
        next(err);
    }
});

router.post('/abort', async (req, res, next) => {
    if (!requireAdmin(req, res)) return;
    const { key, uploadId } = req.body ?? {};
    if (!key || !uploadId) return res.status(400).json({ error: 'key and uploadId are required' });

    console.log(`[UPLOAD] Aborting: key=${key}`);
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
