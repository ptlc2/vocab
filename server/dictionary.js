import { queryMany, queryOne } from './database.js';

export async function getDictionary(language = 'fr') {
    const words = await queryMany(
        `SELECT w.id, w.text, w.difficulty, w.register, w.short_definition, w.long_definition, w.origin, w.notes,
            COALESCE((SELECT json_agg(c.name) FROM word_category wc JOIN category c ON c.id = wc.category_id WHERE wc.word_id = w.id), '[]') AS categories,
            COALESCE((SELECT json_agg(e.sentence) FROM example e WHERE e.word_id = w.id), '[]') AS examples,
            (SELECT json_agg(d.id) FROM (
                SELECT w2.id
                FROM word w2
                WHERE w2.language = w.language AND w2.id <> w.id
                ORDER BY w2.long_definition <-> w.long_definition
                LIMIT 3
            ) d) AS distractors
        FROM word w
        WHERE w.language = $1
        ORDER BY w.id`,
        [language]
    );
    if (words.length === 0) return null;
    const confusions = await queryMany(
        `SELECT w1.id AS a_id, w1.text AS a_text, w1.short_definition AS a_def, w1.difficulty AS a_difficulty,
                w2.id AS b_id, w2.text AS b_text, w2.short_definition AS b_def, w2.difficulty AS b_difficulty, c.nuance
        FROM confusion c
        JOIN word w1 ON w1.id = c.word1_id
        JOIN word w2 ON w2.id = c.word2_id
        WHERE w1.language = $1 AND w2.language = $1
        ORDER BY c.id`,
        [language]
    );
    const nearWords = await queryMany(
        `SELECT w1.id AS a_id, w1.text AS a_text, w1.short_definition AS a_def, w1.difficulty AS a_difficulty,
                w2.id AS b_id, w2.text AS b_text, w2.short_definition AS b_def, w2.difficulty AS b_difficulty
        FROM near_words n
        JOIN word w1 ON w1.id = n.word1_id
        JOIN word w2 ON w2.id = n.word2_id
        WHERE w1.language = $1 AND w2.language = $1
        ORDER BY n.id`,
        [language]
    );
    return { language, words, confusions, nearWords };
}

export async function getDictionaryVersion(language = 'fr') {
    const fingerprint = await queryOne(
        `SELECT
            (SELECT count(*) FROM word WHERE language = $1)::text || '-' ||
            COALESCE((SELECT max(updated_at)::date::text FROM word WHERE language = $1), '0') || '-' ||
            (SELECT count(*) FROM example e JOIN word w ON w.id = e.word_id WHERE w.language = $1)::text || '-' ||
            (SELECT count(*) FROM confusion c JOIN word w ON w.id = c.word1_id WHERE w.language = $1)::text || '-' ||
            (SELECT count(*) FROM near_words n JOIN word w ON w.id = n.word1_id WHERE w.language = $1)::text || '-' ||
            (SELECT count(*) FROM word_category wc JOIN word w ON w.id = wc.word_id WHERE w.language = $1)::text AS fingerprint`,
        [language]
    );
    let hash = 0;
    const text = fingerprint?.fingerprint ?? '0';
    for (let i = 0; i < text.length; i++) {
        hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
    }
    return hash.toString(36);
}
