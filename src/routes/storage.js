import express from 'express';
import { ListObjectsV2Command, GetObjectCommand, DeleteObjectCommand, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../utils/config.js';
import { s3Client } from '../utils/s3.js';
import { requireAdmin, ensureEnv } from '../utils/auth.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

function encodeKeyForPublicUrl(key) {
    return encodeURIComponent(key).replace(/%2F/g, '/');
}

router.get('/list', async (req, res, next) => {
    if (!requireAdmin(req, res)) return;
    if (!ensureEnv(req, res, ['R2.BUCKET_NAME'])) return;

    const prefix = String(req.query.prefix || '');
    try {
        let token = undefined;
        let allFolders = [];
        let allObjects = [];

        while (true) {
            const command = new ListObjectsV2Command({
                Bucket: config.R2.BUCKET_NAME,
                Prefix: prefix || undefined,
                Delimiter: '/',
                ContinuationToken: token
            });
            const result = await s3Client.send(command);

            if (result.CommonPrefixes) {
                const folders = result.CommonPrefixes.map(p => p.Prefix).filter(Boolean);
                allFolders.push(...folders);
            }

            if (result.Contents) {
                const objects = result.Contents
                    .filter(o => o.Key && o.Key !== prefix && !o.Key.endsWith('/'))
                    .map(o => ({
                        key: o.Key,
                        lastModified: o.LastModified,
                        size: o.Size
                    }));
                allObjects.push(...objects);
            }

            if (!result.IsTruncated) break;
            token = result.NextContinuationToken;
        }

        res.json({
            prefix,
            folders: allFolders,
            objects: allObjects,
            isTruncated: false
        });
    } catch (err) {
        next(err);
    }
});

router.get('/download-url', async (req, res, next) => {
    if (!requireAdmin(req, res)) return;
    const key = String(req.query.key || '');
    if (!key) return res.status(400).json({ error: 'Key required' });

    try {
        if (config.R2.PUBLIC_DOMAIN) {
            return res.json({ url: `${config.R2.PUBLIC_DOMAIN}/${encodeKeyForPublicUrl(key)}` });
        }
        const command = new GetObjectCommand({
            Bucket: config.R2.BUCKET_NAME,
            Key: key
        });
        const url = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
        res.json({ url });
    } catch (err) {
        next(err);
    }
});

router.post('/delete', async (req, res, next) => {
    if (!requireAdmin(req, res)) return;
    const { key, prefix } = req.body ?? {};

    try {
        if (key) {
            await s3Client.send(new DeleteObjectCommand({ Bucket: config.R2.BUCKET_NAME, Key: key }));
            return res.json({ success: true });
        }
        if (prefix) {
            let deleted = 0;
            let token = undefined;
            while (true) {
                const list = await s3Client.send(new ListObjectsV2Command({
                    Bucket: config.R2.BUCKET_NAME,
                    Prefix: prefix,
                    ContinuationToken: token
                }));
                const keys = (list.Contents || []).map(o => ({ Key: o.Key }));
                if (keys.length > 0) {
                    await s3Client.send(new DeleteObjectsCommand({
                        Bucket: config.R2.BUCKET_NAME,
                        Delete: { Objects: keys }
                    }));
                    deleted += keys.length;
                }
                if (!list.IsTruncated) break;
                token = list.NextContinuationToken;
            }
            return res.json({ success: true, deleted });
        }
        res.status(400).json({ error: 'Key or prefix required' });
    } catch (err) {
        next(err);
    }
});

router.post('/bulk-delete', async (req, res, next) => {
    if (!requireAdmin(req, res)) return;
    const { keys, prefixes } = req.body ?? {};
    const keyList = Array.isArray(keys) ? keys.filter(Boolean) : [];
    const prefixList = Array.isArray(prefixes) ? prefixes.filter(Boolean) : [];

    try {
        let deletedKeys = 0;
        let deletedFromPrefixes = 0;

        if (keyList.length) {
            for (let i = 0; i < keyList.length; i += 1000) {
                const slice = keyList.slice(i, i + 1000).map(k => ({ Key: k }));
                await s3Client.send(new DeleteObjectsCommand({
                    Bucket: config.R2.BUCKET_NAME,
                    Delete: { Objects: slice }
                }));
                deletedKeys += slice.length;
            }
        }

        if (prefixList.length) {
            for (const prefix of prefixList) {
                let token = undefined;
                while (true) {
                    const list = await s3Client.send(new ListObjectsV2Command({
                        Bucket: config.R2.BUCKET_NAME,
                        Prefix: prefix,
                        ContinuationToken: token
                    }));
                    const objs = (list.Contents || []).map(o => ({ Key: o.Key })).filter(o => o.Key);
                    if (objs.length) {
                        for (let i = 0; i < objs.length; i += 1000) {
                            const slice = objs.slice(i, i + 1000);
                            await s3Client.send(new DeleteObjectsCommand({
                                Bucket: config.R2.BUCKET_NAME,
                                Delete: { Objects: slice }
                            }));
                            deletedFromPrefixes += slice.length;
                        }
                    }
                    if (!list.IsTruncated) break;
                    token = list.NextContinuationToken;
                }
            }
        }

        res.json({ success: true, deletedKeys, deletedFromPrefixes });
    } catch (err) {
        next(err);
    }
});

export default router;
