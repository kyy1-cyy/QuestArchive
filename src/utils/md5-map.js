import { config } from './config.js';
import { s3Client } from './s3.js';
import { hashId, readJsonFromB2, writeJsonToB2 } from './s3-helpers.js';
import { getBucketFileCache } from './db.js';

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
        const zipKeys = (await getBucketFileCache())
            .filter(key => key && key.toLowerCase().endsWith('.zip'));

        const newMap = {};
        for (const key of zipKeys) {
            const fileName = String(key).split('/').pop() || String(key);
            const base = fileName.replace(/\.zip$/i, '');
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
    const needsSync = force || (!md5MapState.map) || (age > 30 * 60 * 1000);

    if (needsSync && !md5MapState.syncing) {
        md5MapState.syncing = doSyncMd5Map();
    }

    // Never block current request for a background sync unless specifically 'forced'
    if (force) await md5MapState.syncing;
    
    if (md5MapState.map) return md5MapState.map;

    // Last resort: read from B2 directly if we have nothing in memory
    const primary = await readJsonFromB2(config.B2.MD5_MAP_KEY, null);
    if (primary !== null) {
        md5MapState.map = primary || {};
        md5MapState.lastSyncAt = Date.now();
        return md5MapState.map;
    }
    return {};
}

export async function findKeyByHash(hash) {
    // Note: ensureMd5MapFresh will trigger a background sync, but WON'T wait for it to finish
    // unless the map is completely null.
    const map = await ensureMd5MapFresh({ force: false });
    const originalName = map[hash];
    if (!originalName) return null;
    return originalName.toLowerCase().endsWith('.zip') ? originalName : `${originalName}.zip`;
}
