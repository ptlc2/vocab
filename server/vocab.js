import { queryMany, queryOne, withTransaction } from './database.js';

export async function getWordsWithMeta({ q = '', category = '' } = {}) {
    if (q) {
        return queryMany(
            `SELECT id, text, difficulty, register, short_definition FROM word
            WHERE text ILIKE $1 OR short_definition ILIKE $1
            ORDER BY difficulty, text`,
            [`%${q}%`]
        );
    }
    if (category) {
        return queryMany(
            `SELECT w.id, w.text, w.difficulty, w.register, w.short_definition
            FROM word w
            JOIN word_category wc ON wc.word_id = w.id
            JOIN category c ON c.id = wc.category_id
            WHERE c.name = $1
            ORDER BY w.difficulty, w.text`,
            [category]
        );
    }
    return queryMany('SELECT id, text, difficulty, register, short_definition FROM word ORDER BY difficulty, text');
}

export async function getCategoriesWithCounts() {
    return queryMany(
        `SELECT c.id, c.name, count(wc.word_id)::int AS word_count
        FROM category c
        LEFT JOIN word_category wc ON wc.category_id = c.id
        GROUP BY c.id, c.name
        ORDER BY count(wc.word_id) DESC, c.name ASC`
    );
}

export async function getStats() {
    return queryOne(
        `SELECT
            (SELECT count(*) FROM word)::int AS words,
            (SELECT count(*) FROM category)::int AS categories,
            (SELECT count(*) FROM example)::int AS examples,
            (SELECT count(*) FROM confusion)::int AS confusions`
    );
}

export async function findWordId(text) {
    const word = await queryOne('SELECT id FROM word WHERE text = $1', [text]);
    return word ? word.id : null;
}

export async function getWordById(wordId) {
    const word = await queryOne('SELECT * FROM word WHERE id = $1', [wordId]);
    return loadWordRelations(word);
}

export async function getWordByText(text) {
    const word = await queryOne('SELECT * FROM word WHERE text = $1', [text]);
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
    return withTransaction(async client => {
        const existing = await client.query('SELECT id FROM word WHERE text = $1', [word.text]);
        if (existing.rows.length > 0) {
            return { id: existing.rows[0].id, created: false };
        }

        const inserted = await client.query(
            `INSERT INTO word (text, difficulty, register, short_definition, long_definition, origin, notes)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING id`,
            [
                word.text,
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

export async function linkNearWords(word1Id, word2Id) {
    if (word1Id === word2Id) return false;
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
    for (const text of word.near_words ?? []) {
        const otherId = await findWordId(text);
        if (otherId !== null && (await linkNearWords(wordId, otherId))) linked += 1;
    }
    for (const confusion of word.confusions ?? []) {
        const otherId = await findWordId(confusion.other);
        if (otherId !== null && (await linkConfusion(wordId, otherId, confusion.nuance))) linked += 1;
    }
    return linked;
}

export async function getAcquisitionGame(wordId = null) {
    let word = null;
    if (Number.isInteger(wordId)) {
        word = await queryOne('SELECT id, text, long_definition, short_definition FROM word WHERE id = $1', [wordId]);
    }
    if (!word) {
        word = await queryOne(
            `SELECT id, text, long_definition, short_definition FROM word
            ORDER BY random() LIMIT 1;`
        );
    }
    if (!word) throw new Error('Not enough words in database to start a game');
    const words = await queryMany(
        `SELECT id, text FROM word
        WHERE id <> $1
        ORDER BY long_definition <-> $2
        LIMIT 3;`,
        [word.id, word.long_definition]
    );
    return {
        mode: 'acquisition',
        targetId: word.id,
        definition: word.short_definition,
        options: shuffle([{ id: word.id, text: word.text }, ...words.map(w => ({ id: w.id, text: w.text }))]),
    };
}

function shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}
