import { queryMany, queryOne, withTransaction } from './database.js';

const WORDS_PAGE_SIZE = 100;

export async function getWordsWithMeta({ q = '', category = '', page = 1, pageSize = WORDS_PAGE_SIZE, language = 'fr' } = {}) {
    const limit = Math.max(1, Math.min(200, pageSize));
    let total;
    let wordsQuery;
    let wordsValues;
    if (q) {
        const like = `%${q}%`;
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

const GAME_MODES = ['identification', 'reverse', 'frappe', 'contexte', 'jumelage'];
const FAMILY_MODES = {
    acquisition: ['identification', 'reverse', 'frappe'],
    distinction: ['contexte', 'jumelage'],
};

export async function getGame({
    wordId = null,
    mode = null,
    family = null,
    band = null,
    category = null,
    language = 'fr',
} = {}) {
    let wanted = mode;
    if (wanted === null && family !== null) {
        wanted = FAMILY_MODES[family][Math.floor(Math.random() * FAMILY_MODES[family].length)];
    }
    if (wanted === null) {
        wanted = category
            ? Math.random() < 0.5
                ? 'identification'
                : 'reverse'
            : GAME_MODES[Math.floor(Math.random() * GAME_MODES.length)];
    }
    if (wordId !== null && wanted !== 'reverse' && wanted !== 'frappe') {
        wanted = 'identification';
    }
    if (wanted === 'contexte' || wanted === 'jumelage' || wanted === 'frappe-contexte') {
        try {
            if (wanted === 'contexte') return await getDistinctionGame(language, band, category);
            if (wanted === 'jumelage') return await getPairingGame(language, band, category);
            return await getFrappeContexteGame(language, band, category);
        } catch {
            return getAcquisitionGame(null, { band, category, language });
        }
    }
    if (wanted === 'reverse') {
        return getReverseGame({ wordId, band, category, language });
    }
    if (wanted === 'frappe') {
        return getFrappeGame({ wordId, band, category, language });
    }
    return getAcquisitionGame(wordId, { band, category, language });
}

async function drawWord({ wordId = null, band = null, category = null, language = 'fr' } = {}) {
    let word = null;
    if (Number.isInteger(wordId)) {
        word = await queryOne('SELECT id, text, long_definition, short_definition, difficulty FROM word WHERE id = $1', [
            wordId,
        ]);
    }
    const categoryValue = typeof category === 'string' ? category : null;
    const bandValue = Number.isInteger(band) ? band : null;
    if (!word && bandValue !== null) {
        if (categoryValue !== null) {
            word = await queryOne(
                `SELECT id, text, long_definition, short_definition, difficulty FROM word
                WHERE language = $2 AND difficulty = $1
                AND EXISTS (
                    SELECT 1 FROM word_category wc
                    JOIN category c ON c.id = wc.category_id
                    WHERE wc.word_id = word.id AND c.name = $3
                )
                ORDER BY random() LIMIT 1;`,
                [bandValue, language, categoryValue]
            );
        }
        if (!word) {
            // Complément hors catégorie : la bande prime, la catégorie est invisible pour le joueur
            word = await queryOne(
                `SELECT id, text, long_definition, short_definition, difficulty FROM word
                WHERE language = $2 AND difficulty = $1
                ORDER BY random() LIMIT 1;`,
                [bandValue, language]
            );
        }
    }
    if (!word && categoryValue !== null) {
        word = await queryOne(
            `SELECT id, text, long_definition, short_definition, difficulty FROM word
            WHERE language = $1
            AND EXISTS (
                SELECT 1 FROM word_category wc
                JOIN category c ON c.id = wc.category_id
                WHERE wc.word_id = word.id AND c.name = $2
            )
            ORDER BY random() LIMIT 1;`,
            [language, categoryValue]
        );
    }
    if (!word) {
        word = await queryOne(
            `SELECT id, text, long_definition, short_definition, difficulty FROM word
            WHERE language = $1
            ORDER BY random() LIMIT 1;`,
            [language]
        );
    }
    return word ?? null;
}

async function drawDistractorDefinitions(word, language = 'fr') {
    return queryMany(
        `SELECT id, text, short_definition FROM word
        WHERE id <> $1 AND language = $3
        ORDER BY long_definition <-> $2
        LIMIT 3;`,
        [word.id, word.long_definition, language]
    );
}

async function drawPair(language = 'fr', band = null, category = null) {
    const max = Number.isInteger(band) ? band : null;
    const categoryValue = typeof category === 'string' ? category : null;
    const pair =
        (await drawPairFromTables(language, max, categoryValue)) ??
        (max !== null ? await drawPairFromTables(language, null, categoryValue) : null);
    if (!pair) throw new Error('Not enough word pairs in database to start a game');
    return pair;
}

async function drawPairFromTables(language, max, category) {
    const fromConfusions = await queryOne(
        `SELECT w1.id AS a_id, w1.text AS a_text, w1.short_definition AS a_def, w1.difficulty AS a_difficulty,
                w2.id AS b_id, w2.text AS b_text, w2.short_definition AS b_def, w2.difficulty AS b_difficulty, c.nuance
        FROM confusion c
        JOIN word w1 ON w1.id = c.word1_id
        JOIN word w2 ON w2.id = c.word2_id
        WHERE w1.language = $1
        AND ($2::int IS NULL OR (w1.difficulty <= $2 AND w2.difficulty <= $2))
        AND ($3::text IS NULL OR EXISTS (
            SELECT 1 FROM word_category wc
            JOIN category cat ON cat.id = wc.category_id
            WHERE (wc.word_id = w1.id OR wc.word_id = w2.id) AND cat.name = $3
        ))
        ORDER BY random() LIMIT 1`,
        [language, max, category]
    );
    if (fromConfusions) return fromConfusions;
    const fromNearWords = await queryOne(
        `SELECT w1.id AS a_id, w1.text AS a_text, w1.short_definition AS a_def, w1.difficulty AS a_difficulty,
                w2.id AS b_id, w2.text AS b_text, w2.short_definition AS b_def, w2.difficulty AS b_difficulty, NULL AS nuance
        FROM near_words n
        JOIN word w1 ON w1.id = n.word1_id
        JOIN word w2 ON w2.id = n.word2_id
        WHERE w1.language = $1
        AND ($2::int IS NULL OR (w1.difficulty <= $2 AND w2.difficulty <= $2))
        AND ($3::text IS NULL OR EXISTS (
            SELECT 1 FROM word_category wc
            JOIN category cat ON cat.id = wc.category_id
            WHERE (wc.word_id = w1.id OR wc.word_id = w2.id) AND cat.name = $3
        ))
        ORDER BY random() LIMIT 1`,
        [language, max, category]
    );
    return fromNearWords ?? null;
}

export async function getAcquisitionGame(wordId = null, { band = null, category = null, language = 'fr' } = {}) {
    const word = await drawWord({ wordId, band, category, language });
    if (!word) throw new Error('Not enough words in database to start a game');
    const words = await drawDistractorDefinitions(word, language);
    return {
        mode: 'identification',
        targetId: word.id,
        difficulty: word.difficulty,
        definition: word.short_definition,
        options: shuffle([{ id: word.id, text: word.text }, ...words.map(w => ({ id: w.id, text: w.text }))]),
    };
}

export async function getReverseGame({ wordId = null, band = null, category = null, language = 'fr' } = {}) {
    const word = await drawWord({ wordId, band, category, language });
    if (!word) throw new Error('Not enough words in database to start a game');
    const words = await drawDistractorDefinitions(word, language);
    return {
        mode: 'reverse',
        targetId: word.id,
        difficulty: word.difficulty,
        definition: word.text,
        options: shuffle([
            { id: word.id, text: word.short_definition },
            ...words.map(w => ({ id: w.id, text: w.short_definition })),
        ]),
    };
}

export async function getFrappeGame({ wordId = null, band = null, category = null, language = 'fr' } = {}) {
    const word = await drawWord({ wordId, band, category, language });
    if (!word) throw new Error('Not enough words in database to start a game');
    return {
        mode: 'frappe',
        targetId: word.id,
        difficulty: word.difficulty,
        definition: word.short_definition,
        sentence: null,
        nuance: null,
        otherId: null,
        options: [],
    };
}

export async function getFrappeContexteGame(language = 'fr', band = null, category = null) {
    const pair = await drawPair(language, band, category);
    const flip = Math.random() < 0.5;
    const target = { id: flip ? pair.a_id : pair.b_id, text: flip ? pair.a_text : pair.b_text };
    const examples = await queryMany('SELECT sentence FROM example WHERE word_id = $1', [target.id]);
    const sentence = pickRandomExample(examples, target.text);
    return {
        mode: 'frappe-contexte',
        targetId: target.id,
        difficulty: flip ? pair.a_difficulty : pair.b_difficulty,
        definition: sentence ? blankOutWord(sentence, target.text, true) : flip ? pair.a_def : pair.b_def,
        sentence,
        options: [],
    };
}

function normalizeForCompare(text) {
    return text
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ');
}

function levenshtein(a, b) {
    if (a === b) return 0;
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;
    let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        const current = [i];
        for (let j = 1; j <= b.length; j++) {
            current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        }
        previous = current;
    }
    return previous[b.length];
}

export function isCloseMatch(guess, answer) {
    return levenshtein(normalizeForCompare(guess), normalizeForCompare(answer)) <= 1;
}

export async function getPairingGame(language = 'fr', band = null, category = null) {
    const pair = await drawPair(language, band, category);
    const flip = Math.random() < 0.5;
    const target = flip ? pair.a_id : pair.b_id;
    const other = flip ? pair.b_id : pair.a_id;
    return {
        mode: 'jumelage',
        targetId: target,
        difficulty: flip ? pair.a_difficulty : pair.b_difficulty,
        definition: flip ? pair.a_text : pair.b_text,
        otherId: other,
        nuance: pair.nuance ?? null,
        options: shuffle([
            { id: pair.a_id, text: pair.a_def },
            { id: pair.b_id, text: pair.b_def },
        ]),
    };
}

export async function getDistinctionGame(language = 'fr', band = null, category = null) {
    const pair = await drawPair(language, band, category);
    const flip = Math.random() < 0.5;
    const target = flip
        ? { id: pair.a_id, text: pair.a_text, difficulty: pair.a_difficulty }
        : { id: pair.b_id, text: pair.b_text, difficulty: pair.b_difficulty };
    const other = flip
        ? { id: pair.b_id, text: pair.b_text, difficulty: pair.b_difficulty }
        : { id: pair.a_id, text: pair.a_text, difficulty: pair.a_difficulty };

    const examples = await queryMany('SELECT sentence FROM example WHERE word_id = $1', [target.id]);
    const sentence = pickRandomExample(examples, target.text);
    let definition;
    if (sentence) {
        definition = blankOutWord(sentence, target.text);
    } else {
        const word = await queryOne('SELECT short_definition FROM word WHERE id = $1', [target.id]);
        definition = word ? word.short_definition : null;
    }
    if (definition === null) throw new Error('No usable prompt for the picked pair');

    return {
        mode: 'contexte',
        targetId: target.id,
        difficulty: target.difficulty,
        definition,
        sentence,
        nuance: pair.nuance ?? null,
        options: shuffle([target, other]),
    };
}

function wordPattern(word) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<![\\p{L}])${escaped}(?![\\p{L}])`, 'iu');
}

function shortDefinitionCites(word, citedText) {
    if (typeof word.short_definition !== 'string' || !citedText) return false;
    return wordPattern(citedText).test(word.short_definition);
}

async function pairCrossCites(word1Id, word2Id) {
    const rows = await queryMany('SELECT id, text, short_definition FROM word WHERE id = ANY($1)', [[word1Id, word2Id]]);
    const w1 = rows.find(row => row.id === word1Id);
    const w2 = rows.find(row => row.id === word2Id);
    if (!w1 || !w2) return false;
    return shortDefinitionCites(w1, w2.text) || shortDefinitionCites(w2, w1.text);
}

function containsWord(sentence, word) {
    return wordPattern(word).test(sentence);
}

function blankOutWord(sentence, word, withHint = false) {
    const blank = withHint ? word.charAt(0) + '_'.repeat(Math.max(0, word.length - 1)) : '______';
    return sentence.replace(wordPattern(word), blank);
}

function pickRandomExample(examples, word) {
    const matching = examples.map(example => example.sentence).filter(sentence => containsWord(sentence, word));
    if (matching.length === 0) return null;
    return matching[Math.floor(Math.random() * matching.length)];
}

function shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}
