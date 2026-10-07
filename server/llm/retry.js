const MIN_INTERVAL_MS = 2500;
const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000];

let lastCallTime = 0;

export function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export async function callWithRateLimit(fn) {
    let lastError;
    for (let attempt = 1; attempt <= RETRY_DELAYS_MS.length + 1; attempt++) {
        if (attempt > 1) await sleep(RETRY_DELAYS_MS[attempt - 2]);
        const wait = MIN_INTERVAL_MS - (Date.now() - lastCallTime);
        if (wait > 0) await sleep(wait);
        lastCallTime = Date.now();
        try {
            return await fn();
        } catch (err) {
            lastError = err;
            if (isFatal(err)) {
                console.error(`Appel LLM échoué sans retry (erreur permanente ${err?.status ?? '?'}) : ${err?.message ?? err}`);
                throw err;
            }
            console.error(`Appel LLM échoué (tentative ${attempt}/${RETRY_DELAYS_MS.length + 1}) : ${err?.message ?? err}`);
        }
    }
    throw lastError;
}

function isFatal(err) {
    const status = err?.status ?? err?.statusCode;
    if (typeof status !== 'number') return false;
    return status >= 400 && status < 500 && status !== 429;
}
