import crypto from 'crypto';
import { GetObjectCommand, PutObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { config } from './config.js';
import { s3Client } from './s3.js';

export async function streamToString(stream) {
    const chunks = [];
    for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString('utf-8');
}

export function md5Newline(value) {
    return crypto.createHash('md5').update(`${value}\n`, 'utf8').digest('hex');
}

export async function readJsonFromR2(key, fallbackValue) {
    try {
        const command = new GetObjectCommand({
            Bucket: config.R2.BUCKET_NAME,
            Key: key
        });
        const result = await s3Client.send(command);
        if (!result.Body) return fallbackValue;
        const bodyString = await streamToString(result.Body);
        return bodyString ? JSON.parse(bodyString) : fallbackValue;
    } catch (err) {
        if (err.name === 'NoSuchKey') return fallbackValue;
        console.error(`Error reading ${key} from R2:`, err);
        return fallbackValue;
    }
}

export async function writeJsonToR2(key, value) {
    try {
        const body = JSON.stringify(value ?? {}, null, 2);
        const command = new PutObjectCommand({
            Bucket: config.R2.BUCKET_NAME,
            Key: key,
            Body: body,
            ContentType: 'application/json',
            CacheControl: 'no-store'
        });
        await s3Client.send(command);
    } catch (err) {
        console.error(`Error writing ${key} to R2:`, err);
    }
}

export async function listAllObjects(prefix, bucket = config.R2.BUCKET_NAME) {
    let token = undefined;
    const out = [];
    while (true) {
        const res = await s3Client.send(new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            ContinuationToken: token
        }));
        for (const obj of res.Contents || []) {
            if (obj?.Key && !obj.Key.endsWith('/')) out.push(obj);
        }
        if (!res.IsTruncated) break;
        token = res.NextContinuationToken;
        if (!token) break;
    }
    return out;
}

export async function listTopLevelFolders(bucket = config.R2.BUCKET_NAME) {
    let token = undefined;
    const folders = [];
    const seen = new Set();

    while (true) {
        const out = await s3Client.send(new ListObjectsV2Command({
            Bucket: bucket,
            Delimiter: '/',
            ContinuationToken: token
        }));

        for (const p of out.CommonPrefixes || []) {
            const pref = p?.Prefix;
            if (!pref) continue;
            const name = pref.endsWith('/') ? pref.slice(0, -1) : pref;
            if (!name) continue;
            if (seen.has(name)) continue;
            seen.add(name);
            folders.push(name);
        }

        if (!out.IsTruncated) break;
        token = out.NextContinuationToken;
        if (!token) break;
    }

    return folders;
}
