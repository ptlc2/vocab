// Moteur de jeu Vocab : la progression ET le tirage vivent côté client.
// Le serveur ne fournit que le dictionnaire (JSON versionné) et les pages.

// ---------------------------------------------------------------------------
// Modèle d'état (localStorage, une clé par langue)
// ---------------------------------------------------------------------------

const CORRECT_INTERVALS_MS = [8 * 3600e3, 24 * 3600e3, 3 * 86400e3, 7 * 86400e3, 30 * 86400e3];
const WRONG_RETRY_MS = 10 * 60e3;
const MASTERED_BOX = 4;
const MAX_BAND = 5;
const UNLOCK_THRESHOLD = 2;
const PROBE_PROBABILITY = 0.25;

export function newState() {
    return {
        words: {},
        session: { rounds: 0, score: 0, streak: 0, best: 0 },
        bands: {},
        totals: {},
    };
}

export function storageKey(language = 'fr') {
    return `vocab:progress:v2:${language}`;
}

export function loadState(storage, language = 'fr') {
    try {
        const raw = storage?.getItem(storageKey(language));
        if (!raw) return newState();
        const parsed = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null || typeof parsed.words !== 'object' || !parsed.session) {
            return newState();
        }
        const base = newState();
        const state = { ...base, ...parsed, session: { ...base.session, ...parsed.session } };
        state.words = Object.fromEntries(
            Object.entries(parsed.words ?? {})
                .filter(([id, entry]) => isValidEntry(id, entry))
                .map(([id, entry]) => [id, sanitizeEntry(entry)])
        );
        state.session = sanitizeSession(state.session);
        state.bands = sanitizeBands(parsed.bands);
        state.totals =
            typeof parsed.totals === 'object' && parsed.totals !== null
                ? Object.fromEntries(Object.entries(parsed.totals).filter(([, count]) => Number.isInteger(count) && count > 0))
                : {};
        return state;
    } catch {
        return newState();
    }
}

export function saveState(storage, state, language = 'fr') {
    storage?.setItem(storageKey(language), JSON.stringify(state));
}

function isValidEntry(id, entry) {
    return (
        id !== 'undefined' &&
        typeof entry === 'object' &&
        entry !== null &&
        typeof entry.text === 'string' &&
        entry.text !== '' &&
        Number.isInteger(entry.difficulty)
    );
}

function sanitizeEntry(entry) {
    const box = Number.isInteger(entry.box) ? Math.min(5, Math.max(0, entry.box)) : 0;
    const due = Number.isFinite(entry.due) && entry.due >= 0 ? entry.due : 0;
    const categories = Array.isArray(entry.categories)
        ? entry.categories.filter(name => typeof name === 'string' && name !== '')
        : [];
    return {
        text: entry.text,
        difficulty: Number.isInteger(entry.difficulty) ? Math.min(5, Math.max(1, entry.difficulty)) : 1,
        box,
        due,
        correct: toCount(entry.correct),
        wrong: toCount(entry.wrong),
        categories,
    };
}

function sanitizeSession(session) {
    return {
        rounds: toCount(session.rounds),
        score: toCount(session.score),
        streak: toCount(session.streak),
        best: toCount(session.best),
    };
}

function sanitizeBands(bands) {
    if (typeof bands !== 'object' || bands === null) return {};
    const clean = {};
    for (const [name, list] of Object.entries(bands)) {
        if (typeof name !== 'string' || name === '' || !Array.isArray(list)) continue;
        const levels = [...new Set(list.filter(level => Number.isInteger(level) && level >= 1 && level <= MAX_BAND))];
        if (levels.length > 0) clean[name] = levels.sort((a, b) => a - b);
    }
    return clean;
}

function toCount(value) {
    return Number.isInteger(value) && value >= 0 ? value : 0;
}

export function recordRound(state, round) {
    const { targetId, text, difficulty, correct, categories = [], now = Date.now() } = round;
    if (
        targetId === undefined ||
        targetId === null ||
        String(targetId) === 'undefined' ||
        !text ||
        !Number.isInteger(difficulty)
    ) {
        return [];
    }
    const id = String(targetId);
    const entry = state.words[id] ?? { text, difficulty, box: 0, due: 0, correct: 0, wrong: 0, categories: [] };
    entry.text = text;
    entry.difficulty = difficulty;
    entry.categories = [...new Set([...(entry.categories ?? []), ...categories])];
    if (correct) {
        entry.box = Math.min(5, entry.box + 1);
        entry.due = now + CORRECT_INTERVALS_MS[entry.box - 1];
        entry.correct += 1;
    } else {
        entry.box = 0;
        entry.due = now + WRONG_RETRY_MS;
        entry.wrong += 1;
    }
    state.words[id] = entry;

    const acquisitions = [];
    if (correct) {
        for (const name of categories) {
            if (acquireBand(state, name, difficulty)) {
                acquisitions.push({ category: name, band: difficulty });
            }
        }
    }

    const session = state.session;
    session.rounds += 1;
    if (correct) {
        session.score += 1;
        session.streak += 1;
        session.best = Math.max(session.best, session.streak);
    } else {
        session.streak = 0;
    }
    return acquisitions;
}

function acquireBand(state, name, band) {
    const bands = state.bands[name] ?? (state.bands[name] = []);
    if (bands.includes(band)) return false;
    const solid = Object.values(state.words).filter(
        entry => (entry.categories ?? []).includes(name) && entry.difficulty === band && entry.box >= UNLOCK_THRESHOLD
    );
    if (solid.length >= 2) {
        bands.push(band);
        return true;
    }
    return false;
}

export function categoryLevel(state, name) {
    const bands = state.bands[name] ?? [];
    return bands.length > 0 ? Math.max(...bands) : 1;
}

export function dueWords(state, now = Date.now()) {
    return Object.entries(state.words)
        .filter(([, entry]) => entry.due <= now)
        .sort(([, a], [, b]) => a.due - b.due)
        .map(([id, entry]) => ({ id, ...entry }));
}

export function counts(state, now = Date.now()) {
    const entries = Object.values(state.words);
    const mastered = entries.filter(entry => entry.box >= MASTERED_BOX).length;
    const learning = entries.filter(entry => entry.box > 0 && entry.box < MASTERED_BOX).length;
    const due = dueWords(state, now).length;
    return { seen: entries.length, mastered, learning, due };
}

function isPlayedCategory(state, name) {
    return Object.values(state.words).some(entry => (entry.categories ?? []).includes(name));
}

export function categoryPercent(state, name, total) {
    if (!Number.isInteger(total) || total <= 0) return null;
    const boxSum = Object.values(state.words)
        .filter(entry => (entry.categories ?? []).includes(name))
        .reduce((sum, entry) => sum + entry.box, 0);
    return Math.round((100 * boxSum) / (total * 5));
}

function levelLabel(state, name, total) {
    if (!isPlayedCategory(state, name) && (state.bands[name] ?? []).length === 0) return 'nouveau';
    const parsed = Number.parseInt(total, 10);
    const percent =
        Number.isInteger(parsed) && parsed > 0
            ? categoryPercent(state, name, parsed)
            : categoryPercent(state, name, state.totals[name]);
    return percent === null ? 'en route' : `${percent} %`;
}

function recordTotal(state, name, total) {
    const count = Number.parseInt(total, 10);
    if (Number.isInteger(count) && count > 0) state.totals[name] = count;
}

// ---------------------------------------------------------------------------
// Aides de texte pures (validation de la saisie libre, phrases à trous)
// ---------------------------------------------------------------------------

function normalizeForCompare(text) {
    return text
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ');
}

export function levenshtein(a, b) {
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

function wordPattern(word) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<![\\p{L}])${escaped}(?![\\p{L}])`, 'iu');
}

export function blankOutWord(sentence, word, withHint = false) {
    const blank = withHint ? word.charAt(0) + '_'.repeat(Math.max(0, word.length - 1)) : '______';
    return sentence.replace(wordPattern(word), blank);
}

export function pickRandomExample(examples, word) {
    const matching = examples.filter(sentence => wordPattern(word).test(sentence));
    if (matching.length === 0) return null;
    return matching[Math.floor(Math.random() * matching.length)];
}

export function shuffle(array, rand = Math.random) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

// ---------------------------------------------------------------------------
// Le tirage : quel round jouer ensuite
// ---------------------------------------------------------------------------

const GAME_MODES = ['identification', 'reverse', 'frappe', 'contexte', 'jumelage'];
const FAMILY_MODES = {
    acquisition: ['identification', 'reverse', 'frappe'],
    distinction: ['contexte', 'jumelage'],
};

export function wordsById(dictionary) {
    return new Map(dictionary.words.map(word => [word.id, word]));
}

function pairsFor(dictionary) {
    const pairs = dictionary.confusions.map(pair => ({
        a: pair.a_id,
        b: pair.b_id,
        aText: pair.a_text,
        bText: pair.b_text,
        aDef: pair.a_def,
        bDef: pair.b_def,
        aDifficulty: pair.a_difficulty,
        bDifficulty: pair.b_difficulty,
        nuance: pair.nuance ?? null,
    }));
    for (const pair of dictionary.near_words ?? []) {
        pairs.push({
            a: pair.a_id,
            b: pair.b_id,
            aText: pair.a_text,
            bText: pair.b_text,
            aDef: pair.a_def,
            bDef: pair.b_def,
            aDifficulty: pair.a_difficulty,
            bDifficulty: pair.b_difficulty,
            nuance: null,
        });
    }
    return pairs;
}

function inCategory(word, category) {
    return !category || (word.categories ?? []).includes(category);
}

function solidWords(state, dictionary, category, minBox) {
    return dictionary.words.filter(word => inCategory(word, category) && (state.words[word.id]?.box ?? 0) >= minBox);
}

function pickFrom(list, rand = Math.random) {
    return list[Math.floor(rand() * list.length)];
}

function eligibleModes(state, dictionary, category, rand = Math.random) {
    const modes = ['identification', 'contexte'];
    if (solidWords(state, dictionary, category, 2).length > 0) modes.push('reverse');
    const pairs = pairsFor(dictionary);
    const pairSolid = (minBox, scopeCategory) =>
        pairs.some(
            pair =>
                (!scopeCategory ||
                    inCategory(dictionary.words.find(w => w.id === pair.a) ?? {}, scopeCategory) ||
                    inCategory(dictionary.words.find(w => w.id === pair.b) ?? {}, scopeCategory)) &&
                ((state.words[pair.a]?.box ?? 0) >= minBox || (state.words[pair.b]?.box ?? 0) >= minBox)
        );
    if (solidWords(state, dictionary, category, 2).length > 0 && pairSolid(2, category)) modes.push('jumelage');
    if (solidWords(state, dictionary, category, 3).length > 0) modes.push('frappe');
    return modes;
}

function buildRound(mode, word, dictionary, extra = {}) {
    const byId = wordsById(dictionary);
    const distractors = (word.distractors ?? [])
        .map(id => byId.get(id))
        .filter(Boolean)
        .slice(0, 3);
    const pairs = pairsFor(dictionary);
    const pair = pairs.find(p => p.a === word.id || p.b === word.id);
    const other = pair ? (pair.a === word.id ? pair.b : pair.a) : null;
    const otherWord = other !== null ? byId.get(other) : null;

    if (mode === 'identification') {
        return {
            mode,
            target: word.id,
            prompt: word.short_definition,
            options: shuffle([{ id: word.id, label: word.text }, ...distractors.map(w => ({ id: w.id, label: w.text }))]),
        };
    }
    if (mode === 'reverse') {
        return {
            mode,
            target: word.id,
            prompt: word.text,
            options: shuffle([
                { id: word.id, label: word.short_definition },
                ...distractors.map(w => ({ id: w.id, label: w.short_definition })),
            ]),
        };
    }
    if (mode === 'frappe') {
        return { mode, target: word.id, prompt: word.short_definition };
    }
    if (mode === 'contexte') {
        const sentence = pair ? pickRandomExample(word.examples ?? [], word.text) : null;
        const prompt = sentence ? blankOutWord(sentence, word.text) : word.short_definition;
        return {
            mode,
            target: word.id,
            prompt,
            sentence,
            options: pair
                ? shuffle([
                      { id: word.id, label: word.text },
                      { id: otherWord.id, label: otherWord.text },
                  ])
                : null,
            nuance: pair?.nuance ?? null,
        };
    }
    if (mode === 'jumelage') {
        if (!pair || !otherWord) return buildRound('reverse', word, dictionary, extra);
        return {
            mode,
            target: word.id,
            prompt: word.text,
            otherId: otherWord.id,
            options: shuffle([
                { id: word.id, label: word.short_definition },
                { id: otherWord.id, label: otherWord.short_definition },
            ]),
            nuance: pair.nuance,
        };
    }
    if (mode === 'frappe-contexte') {
        if (!pair || !otherWord) return { mode: 'frappe', target: word.id, prompt: word.short_definition };
        const sentence = pickRandomExample(word.examples ?? [], word.text);
        const prompt = sentence ? blankOutWord(sentence, word.text, true) : word.short_definition;
        return { mode, target: word.id, prompt, sentence };
    }
    return null;
}

export function pickRound(dictionary, state, params, rand = Math.random, exclude = null) {
    const { category = null, mode = null, track = null, wordId = null } = params;
    const byId = wordsById(dictionary);
    // Variété : on ne ressert pas un mot déjà servi dans la session, tant qu'il reste du choix.
    const fresh = list => {
        if (exclude === null || exclude.size === 0 || !Array.isArray(list)) return list;
        const unexcluded = list.filter(item => {
            if (typeof item.id === 'number') return !exclude.has(item.id);
            if (typeof item.a === 'number' && typeof item.b === 'number') {
                return !exclude.has(item.a) && !exclude.has(item.b);
            }
            return true;
        });
        return unexcluded.length > 0 ? unexcluded : list;
    };

    // Mot précis demandé : servi tel quel (mode solo), dégradé si le mode a besoin d'une paire.
    if (wordId !== null && Number.isInteger(wordId)) {
        const word = byId.get(wordId);
        if (word) {
            return buildRound(mode ?? 'identification', word, dictionary);
        }
        // id périmé (base régénérée) : purge et tirage normal
        delete state.words[String(wordId)];
        return pickRound(dictionary, state, { category, mode, track }, rand, exclude);
    }

    // La mémoire d'abord : les mots dus (dans la catégorie si session de catégorie).
    // Un mot dû doit revenir, même servi récemment — c'est le rappel.
    const due = dueWords(state).filter(word => !category || (word.categories ?? []).includes(category));
    if (due.length > 0) {
        const word = byId.get(Number.parseInt(due[0].id, 10));
        if (word) return buildRound('identification', word, dictionary);
    }

    // Mode explicitement choisi : gardé pour la session.
    if (mode !== null) {
        const word = pickRoundWord(mode, state, dictionary, category, rand, fresh);
        if (word) return buildRound(mode, word, dictionary);
        return pickRound(dictionary, state, { category, mode: null, track }, rand, exclude);
    }

    // Piste : tirage dans la famille.
    let pool = GAME_MODES;
    if (track !== null && FAMILY_MODES[track]) {
        const family = FAMILY_MODES[track];
        pool = family.filter(candidate => eligibleModes(state, dictionary, category, rand).includes(candidate));
        if (pool.length === 0) pool = [family[0]];
    } else {
        pool = eligibleModes(state, dictionary, category, rand);
    }

    const tried = new Set();
    while (tried.size < pool.length) {
        const mode = pickFrom(
            pool.filter(candidate => !tried.has(candidate)),
            rand
        );
        const word = pickRoundWord(mode, state, dictionary, category, rand, fresh);
        if (word) return buildRound(mode, word, dictionary);
        tried.add(mode);
    }
    // dernier recours : identification sur un mot au hasard de la langue
    return buildRound('identification', pickFrom(fresh(dictionary.words), rand), dictionary);
}

function pickRoundWord(mode, state, dictionary, category, rand, fresh = list => list) {
    if (mode === 'identification') {
        const level = category ? categoryLevel(state, category) : null;
        if (!category) {
            return pickFrom(fresh(dictionary.words), rand);
        }
        const probe = rand() < PROBE_PROBABILITY;
        const targetBand = probe ? Math.min(MAX_BAND, level + 1) : level;
        const inCat = dictionary.words.filter(word => inCategory(word, category));
        if (inCat.length === 0) return pickFrom(fresh(dictionary.words), rand);
        const atBand = inCat.filter(word => word.difficulty === targetBand);
        if (atBand.length > 0) return pickFrom(fresh(atBand), rand);
        return pickFrom(fresh(inCat), rand);
    }
    if (mode === 'reverse') {
        const solid = solidWords(state, dictionary, category, 2);
        if (solid.length > 0) return pickFrom(fresh(solid), rand);
        const global = solidWords(state, dictionary, null, 2);
        return global.length > 0 ? pickFrom(fresh(global), rand) : null;
    }
    if (mode === 'frappe') {
        const solid = solidWords(state, dictionary, category, 3);
        if (solid.length > 0) return pickFrom(fresh(solid), rand);
        const global = solidWords(state, dictionary, null, 3);
        return global.length > 0 ? pickFrom(fresh(global), rand) : null;
    }
    if (mode === 'jumelage') {
        const pairs = pairsFor(dictionary);
        const byId = wordsById(dictionary);
        const candidates = pairs.filter(pair => {
            const a = state.words[pair.a]?.box ?? 0;
            const b = state.words[pair.b]?.box ?? 0;
            const aOk = a >= 2 && inCategory(byId.get(pair.a) ?? {}, category);
            const bOk = b >= 2 && inCategory(byId.get(pair.b) ?? {}, category);
            return category ? aOk || bOk : a >= 2 || b >= 2;
        });
        if (candidates.length === 0) return null;
        const pair = pickFrom(fresh(candidates), rand);
        const targetBox = state.words[pair.a]?.box ?? 0;
        return byId.get((state.words[pair.b]?.box ?? 0) > targetBox ? pair.b : pair.a);
    }
    if (mode === 'contexte') {
        const pairs = pairsFor(dictionary);
        const byId = wordsById(dictionary);
        const candidates = pairs.filter(pair => {
            const a = byId.get(pair.a) ?? {};
            const b = byId.get(pair.b) ?? {};
            return inCategory(a, category) || inCategory(b, category);
        });
        // sans paire dans la catégorie, le mode cède sa place (pas de paire hors catégorie)
        if (candidates.length === 0) return null;
        const pair = pickFrom(fresh(candidates), rand);
        return byId.get(rand() < 0.5 ? pair.a : pair.b);
    }
    if (mode === 'frappe-contexte') {
        const pairs = pairsFor(dictionary);
        const byId = wordsById(dictionary);
        const candidates = pairs.filter(pair => {
            const a = state.words[pair.a]?.box ?? 0;
            const b = state.words[pair.b]?.box ?? 0;
            const aOk = a >= 3 && inCategory(byId.get(pair.a) ?? {}, category);
            const bOk = b >= 3 && inCategory(byId.get(pair.b) ?? {}, category);
            return category ? aOk || bOk : a >= 3 || b >= 3;
        });
        if (candidates.length === 0) return null;
        const pair = pickFrom(fresh(candidates), rand);
        const targetBox = state.words[pair.a]?.box ?? 0;
        return byId.get((state.words[pair.b]?.box ?? 0) > targetBox ? pair.b : pair.a);
    }
    return null;
}

// ---------------------------------------------------------------------------
// Difficultés (palette transmise par le serveur)
// ---------------------------------------------------------------------------

const FALLBACK_DIFFICULTIES = {
    1: { name: 'Basique', color: '#4caf50' },
    2: { name: 'Usuel', color: '#2196f3' },
    3: { name: 'Soutenu', color: '#ff9800' },
    4: { name: 'Littéraire', color: '#9c27b0' },
    5: { name: 'Érudit', color: '#f44336' },
};
let difficultiesCache = null;

export function difficultyInfo(level) {
    if (difficultiesCache === null) {
        difficultiesCache = {};
        try {
            const raw = typeof document !== 'undefined' ? document.body?.dataset?.difficulties : null;
            if (raw) {
                const parsed = JSON.parse(raw);
                for (const [key, value] of Object.entries(parsed)) {
                    difficultiesCache[Number(key)] = value;
                }
            }
        } catch {
            difficultiesCache = {};
        }
    }
    return difficultiesCache[level] ?? FALLBACK_DIFFICULTIES[level] ?? { name: `niveau ${level}`, color: 'var(--muted)' };
}

// ---------------------------------------------------------------------------
// Rendu
// ---------------------------------------------------------------------------

function el(tag, className, text, href) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    if (href) node.setAttribute('href', href);
    return node;
}

const MODE_BADGES = {
    identification: 'Acquisition lexicale',
    reverse: 'Acquisition lexicale',
    frappe: 'Acquisition lexicale',
    contexte: 'Distinction sémantique',
    jumelage: 'Distinction sémantique',
    'frappe-contexte': 'Distinction sémantique',
};
const MODE_LABELS = {
    identification: 'Quel est ce mot ?',
    reverse: 'Quelle est sa définition ?',
    frappe: 'Tape le mot',
    contexte: 'Le mot juste, c’est lequel ?',
    jumelage: 'Sa définition, c’est laquelle ?',
    'frappe-contexte': 'Tape le mot juste',
};
const MODE_HINTS = {
    identification: 'Une bonne réponse renforce le mot ; une erreur le fera revenir plus tard.',
    reverse: 'Quatre définitions, une seule est celle du mot.',
    frappe: 'Une faute de frappe passe ; un autre mot, non.',
    contexte: 'Deux mots souvent confondus : le contexte tranche.',
    jumelage: 'Deux définitions, deux mots souvent confondus : la nuance tranche.',
    'frappe-contexte': 'Le contexte dit tout : tape le mot qu’il appelle.',
};

export function renderRound(root, round, base, state, category) {
    root.textContent = '';
    const card = el('form', 'game-card');
    card.appendChild(el('p', 'game-mode')).appendChild(el('span', null, MODE_BADGES[round.mode]));
    card.appendChild(el('p', 'game-label', MODE_LABELS[round.mode]));
    card.appendChild(el('p', 'game-definition', round.prompt));
    if (round.mode === 'frappe' || round.mode === 'frappe-contexte') {
        const row = el('div', 'guess-row');
        const input = el('input', 'guess-input');
        input.name = 'guess';
        input.maxLength = 60;
        input.autocomplete = 'off';
        input.spellcheck = false;
        input.placeholder = 'Le mot…';
        input.setAttribute('aria-label', 'Ta réponse');
        input.required = true;
        row.appendChild(input);
        const submit = el('button', 'btn btn-primary', 'Valider');
        submit.type = 'submit';
        row.appendChild(submit);
        card.appendChild(row);
    } else if (round.options) {
        const list = el('ul', 'options');
        for (const option of round.options) {
            const item = el('li');
            const button = el(
                'button',
                `option-btn${round.mode === 'reverse' || round.mode === 'jumelage' ? ' option-def' : ''}`,
                option.label
            );
            button.type = 'submit';
            button.name = 'choice';
            button.value = option.id;
            item.appendChild(button);
            list.appendChild(item);
        }
        card.appendChild(list);
    }
    card.appendChild(el('p', 'game-hint', MODE_HINTS[round.mode]));

    const stats = el('p', 'game-stats');
    const countsNow = counts(state);
    let statsText = `Série ${state.session.streak}`;
    if (category) {
        statsText += ` · catégorie ${category} · ${levelLabel(state, category)}`;
    }
    stats.appendChild(document.createTextNode(`${statsText} · `));
    stats.appendChild(el('a', null, `${countsNow.due} à revoir`, `${base}/progress`));
    card.appendChild(stats);

    root.appendChild(card);
    return card;
}

export function renderResult(root, base, round, answer, correct, word, state, acquisitions, category) {
    root.textContent = '';
    const card = el('div', 'result-card');
    if (correct) {
        card.appendChild(el('p', 'verdict correct', 'Bien vu !'));
        card.appendChild(el('p', 'verdict-sub', `C’était bien ${word.text}.`));
    } else {
        card.appendChild(el('p', 'verdict incorrect', 'Raté…'));
        if (round.mode === 'frappe' || round.mode === 'frappe-contexte') {
            card.appendChild(el('p', 'verdict-sub', `Tu as tapé « ${answer} ».`));
        } else {
            card.appendChild(el('p', 'verdict-sub', 'Ce n’était pas la bonne réponse.'));
        }
    }
    const wordLink = el('p', 'result-word');
    wordLink.appendChild(el('a', null, word.text, `${base}/words/${encodeURIComponent(word.text)}`));
    card.appendChild(wordLink);

    if (round.sentence) {
        card.appendChild(el('p', 'result-example', round.sentence));
    }
    card.appendChild(el('p', 'result-def', word.short_definition));
    if (round.nuance && (round.mode === 'jumelage' || round.mode === 'contexte')) {
        const nuanceCard = el('div', 'nuance-card');
        nuanceCard.appendChild(el('p', 'nuance-title', 'La nuance'));
        nuanceCard.appendChild(el('p', null, round.nuance));
        card.appendChild(nuanceCard);
    }
    if (word.examples && word.examples.length > 0 && round.mode !== 'contexte' && round.sentence) {
        const others = word.examples.filter(example => example !== round.sentence);
        if (others.length > 0) {
            card.appendChild(el('p', 'result-example', others[Math.floor(Math.random() * others.length)]));
        }
    }

    const block = el('div', 'progress-block');
    let headline = `Score ${state.session.score} · Série ${state.session.streak} (record ${state.session.best})`;
    if (category) {
        headline += ` · catégorie ${category} · ${levelLabel(state, category)}`;
    }
    block.appendChild(el('p', 'progress-line', headline));
    for (const acquisition of acquisitions) {
        block.appendChild(
            el('p', 'progress-line celebration', `Bande ${acquisition.band} acquise en ${acquisition.category} !`)
        );
    }
    const c = counts(state);
    const line = el('p', 'progress-line muted');
    line.appendChild(document.createTextNode(`Maîtrisés : ${c.mastered} · En cours : ${c.learning} · À revoir : ${c.due} · `));
    line.appendChild(el('a', null, 'voir la collection', `${base}/progress`));
    block.appendChild(line);
    card.appendChild(block);

    const actions = el('div', 'result-actions');
    actions.appendChild(el('button', 'btn btn-primary', 'Rejouer'));
    actions.appendChild(el('a', 'btn btn-secondary', 'Voir la fiche', `${base}/words/${encodeURIComponent(word.text)}`));
    card.appendChild(actions);

    root.appendChild(card);
    return card;
}

// ---------------------------------------------------------------------------
// Page Progression (rendu client, comme avant)
// ---------------------------------------------------------------------------

export function renderProgress(root, base, state, language = 'fr') {
    root.textContent = '';
    const session = state.session;
    const c = counts(state);
    const head = el('div', 'progress-summary');
    head.appendChild(el('p', null, `Score ${session.score} · Série ${session.streak} (record ${session.best})`));
    head.appendChild(
        el('p', 'muted', `${c.seen} mots vus · ${c.mastered} maîtrisés · ${c.learning} en cours · ${c.due} à revoir`)
    );
    const reset = el('button', 'btn btn-secondary', 'Effacer ma progression');
    reset.addEventListener('click', () => {
        if (window.confirm('Effacer toute ta progression dans ce navigateur ?')) {
            localStorage.removeItem(storageKey(language));
            renderProgress(root, base, loadState(localStorage, language), language);
        }
    });
    head.appendChild(reset);
    root.appendChild(head);

    if (c.seen === 0) {
        root.appendChild(el('p', 'page-sub', `Rien pour l’instant : joue quelques parties et ta collection apparaîtra ici.`));
        const play = el('a', 'btn btn-primary', 'Jouer', `${base}/game`);
        root.appendChild(play);
        return;
    }

    const categories = collectCategories(state);
    if (categories.length > 0) {
        root.appendChild(el('h2', 'progress-group-title', 'Catégories'));
        const catList = el('div', 'category-list');
        for (const category of categories) {
            const card = el('div', 'category-card');
            card.appendChild(el('span', 'badge level-badge', levelLabel(state, category.name)));
            card.appendChild(el('p', 'category-name', category.name));
            const chips = el('div', 'chips');
            for (const word of category.words) {
                const chip = el(
                    'a',
                    `chip word-box-${word.box}${word.due <= Date.now() ? ' chip-due' : ''}`,
                    word.text,
                    `${base}/words/${encodeURIComponent(word.text)}`
                );
                chip.style.setProperty('--diff', difficultyInfo(word.difficulty).color);
                chip.title = `${difficultyInfo(word.difficulty).name} · boîte ${word.box}`;
                chips.appendChild(chip);
            }
            card.appendChild(chips);
            card.appendChild(
                el(
                    'a',
                    'btn btn-secondary category-play',
                    'Jouer cette catégorie',
                    `${base}/game?category=${encodeURIComponent(category.name)}`
                )
            );
            catList.appendChild(card);
        }
        root.appendChild(catList);
    }
}

function collectCategories(state) {
    const byName = new Map();
    for (const [id, entry] of Object.entries(state.words)) {
        for (const name of entry.categories ?? []) {
            if (!byName.has(name)) byName.set(name, []);
            byName.get(name).push({ id, ...entry });
        }
    }
    const categories = [...byName.entries()].map(([name, words]) => ({ name, words }));
    categories.sort((a, b) => categoryLevel(state, b.name) - categoryLevel(state, a.name) || a.name.localeCompare(b.name));
    return categories;
}

// ---------------------------------------------------------------------------
// Page d'accueil (cartes de catégories enrichies)
// ---------------------------------------------------------------------------

export function renderHomeCategories(grid, state) {
    const cards = [...grid.querySelectorAll('[data-category]')];
    if (cards.length === 0) return;
    const played = [];
    const fresh = [];
    for (const card of cards) {
        const name = card.dataset.category;
        recordTotal(state, name, card.dataset.total);
        card.appendChild(el('span', 'badge level-badge', levelLabel(state, name, card.dataset.total)));
        (isPlayedCategory(state, name) || (state.bands[name] ?? []).length > 0 ? played : fresh).push(card);
    }
    const groups = el('div', 'category-groups');
    const buildGroup = (title, list) => {
        if (list.length === 0) return;
        const group = el('div', 'category-group');
        group.appendChild(el('p', 'group-title', title));
        const inner = el('div', 'category-list');
        for (const card of list) inner.appendChild(card);
        group.appendChild(inner);
        groups.appendChild(group);
    };
    buildGroup('Tes catégories', played);
    buildGroup('À explorer', fresh);
    grid.replaceWith(groups);
}

// ---------------------------------------------------------------------------
// Démarrage de la page de jeu
// ---------------------------------------------------------------------------

export function startGame(root, dictionary, { base, language, storage, state }) {
    const params = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
    const category = params.get('category');
    const modeParam = params.get('mode');
    const track = params.get('track');
    const wordParam = params.get('word');
    const validModes = ['identification', 'reverse', 'frappe', 'contexte', 'jumelage', 'frappe-contexte'];
    const mode = validModes.includes(modeParam) ? modeParam : null;
    const wordId =
        wordParam !== null && Number.isInteger(Number.parseInt(wordParam, 10)) ? Number.parseInt(wordParam, 10) : null;

    const session = { category, mode, track, wordId };
    let current = null;

    const answer = (choice, guess) => {
        const byId = wordsById(dictionary);
        const word = byId.get(current.target);
        if (!word) {
            next();
            return;
        }
        let answerValue = null;
        let correct = false;
        if (current.mode === 'frappe' || current.mode === 'frappe-contexte') {
            answerValue = guess ?? '';
            correct = isCloseMatch(answerValue, word.text);
        } else {
            answerValue = choice;
            correct = Number.parseInt(choice, 10) === current.target;
        }
        const acquisitions = recordRound(state, {
            targetId: word.id,
            text: word.text,
            difficulty: word.difficulty,
            correct,
            categories: word.categories ?? [],
        });
        saveState(storage, state, language);
        const result = renderResult(root, base, current, answerValue, correct, word, state, acquisitions, session.category);
        result.querySelector('.btn-primary').addEventListener('click', next);
    };

    const served = []; // mots déjà servis dans la session : on les évite tant qu'il reste du choix
    const SERVED_CAP = 30;

    const next = () => {
        current = pickRound(
            dictionary,
            state,
            {
                category: session.category,
                mode: session.mode,
                track: session.track,
                wordId: session.wordId,
            },
            Math.random,
            new Set(served)
        );
        session.wordId = null; // le mot précis ne sert qu'au premier round
        served.unshift(current.target);
        if (served.length > SERVED_CAP) served.pop();
        const card = renderRound(root, current, base, state, session.category);
        for (const button of card.querySelectorAll('.option-btn')) {
            button.addEventListener('click', () => answer(button.value));
        }
        card.addEventListener('submit', event => {
            event.preventDefault();
            answer(null, card.querySelector('.guess-input')?.value ?? '');
        });
    };

    next();
}

// ---------------------------------------------------------------------------
// Câblage au chargement
// ---------------------------------------------------------------------------

if (typeof document !== 'undefined') {
    const base = document.body?.dataset?.base ?? '';
    const language = document.body?.dataset?.language || 'fr';
    const storage = typeof localStorage !== 'undefined' ? localStorage : null;
    const state = loadState(storage, language);
    const resultRoot = document.getElementById('progress-root');
    const categoryGrid = document.getElementById('category-grid');
    const gameRoot = document.getElementById('game-root');
    if (resultRoot) renderProgress(resultRoot, base, state, language);
    if (categoryGrid) renderHomeCategories(categoryGrid, state);
    if (resultRoot || categoryGrid) {
        saveState(storage, state, language);
    }
    if (gameRoot) {
        const dictionaryUrl = document.body.dataset.dictionary;
        fetch(dictionaryUrl)
            .then(response => response.json())
            .then(dictionary => {
                startGame(gameRoot, dictionary, { base, language, storage, state });
            })
            .catch(() => {
                gameRoot.appendChild(el('p', 'page-sub', 'Le dictionnaire n’a pas pu être chargé.'));
            });
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.register(`${document.body.dataset.root ?? ''}/sw.js`).catch(() => {});
        }
    }
}
