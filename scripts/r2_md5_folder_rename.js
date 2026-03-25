import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import {
  S3Client,
  ListObjectsV2Command,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCopyCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  DeleteObjectsCommand
} from '@aws-sdk/client-s3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const args = new Set(process.argv.slice(2));
const execute = args.has('--execute');

const bucket = process.env.R2_BUCKET_NAME;
const endpoint = process.env.R2_ENDPOINT;
const accessKeyId = process.env.R2_ACCESS_KEY_ID;
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;

if (!bucket || !endpoint || !accessKeyId || !secretAccessKey) {
  throw new Error('Missing env vars: R2_BUCKET_NAME, R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY');
}

function endpointBase(raw) {
  const u = new URL(raw);
  return `${u.protocol}//${u.host}`;
}

const s3 = new S3Client({
  region: 'auto',
  endpoint: endpointBase(endpoint),
  credentials: { accessKeyId, secretAccessKey }
});

function md5Newline(name) {
  return crypto.createHash('md5').update(`${name}\n`, 'utf8').digest('hex');
}

function isMd5Folder(name) {
  return /^[a-f0-9]{32}$/i.test(name);
}

function encodeCopySource(bucketName, key) {
  const encodedKey = encodeURIComponent(key).replace(/%2F/g, '/');
  return `${bucketName}/${encodedKey}`;
}

async function* listAllTopLevelPrefixes() {
  let token = undefined;
  const seen = new Set();

  while (true) {
    const out = await s3.send(new ListObjectsV2Command({
      Bucket: bucket,
      Delimiter: '/',
      ContinuationToken: token
    }));

    for (const p of out.CommonPrefixes || []) {
      if (p?.Prefix && !seen.has(p.Prefix)) {
        seen.add(p.Prefix);
        yield p.Prefix;
      }
    }

    if (!out.IsTruncated) break;
    token = out.NextContinuationToken;
    if (!token) break;
  }
}

async function* listAllObjects(prefix) {
  let token = undefined;
  while (true) {
    const out = await s3.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      ContinuationToken: token
    }));

    for (const obj of out.Contents || []) {
      if (obj?.Key && !obj.Key.endsWith('/')) yield obj;
    }

    if (!out.IsTruncated) break;
    token = out.NextContinuationToken;
    if (!token) break;
  }
}

async function targetPrefixExists(prefix) {
  const out = await s3.send(new ListObjectsV2Command({
    Bucket: bucket,
    Prefix: prefix,
    MaxKeys: 1
  }));
  return Array.isArray(out.Contents) && out.Contents.length > 0;
}

async function multipartCopy({ sourceKey, destKey, size }) {
  const create = await s3.send(new CreateMultipartUploadCommand({
    Bucket: bucket,
    Key: destKey
  }));
  const uploadId = create.UploadId;
  if (!uploadId) throw new Error('Missing uploadId');

  const partSize = 256 * 1024 * 1024;
  const partCount = Math.ceil(size / partSize);
  const parts = [];

  try {
    const concurrency = 4;
    let nextPart = 1;

    const worker = async () => {
      while (true) {
        const partNumber = nextPart++;
        if (partNumber > partCount) return;
        const start = (partNumber - 1) * partSize;
        const end = Math.min(start + partSize, size) - 1;
        const out = await s3.send(new UploadPartCopyCommand({
          Bucket: bucket,
          Key: destKey,
          UploadId: uploadId,
          PartNumber: partNumber,
          CopySource: encodeCopySource(bucket, sourceKey),
          CopySourceRange: `bytes=${start}-${end}`
        }));
        const etag = out.CopyPartResult?.ETag;
        if (!etag) throw new Error(`Missing ETag for part ${partNumber}`);
        parts.push({ ETag: etag, PartNumber: partNumber });
      }
    };

    await Promise.all(Array.from({ length: concurrency }, worker));

    parts.sort((a, b) => a.PartNumber - b.PartNumber);
    await s3.send(new CompleteMultipartUploadCommand({
      Bucket: bucket,
      Key: destKey,
      UploadId: uploadId,
      MultipartUpload: { Parts: parts }
    }));
  } catch (err) {
    await s3.send(new AbortMultipartUploadCommand({
      Bucket: bucket,
      Key: destKey,
      UploadId: uploadId
    }));
    throw err;
  }
}

async function copyObject({ sourceKey, destKey, size }) {
  if (size != null && size > 4.5 * 1024 * 1024 * 1024) {
    await multipartCopy({ sourceKey, destKey, size });
    return;
  }

  await s3.send(new CopyObjectCommand({
    Bucket: bucket,
    Key: destKey,
    CopySource: encodeCopySource(bucket, sourceKey)
  }));
}

async function deleteKeys(keys) {
  if (!keys.length) return;
  for (let i = 0; i < keys.length; i += 1000) {
    const chunk = keys.slice(i, i + 1000);
    await s3.send(new DeleteObjectsCommand({
      Bucket: bucket,
      Delete: { Objects: chunk.map(Key => ({ Key })), Quiet: true }
    }));
  }
}

async function main() {
  const mappings = [];
  const plan = [];

  for await (const prefix of listAllTopLevelPrefixes()) {
    const folder = prefix.replace(/\/$/, '');
    if (!folder) continue;
    if (isMd5Folder(folder)) continue;

    const hash = md5Newline(folder);
    const newPrefix = `${hash}/`;
    if (await targetPrefixExists(newPrefix)) {
      plan.push({ folder, hash, from: prefix, to: newPrefix, skipped: true, reason: 'target exists' });
      continue;
    }

    plan.push({ folder, hash, from: prefix, to: newPrefix, skipped: false });
    mappings.push(`${hash} | ${folder}`);
  }

  const outPath = path.join(__dirname, '..', 'data', 'folder_md5_map.txt');
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, mappings.join('\n') + (mappings.length ? '\n' : ''), 'utf8');

  if (!execute) {
    process.stdout.write(`Planned renames: ${plan.filter(p => !p.skipped).length} (skipped: ${plan.filter(p => p.skipped).length})\n`);
    process.stdout.write(`Wrote mapping: ${outPath}\n`);
    process.stdout.write('Dry run only. Re-run with --execute to copy+delete objects.\n');
    return;
  }

  for (const item of plan) {
    if (item.skipped) continue;

    const toCopy = [];
    for await (const obj of listAllObjects(item.from)) {
      const sourceKey = obj.Key;
      const destKey = `${item.to}${sourceKey.slice(item.from.length)}`;
      toCopy.push({ sourceKey, destKey, size: obj.Size ?? null });
    }

    for (const c of toCopy) {
      await copyObject(c);
    }

    await deleteKeys(toCopy.map(c => c.sourceKey));
    process.stdout.write(`Renamed: ${item.from} -> ${item.to} (${toCopy.length} objects)\n`);
  }

  process.stdout.write(`Done. Mapping file: ${outPath}\n`);
}

await main();
