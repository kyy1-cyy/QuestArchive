export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const cache = caches.default;

        // 1. Handle CORS preflight (Crucial for multithreaded Range requests)
        if (request.method === 'OPTIONS') {
            return new Response(null, {
                status: 204,
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'GET, HEAD, PUT, OPTIONS',
                    'Access-Control-Allow-Headers': 'Range, Content-Type, Content-Length, Authorization, X-Amz-Date, X-Amz-Content-Sha256',
                    'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges, ETag',
                    'Access-Control-Max-Age': '86400'
                }
            });
        }

        // 2. Identify the cache key (Include Range to prevent chunk collisions)
        const range = request.headers.get('Range');
        const cacheKey = new Request(request.url, {
            headers: {
                'Range': range || ''
            }
        });

        // 3. Try Cache First
        let response = await cache.match(cacheKey);
        let cacheHit = true;

        if (!response) {
            cacheHit = false;
            // Rewrite host to B2 S3 endpoint
            url.host = 's3.us-west-004.backblazeb2.com';

            response = await fetch(url.toString(), {
                method: request.method,
                headers: request.headers,
                body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : undefined
            });

            // 4. Cache valid range results for 30 days (Eliminates B2 Class B Costs)
            if (response.status === 206 || response.status === 200) {
                response = new Response(response.body, response);
                response.headers.set('Cache-Control', 'public, max-age=2592000');
                ctx.waitUntil(cache.put(cacheKey, response.clone()));
            }
        }

        // 5. Build Final Response with CORS
        const finalResponse = new Response(response.body, response);
        finalResponse.headers.set('Access-Control-Allow-Origin', '*');
        finalResponse.headers.set('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges, ETag');
        finalResponse.headers.set('X-Cache-Status', cacheHit ? 'HIT' : 'MISS');

        return finalResponse;
    }
};
