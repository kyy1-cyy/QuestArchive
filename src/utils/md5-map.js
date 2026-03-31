import { config } from './config.js';
import { s3Client } from './s3.js';
import { hashId, readJsonFromB2, writeJsonToB2 } from './s3-helpers.js';

const md5MapState = {
    lastSyncAt: 0,
    syncing: null,
    map: null
};

function shallowEqualObject(a, b) {
    if (a === b) return true;
    if (!a || !b) return false;
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    return ak.every(k => a[k] === b[k]);
}

async function doSyncMd5Map() {
    try {
        const { ListObjectsV2Command } = await import('@aws-sdk/client-s3');
        const zipKeys = [];
        let token = undefined;

        while (true) {
            const objectsRes = await s3Client.send(new ListObjectsV2Command({
                Bucket: config.B2.BUCKET_NAME,
                Delimiter: '/',
                ContinuationToken: token
            }));

            for (const obj of objectsRes.Contents || []) {
                const key = obj?.Key;
                if (!key) continue;
                if (key.includes('/')) continue;
                if (!key.toLowerCase().endsWith('.zip')) continue;
                zipKeys.push(key);
            }

            if (!objectsRes.IsTruncated) break;
            token = objectsRes.NextContinuationToken;
            if (!token) break;
        }

        const newMap = {};
        for (const key of zipKeys) {
            const base = key.replace(/\.zip$/i, '');
            const hash = hashId(base);
            newMap[hash] = key;
        }

        const remote = await readJsonFromB2(config.B2.MD5_MAP_KEY, {});
        if (!shallowEqualObject(newMap, remote)) {
            await writeJsonToB2(config.B2.MD5_MAP_KEY, newMap);
        }

        md5MapState.map = newMap;
        md5MapState.lastSyncAt = Date.now();
    } catch (err) {
        console.error('Error syncing MD5 map:', err);
        if (!md5MapState.map) {
            md5MapState.map = await readJsonFromB2(config.B2.MD5_MAP_KEY, {});
        }
    } finally {
        md5MapState.syncing = null;
    }
}

export async function ensureMd5MapFresh({ force = false } = {}) {
    const now = Date.now();
    const age = now - md5MapState.lastSyncAt;
    const needsSync = force || age > 30 * 60 * 1000;

    if (needsSync && !md5MapState.syncing) {
        md5MapState.syncing = doSyncMd5Map();
    }

    if (force) await md5MapState.syncing;
    if (md5MapState.map) return md5MapState.map;

    const primary = await readJsonFromB2(config.B2.MD5_MAP_KEY, null);
    if (primary !== null) return primary || {};
    return {};
}

export async function findKeyByHash(hash) {
    const map = await ensureMd5MapFresh({ force: false });
    const originalName = map[hash];
    if (!originalName) return null;
    return originalName.toLowerCase().endsWith('.zip') ? originalName : `${originalName}.zip`;
}
