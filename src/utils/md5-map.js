import { config } from './config.js';
import { s3Client } from './s3.js';
import { md5Newline, readJsonFromR2, writeJsonToR2, listTopLevelFolders } from './s3-helpers.js';

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
        const folders = await listTopLevelFolders();
        console.log(`[MD5 Sync] Found folders: ${folders.length}`);

        const { ListObjectsV2Command } = await import('@aws-sdk/client-s3');
        const objectsRes = await s3Client.send(new ListObjectsV2Command({
            Bucket: config.R2.BUCKET_NAME,
            Delimiter: '/'
        }));

        const items = new Set(folders);
        const contents = objectsRes.Contents || [];
        console.log(`[MD5 Sync] Found top-level objects: ${contents.length}`);

        contents.forEach(obj => {
            if (obj.Key && !obj.Key.endsWith('/')) {
                const name = obj.Key.replace(/\.zip$/i, '');
                if (name) items.add(name);
            }
        });

        console.log(`[MD5 Sync] Total unique items to map: ${items.size}`);

        const newMap = {};
        for (const item of items) {
            newMap[md5Newline(item)] = item;
        }

        const remote = await readJsonFromR2(config.R2.MD5_MAP_KEY, {});
        console.log(`[MD5 Sync] Remote map keys: ${Object.keys(remote).length}`);

        if (!shallowEqualObject(newMap, remote)) {
            console.log('[MD5 Sync] Maps differ, writing update to R2...');
            await writeJsonToR2(config.R2.MD5_MAP_KEY, newMap);
        } else {
            console.log('[MD5 Sync] No changes detected in map.');
        }
        md5MapState.map = newMap;
        if (!shallowEqualObject(newMap, remote)) {
            await writeJsonToR2(config.R2.MD5_MAP_KEY, newMap);
        }
        md5MapState.map = newMap;
        md5MapState.lastSyncAt = Date.now();
    } catch (err) {
        console.error('Error syncing MD5 map:', err);
        if (!md5MapState.map) {
            md5MapState.map = await readJsonFromR2(config.R2.MD5_MAP_KEY, {});
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

    return readJsonFromR2(config.R2.MD5_MAP_KEY, {});
}
