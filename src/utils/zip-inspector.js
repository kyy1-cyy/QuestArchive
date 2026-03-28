import yauzl from 'yauzl';
import { GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { s3Client } from './s3.js';
import { config } from './config.js';
import { PassThrough, Transform } from 'stream';

class ExactBytesTransform extends Transform {
    constructor(length) {
        super();
        this.remaining = length;
    }
    _transform(chunk, encoding, callback) {
        if (this.remaining <= 0) {
            return callback();
        }
        if (chunk.length <= this.remaining) {
            this.remaining -= chunk.length;
            this.push(chunk);
            if (this.remaining === 0) this.push(null);
        } else {
            this.push(chunk.slice(0, this.remaining));
            this.remaining = 0;
            this.push(null);
        }
        callback();
    }
}

class S3RandomAccessReader extends yauzl.RandomAccessReader {
    constructor(bucket, key, totalSize) {
        super();
        this.bucket = bucket;
        this.key = key;
        this.totalSize = totalSize;
        this.activeStreams = new Set();
    }

    _readStreamForRange(offset, length) {
        const passThrough = new PassThrough();
        const end = Math.min(offset + length - 1, this.totalSize - 1);
        const actualLength = end - offset + 1;
        const range = `bytes=${offset}-${end}`;
        
        console.log(`[ZIP] Range request: ${range} for ${this.key} (expected length: ${length}, actual: ${actualLength})`);

        const command = new GetObjectCommand({
            Bucket: this.bucket,
            Key: this.key,
            Range: range
        });

        s3Client.send(command).then(response => {
            if (response.Body) {
                const stream = response.Body;
                this.activeStreams.add(stream);
                
                const exactBytes = new ExactBytesTransform(length);
                
                stream.on('error', (err) => {
                    this.activeStreams.delete(stream);
                    exactBytes.emit('error', err);
                });
                
                stream.on('end', () => {
                    this.activeStreams.delete(stream);
                });
                
                stream.on('close', () => {
                    this.activeStreams.delete(stream);
                });

                stream.pipe(exactBytes).pipe(passThrough);
            } else {
                passThrough.end();
            }
        }).catch(err => {
            console.error(`[ZIP] S3 Range Error for ${range}:`, err.message);
            passThrough.emit('error', err);
            passThrough.end();
        });

        return passThrough;
    }
    
    close(cb) {
        console.log(`[ZIP] Closing reader and safely destroying ${this.activeStreams.size} active S3 sockets.`);
        for (const stream of this.activeStreams) {
            if (typeof stream.destroy === 'function') {
                stream.destroy();
            }
        }
        this.activeStreams.clear();
        if (cb) cb();
    }
}

export async function getPackageNameFromZip(key) {
    try {
        console.log(`[ZIP] Inspecting: ${key}`);
        const head = await s3Client.send(new HeadObjectCommand({
            Bucket: config.R2.BUCKET_NAME,
            Key: key
        }));
        
        const totalSize = head.ContentLength;
        console.log(`[ZIP] Total Size: ${totalSize} bytes`);
        if (!totalSize) return null;

        return new Promise((resolve, reject) => {
            const reader = new S3RandomAccessReader(config.R2.BUCKET_NAME, key, totalSize);
            yauzl.fromRandomAccessReader(reader, totalSize, { lazyEntries: true }, (err, zipfile) => {
                if (err) {
                    console.error('[ZIP] yauzl error:', err.message);
                    reader.close();
                    return reject(err);
                }
                
                let foundPackage = null;
                
                zipfile.readEntry();
                zipfile.on('entry', (entry) => {
                    const fileName = String(entry.fileName || '');
                    console.log(`[ZIP] Entry: ${fileName}`);
                    if (fileName.toLowerCase().endsWith('.apk') && !fileName.includes('/')) {
                        foundPackage = fileName.replace(/\.apk$/i, '');
                        console.log(`[ZIP] Match found: ${foundPackage}`);
                        zipfile.close(); // Triggers reader.close()
                    } else if (fileName.toLowerCase().endsWith('.apk')) {
                        const part = fileName.split('/').pop();
                        if (part.toLowerCase().endsWith('.apk')) {
                           foundPackage = part.replace(/\.apk$/i, '');
                           console.log(`[ZIP] Match found (deep): ${foundPackage}`);
                           zipfile.close(); // Triggers reader.close()
                        } else {
                           zipfile.readEntry();
                        }
                    } else {
                        zipfile.readEntry();
                    }
                });
                
                zipfile.on('end', () => {
                    console.log('[ZIP] Finished scanning entries.');
                    reader.close();
                    resolve(foundPackage);
                });
                
                zipfile.on('error', (err) => {
                    console.error('[ZIP] Stream error:', err.message);
                    reader.close();
                    reject(err);
                });

                zipfile.on('close', () => {
                    reader.close();
                    resolve(foundPackage);
                });
            });
        });
    } catch (err) {
        console.error('[ZIP] Inspection caught error:', err);
        return null;
    }
}
