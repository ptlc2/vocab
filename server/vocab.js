import { queryMany, queryOne, withTransaction } from './database.js';

const WORDS_PAGE_SIZE = 100;

export async function getWordsWithMeta({ q = '', category = '', page = 1, pageSize = WORDS_PAGE_SIZE, language = 'fr' } = {}) {
    const limit = Math.max(1, Math.min(200, pageSize));
    let total;
    let wordsQuery;
    let wordsValues;
    if (q) {
        const escaped = q.replace(/[%_]/g, char => `\\${char}`);
        const like = `%${escaped}%`;
        ({ count: total } = await queryOne(
            `SELECT count(*)::int AS count FROM word
            WHERE language = $2 AND (text ILIKE $1 OR short_definition ILIKE $1)`,
            [like, language]
        ));
        wordsQuery = `SELECT id, text, difficulty, register, short_definition FROM word
            WHERE language = $2 AND (text ILIKE $1 OR short_definition ILIKE $1)
            ORDER BY difficulty, text
            LIMIT $3 OFFSET $4`;
        wordsValues = [like, language, limit];
    } else if (category) {
        ({ count: total } = await queryOne(
            `SELECT count(*)::int AS count
            FROM word w
            JOIN word_category wc ON wc.word_id = w.id
            JOIN category c ON c.id = wc.category_id
            WHERE w.language = $2 AND c.name = $1`,
            [category, language]
        ));
        wordsQuery = `SELECT w.id, w.text, w.difficulty, w.register, w.short_definition
            FROM word w
            JOIN word_category wc ON wc.word_id = w.id
            JOIN category c ON c.id = wc.category_id
            WHERE w.language = $2 AND c.name = $1
            ORDER BY w.difficulty, w.text
            LIMIT $3 OFFSET $4`;
        wordsValues = [category, language, limit];
    } else {
        ({ count: total } = await queryOne('SELECT count(*)::int AS count FROM word WHERE language = $1', [language]));
        wordsQuery = `SELECT id, text, difficulty, register, short_definition FROM word
            WHERE language = $1
            ORDER BY difficulty, text
            LIMIT $2 OFFSET $3`;
        wordsValues = [language, limit];
    }
    const pageCount = Math.max(1, Math.ceil(total / limit));
    const safePage = Math.min(Math.max(1, page), pageCount);
    const words = await queryMany(wordsQuery, [...wordsValues, (safePage - 1) * limit]);
    return { words, total, page: safePage, pageCount };
}

export async function getCategoriesWithCounts(language = 'fr') {
    return queryMany(
        `SELECT c.id, c.name, count(wc.word_id)::int AS word_count
        FROM category c
        JOIN word_category wc ON wc.category_id = c.id
        JOIN word w ON w.id = wc.word_id
        WHERE w.language = $1
        GROUP BY c.id, c.name
        HAVING count(wc.word_id) >= 2
        ORDER BY count(wc.word_id) DESC, c.name ASC
        LIMIT 10`,
        [language]
    );
}

export async function getCategoryTotal(name, language = 'fr') {
    const row = await queryOne(
        `SELECT count(*)::int AS total
        FROM word w
        JOIN word_category wc ON wc.word_id = w.id
        JOIN category c ON c.id = wc.category_id
        WHERE w.language = $2 AND c.name = $1`,
        [name, language]
    );
    return row ? row.total : 0;
}

export async function getPlayableCategories(language = 'fr') {
    return queryMany(
        `SELECT c.name, count(wc.word_id)::int AS word_count
        FROM category c
        JOIN word_category wc ON wc.category_id = c.id
        JOIN word w ON w.id = wc.word_id
        WHERE w.language = $1
        GROUP BY c.name
        HAVING count(wc.word_id) >= 8
        ORDER BY count(wc.word_id) DESC, c.name ASC`,
        [language]
    );
}

export async function getStats(language = 'fr') {
    return queryOne(
        `SELECT
            (SELECT count(*) FROM word WHERE language = $1)::int AS words,
            (SELECT count(DISTINCT c.id) FROM category c
                JOIN word_category wc ON wc.category_id = c.id
                JOIN word w ON w.id = wc.word_id
                WHERE w.language = $1)::int AS categories,
            (SELECT count(*) FROM example e JOIN word w ON w.id = e.word_id WHERE w.language = $1)::int AS examples,
            (SELECT count(*) FROM confusion cf JOIN word w ON w.id = cf.word1_id WHERE w.language = $1)::int AS confusions`,
        [language]
    );
}

export async function findWordId(text, language = 'fr') {
    const word = await queryOne('SELECT id FROM word WHERE text = $1 AND language = $2', [text, language]);
    return word ? word.id : null;
}

export async function getWordById(wordId) {
    const word = await queryOne('SELECT * FROM word WHERE id = $1', [wordId]);
    return loadWordRelations(word);
}

export async function getWordByText(text, language = 'fr') {
    const word = await queryOne('SELECT * FROM word WHERE text = $1 AND language = $2', [text, language]);
    return loadWordRelations(word);
}

async function loadWordRelations(word) {
    if (!word) return null;
    word.categories = await queryMany(
        `SELECT c.id, c.name FROM word_category wc
        JOIN category c ON wc.category_id = c.id
        WHERE wc.word_id = $1`,
        [word.id]
    );
    word.examples = await queryMany(
        `SELECT id, sentence FROM example
        WHERE word_id = $1`,
        [word.id]
    );
    word.near_words = await queryMany(
        `(SELECT w.id, w.text FROM near_words JOIN word w ON word2_id = w.id WHERE word1_id = $1)
        UNION
        (SELECT w.id, w.text FROM near_words JOIN word w ON word1_id = w.id WHERE word2_id = $1)`,
        [word.id]
    );
    word.confusions = await queryMany(
        `(SELECT w.id, w.text, nuance FROM confusion JOIN word w ON word2_id = w.id WHERE word1_id = $1)
        UNION
        (SELECT w.id, w.text, nuance FROM confusion JOIN word w ON word1_id = w.id WHERE word2_id = $1)`,
        [word.id]
    );
    return word;
}

export async function insertWord(word) {
    if (
        shortDefinitionCites(word, word.text) ||
        (word.near_words ?? []).some(near => shortDefinitionCites(word, near)) ||
        (word.confusions ?? []).some(confusion => shortDefinitionCites(word, confusion.other))
    ) {
        throw new Error(
            `La définition courte de « ${word.text} » cite le mot lui-même ou l'un de ses mots proches — insertion refusée`
        );
    }
    return withTransaction(async client => {
        const language = word.language ?? 'fr';
        const existing = await client.query('SELECT id FROM word WHERE text = $1 AND language = $2', [word.text, language]);
        if (existing.rows.length > 0) {
            return { id: existing.rows[0].id, created: false };
        }

        const inserted = await client.query(
            `INSERT INTO word (text, language, difficulty, register, short_definition, long_definition, origin, notes)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING id`,
            [
                word.text,
                language,
                word.difficulty,
                word.register,
                word.short_definition,
                word.long_definition,
                word.origin ?? null,
                word.notes ?? null,
            ]
        );
        const wordId = inserted.rows[0].id;

        for (const name of word.categories) {
            const categoryId = await getOrCreateCategoryId(client, name);
            await client.query('INSERT INTO word_category (word_id, category_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [
                wordId,
                categoryId,
            ]);
        }

        for (const sentence of word.examples) {
            await client.query('INSERT INTO example (word_id, sentence) VALUES ($1, $2)', [wordId, sentence]);
        }

        return { id: wordId, created: true };
    });
}

async function getOrCreateCategoryId(client, name) {
    const inserted = await client.query('INSERT INTO category (name) VALUES ($1) ON CONFLICT (name) DO NOTHING RETURNING id', [
        name,
    ]);
    if (inserted.rows.length > 0) {
        return inserted.rows[0].id;
    }
    const selected = await client.query('SELECT id FROM category WHERE name = $1', [name]);
    return selected.rows[0].id;
}

async function difficultyGap(word1Id, word2Id) {
    const rows = await queryMany('SELECT id, difficulty FROM word WHERE id = ANY($1)', [[word1Id, word2Id]]);
    if (rows.length < 2) return null;
    const d1 = rows.find(row => row.id === word1Id)?.difficulty;
    const d2 = rows.find(row => row.id === word2Id)?.difficulty;
    return Math.abs(d1 - d2);
}

export async function linkNearWords(word1Id, word2Id) {
    if (word1Id === word2Id) return false;
    if ((await difficultyGap(word1Id, word2Id)) > 1) return false;
    if (await pairCrossCites(word1Id, word2Id)) return false;
    const result = await queryMany(
        `INSERT INTO near_words (word1_id, word2_id)
        SELECT $1, $2
        WHERE NOT EXISTS (
            SELECT 1 FROM near_words
            WHERE (word1_id = $1 AND word2_id = $2) OR (word1_id = $2 AND word2_id = $1)
        )
        RETURNING id`,
        [word1Id, word2Id]
    );
    return result.length > 0;
}

export async function linkConfusion(word1Id, word2Id, nuance) {
    if (word1Id === word2Id) return false;
    if ((await difficultyGap(word1Id, word2Id)) > 1) return false;
    if (await pairCrossCites(word1Id, word2Id)) return false;
    const result = await queryMany(
        `INSERT INTO confusion (word1_id, word2_id, nuance)
        SELECT $1, $2, $3
        WHERE NOT EXISTS (
            SELECT 1 FROM confusion
            WHERE (word1_id = $1 AND word2_id = $2) OR (word1_id = $2 AND word2_id = $1)
        )
        RETURNING id`,
        [word1Id, word2Id, nuance]
    );
    return result.length > 0;
}

export async function linkWordRelations(word) {
    const wordId = await findWordId(word.text);
    if (wordId === null) return false;
    let linked = 0;
    const language = word.language ?? 'fr';
    for (const text of word.near_words ?? []) {
        const otherId = await findWordId(text, language);
        if (otherId !== null && (await linkNearWords(wordId, otherId))) linked += 1;
    }
    for (const confusion of word.confusions ?? []) {
        const otherId = await findWordId(confusion.other, language);
        if (otherId !== null && (await linkConfusion(wordId, otherId, confusion.nuance))) linked += 1;
    }
    return linked;
}

function shortDefinitionCites(word, citedText) {
    if (typeof word.short_definition !== 'string' || !citedText) return false;
    const escaped = citedText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<![\\p{L}])${escaped}(?![\\p{L}])`, 'iu').test(word.short_definition);
}

async function pairCrossCites(word1Id, word2Id) {
    const rows = await queryMany('SELECT id, text, short_definition FROM word WHERE id = ANY($1)', [[word1Id, word2Id]]);
    const w1 = rows.find(row => row.id === word1Id);
    const w2 = rows.find(row => row.id === word2Id);
    if (!w1 || !w2) return false;
    return shortDefinitionCites(w1, w2.text) || shortDefinitionCites(w2, w1.text);
}
