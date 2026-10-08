const CORRECT_INTERVALS_MS = [8 * 3600e3, 24 * 3600e3, 3 * 86400e3, 7 * 86400e3, 30 * 86400e3];
const WRONG_RETRY_MS = 10 * 60e3;
const MASTERED_BOX = 4;
const ACQUIRED_BOX = 2;
const MAX_BAND = 5;
const BAND_ACQUISITION_WORDS = 2;
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

function toCount(value) {
    return Number.isInteger(value) && value >= 0 ? value : 0;
}

function sanitizeEntry(entry) {
    const box = Number.isInteger(entry.box) ? Math.min(5, Math.max(0, entry.box)) : 0;
    const due = Number.isFinite(entry.due) && entry.due >= 0 ? entry.due : 0;
    const categories = Array.isArray(entry.categories)
        ? entry.categories.filter(name => typeof name === 'string' && name !== '')
        : [];
    return {
        text: entry.text,
        difficulty: entry.difficulty,
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
    if (typeof bands !== 'object' || bands === null || Array.isArray(bands)) return {};
    const clean = {};
    for (const [name, list] of Object.entries(bands)) {
        if (typeof name !== 'string' || name === '' || !Array.isArray(list)) continue;
        const levels = [...new Set(list.filter(level => Number.isInteger(level) && level >= 1 && level <= MAX_BAND))];
        if (levels.length > 0) clean[name] = levels;
    }
    return clean;
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
                ? Object.fromEntries(Object.entries(parsed.totals).filter(([, count]) => Number.isInteger(count)))
                : {};
        return state;
    } catch {
        return newState();
    }
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

export function saveState(storage, state, language = 'fr') {
    storage?.setItem(storageKey(language), JSON.stringify(state));
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
    entry.categories = Array.isArray(categories) ? categories.filter(name => typeof name === 'string' && name !== '') : [];
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
    if (correct && entry.box >= 2) {
        for (const name of entry.categories) {
            const acquired = acquireBand(state, name, difficulty);
            if (acquired) acquisitions.push({ category: name, band: difficulty });
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
    const bands = state.bands[name] ?? [];
    if (bands.includes(band)) return false;
    const ready = Object.values(state.words).filter(
        word => word.difficulty === band && (word.categories ?? []).includes(name) && word.box >= 2
    ).length;
    if (ready < BAND_ACQUISITION_WORDS) return false;
    bands.push(band);
    state.bands[name] = bands;
    return true;
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

function el(tag, className, text, href) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    if (href) node.setAttribute('href', href);
    return node;
}

function parseCategories(raw) {
    if (typeof raw !== 'string' || raw === '') return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter(name => typeof name === 'string') : [];
    } catch {
        return [];
    }
}

export function buildReplayHref(round, base, state) {
    const { category = '', modeFixe = false, mode = '', replayHref = '' } = round;
    const appendTo = (href, params) => href + (href.includes('?') ? '&' : '?') + params;
    const due = dueWords(state);
    if (category) {
        let href = `${base}/game?category=${encodeURIComponent(category)}`;
        if (modeFixe && mode) href = appendTo(href, `mode=${mode}`);
        if (due.length > 0) return appendTo(href, `word=${due[0].id}`);
        const level = categoryLevel(state, category);
        const band = Math.random() < PROBE_PROBABILITY ? Math.min(MAX_BAND, level + 1) : level;
        return appendTo(href, `band=${band}`);
    }
    if (due.length > 0) return appendTo(replayHref || `${base}/game`, `word=${due[0].id}`);
    return replayHref || `${base}/game`;
}

export function renderResultCard(card, base, state) {
    const acquisitions = recordRound(state, {
        targetId: card.dataset.targetId,
        text: card.dataset.targetText,
        difficulty: Number.parseInt(card.dataset.difficulty, 10),
        correct: card.dataset.correct === 'true',
        categories: parseCategories(card.dataset.categories),
    });
    const block = el('div', 'progress-block');
    const session = state.session;
    const category = card.dataset.category || '';
    const categoryTotal = card.dataset.categoryTotal;
    if (category && categoryTotal) recordTotal(state, category, categoryTotal);
    let headline = `Score ${session.score} · Série ${session.streak} (record ${session.best})`;
    if (category) {
        headline += ` · catégorie ${category} · ${levelLabel(state, category, categoryTotal)}`;
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

    const replay = card.querySelector('.result-actions .btn-primary');
    if (replay) {
        replay.setAttribute(
            'href',
            buildReplayHref(
                {
                    category,
                    modeFixe: card.dataset.modeFixe === 'true',
                    mode: card.dataset.mode || '',
                    replayHref: card.dataset.replayHref || '',
                },
                base,
                state
            )
        );
    }
}

export function renderGameCard(card, base, state) {
    const session = state.session;
    const c = counts(state);
    const category = card.querySelector('input[name="category"]')?.value ?? '';
    const categoryTotal = card.querySelector('input[name="categorytotal"]')?.value;
    if (category && categoryTotal) recordTotal(state, category, categoryTotal);
    const line = el('p', 'game-stats');
    let stats = `Série ${session.streak}`;
    if (category) {
        stats += ` · catégorie ${category} · ${levelLabel(state, category, categoryTotal)}`;
    }
    line.appendChild(document.createTextNode(`${stats} · `));
    line.appendChild(el('a', null, `${c.due} à revoir`, `${base}/progress`));
    card.appendChild(line);
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

function recordTotal(state, name, total) {
    const count = Number.parseInt(total, 10);
    if (Number.isInteger(count) && count > 0) state.totals[name] = count;
}

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

function levelLabel(state, name, total) {
    if (!isPlayedCategory(state, name) && (state.bands[name] ?? []).length === 0) return 'nouveau';
    const parsed = Number.parseInt(total, 10);
    const percent =
        Number.isInteger(parsed) && parsed > 0
            ? categoryPercent(state, name, parsed)
            : categoryPercent(state, name, state.totals[name]);
    return percent === null ? 'en route' : `${percent} %`;
}

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
        root.appendChild(
            el(
                'p',
                'page-sub',
                `Rien pour l’instant : l’enregistrement de tes rounds a démarré avec cette mise à jour, joue quelques parties et ta collection apparaîtra ici.`
            )
        );
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

if (typeof document !== 'undefined') {
    const base = document.body?.dataset?.base ?? '';
    const language = document.body?.dataset?.language || 'fr';
    const storage = typeof localStorage !== 'undefined' ? localStorage : null;
    const state = loadState(storage, language);
    const resultCard = document.querySelector('.result-card[data-mode]');
    const gameCard = document.querySelector('.game-card');
    const progressRoot = document.getElementById('progress-root');
    const categoryGrid = document.getElementById('category-grid');
    if (resultCard) {
        renderResultCard(resultCard, base, state);
    }
    if (gameCard) renderGameCard(gameCard, base, state);
    if (progressRoot) renderProgress(progressRoot, base, state, language);
    if (categoryGrid) renderHomeCategories(categoryGrid, state);
    if (resultCard || gameCard || categoryGrid) {
        saveState(storage, state, language);
    }
}
