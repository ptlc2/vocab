const LEGACY_STORAGE_KEY = 'vocab:progress:v1';
const CORRECT_INTERVALS_MS = [8 * 3600e3, 24 * 3600e3, 3 * 86400e3, 7 * 86400e3, 30 * 86400e3];
const WRONG_RETRY_MS = 10 * 60e3;
const MASTERED_BOX = 4;
const MAX_LEVEL = 5;
const UNLOCK_THRESHOLD = 5;
const CATEGORY_UNLOCK_WORDS = 2;

export function newState() {
    return {
        words: {},
        session: { rounds: 0, score: 0, streak: 0, best: 0, unlocked: 1, frontierCorrect: 0 },
        categories: {},
    };
}

export function storageKey(language = 'fr') {
    return `vocab:progress:v1:${language}`;
}

function migrateLegacyState(storage, language) {
    const legacy = storage?.getItem(LEGACY_STORAGE_KEY);
    if (legacy !== null && storage?.getItem(storageKey(language)) === null) {
        storage.setItem(storageKey(language), legacy);
        storage.removeItem(LEGACY_STORAGE_KEY);
    }
}

export function loadState(storage, language = 'fr') {
    try {
        migrateLegacyState(storage, language);
        const raw = storage?.getItem(storageKey(language));
        if (!raw) return newState();
        const parsed = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null || typeof parsed.words !== 'object' || !parsed.session) {
            return newState();
        }
        const base = newState();
        const state = { ...base, ...parsed, session: { ...base.session, ...parsed.session } };
        state.words = Object.fromEntries(Object.entries(parsed.words ?? {}).filter(([id, entry]) => isValidEntry(id, entry)));
        state.categories = typeof parsed.categories === 'object' && parsed.categories !== null ? parsed.categories : {};
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
        return state;
    }
    const id = String(targetId);
    const entry = state.words[id] ?? { text, difficulty, box: 0, due: 0, correct: 0, wrong: 0 };
    entry.text = text;
    entry.difficulty = difficulty;
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

    if (correct) {
        for (const name of categories) {
            const category = (state.categories[name] ??= { correctIds: {} });
            category.correctIds[id] = true;
        }
    }

    const session = state.session;
    session.rounds += 1;
    if (correct) {
        session.score += 1;
        session.streak += 1;
        session.best = Math.max(session.best, session.streak);
        if (difficulty === session.unlocked && session.unlocked < MAX_LEVEL) {
            session.frontierCorrect += 1;
            if (session.frontierCorrect >= UNLOCK_THRESHOLD) {
                session.unlocked += 1;
                session.frontierCorrect = 0;
            }
        }
    } else {
        session.streak = 0;
    }
    return state;
}

export function isCategoryUnlocked(category) {
    return Object.keys(category.correctIds).length >= CATEGORY_UNLOCK_WORDS;
}

export function categoryStats(state) {
    const entries = Object.entries(state.categories).map(([name, category]) => ({
        name,
        correctCount: Object.keys(category.correctIds).length,
        unlocked: Object.keys(category.correctIds).length >= CATEGORY_UNLOCK_WORDS,
        wordIds: Object.keys(category.correctIds),
    }));
    entries.sort((a, b) => b.correctCount - a.correctCount || a.name.localeCompare(b.name));
    return entries;
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

export function renderResultCard(card, base, state) {
    recordRound(state, {
        targetId: card.dataset.targetId,
        text: card.dataset.targetText,
        difficulty: Number.parseInt(card.dataset.difficulty, 10),
        correct: card.dataset.correct === 'true',
        categories: parseCategories(card.dataset.categories),
    });
    const block = el('div', 'progress-block');
    const session = state.session;
    block.appendChild(
        el(
            'p',
            'progress-line',
            `Score ${session.score} · Série ${session.streak} (record ${session.best}) · Palier ${session.unlocked}/${MAX_LEVEL}`
        )
    );
    const c = counts(state);
    const line = el('p', 'progress-line muted');
    line.appendChild(document.createTextNode(`Maîtrisés : ${c.mastered} · En cours : ${c.learning} · À revoir : ${c.due} · `));
    line.appendChild(el('a', null, 'voir la collection', `${base}/progress`));
    block.appendChild(line);
    card.appendChild(block);

    const replay = card.querySelector('.result-actions .btn-primary');
    if (replay) {
        const sticky = card.dataset.sticky === 'true';
        const mode = card.dataset.mode;
        const baseHref = card.dataset.replayHref || `${base}/game`;
        const recallModes = mode === 'identification' || mode === 'reverse' || mode === 'frappe';
        const appendTo = (href, params) => href + (href.includes('?') ? '&' : '?') + params;
        if (!sticky || recallModes) {
            const due = dueWords(state);
            if (due.length > 0) {
                replay.setAttribute('href', appendTo(baseHref, `mot=${due[0].id}`));
            } else if (session.unlocked < MAX_LEVEL) {
                replay.setAttribute('href', appendTo(baseHref, `max=${session.unlocked}`));
            }
        }
    }
}

export function renderGameCard(card, base, state) {
    const session = state.session;
    const c = counts(state);
    const line = el('p', 'game-stats');
    line.appendChild(document.createTextNode(`Série ${session.streak} · Palier ${session.unlocked}/${MAX_LEVEL} · `));
    line.appendChild(el('a', null, `${c.due} à revoir`, `${base}/progress`));
    card.appendChild(line);
}

export function renderProgress(root, base, state, language = 'fr') {
    root.textContent = '';
    const session = state.session;
    const c = counts(state);
    const head = el('div', 'progress-summary');
    head.appendChild(
        el(
            'p',
            null,
            `Score ${session.score} · Série ${session.streak} (record ${session.best}) · Palier ${session.unlocked}/${MAX_LEVEL}`
        )
    );
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

    const categories = categoryStats(state);
    if (categories.length > 0) {
        root.appendChild(el('h2', 'progress-group-title', 'Catégories'));
        const catList = el('div', 'category-list');
        for (const category of categories) {
            const item = el('div', `category-card${category.unlocked ? '' : ' locked'}`);
            item.appendChild(el('p', 'category-name', category.name));
            if (category.unlocked) {
                const chips = el('div', 'chips');
                for (const wordId of category.wordIds) {
                    const word = state.words[wordId];
                    if (word) {
                        chips.appendChild(el('a', 'chip', word.text, `${base}/words/${encodeURIComponent(word.text)}`));
                    }
                }
                item.appendChild(chips);
                item.appendChild(
                    el(
                        'a',
                        'btn btn-secondary category-play',
                        'Jouer cette catégorie',
                        `${base}/game?categorie=${encodeURIComponent(category.name)}`
                    )
                );
            } else {
                item.appendChild(
                    el(
                        'p',
                        'category-progress',
                        `${category.correctCount}/${CATEGORY_UNLOCK_WORDS} mot${category.correctCount > 1 ? 's' : ''} réussi${category.correctCount > 1 ? 's' : ''} pour débloquer`
                    )
                );
            }
            catList.appendChild(item);
        }
        root.appendChild(catList);
    }

    const groups = [
        { title: 'À revoir', entries: dueWords(state), testable: true },
        {
            title: 'En cours',
            entries: Object.entries(state.words)
                .filter(([, e]) => e.box > 0 && e.box < MASTERED_BOX)
                .map(([id, e]) => ({ id, ...e })),
        },
        {
            title: 'Maîtrisés',
            entries: Object.entries(state.words)
                .filter(([, e]) => e.box >= MASTERED_BOX)
                .map(([id, e]) => ({ id, ...e })),
        },
    ];
    for (const group of groups) {
        if (group.entries.length === 0) continue;
        root.appendChild(el('h2', 'progress-group-title', `${group.title} (${group.entries.length})`));
        const list = el('ul', 'progress-list');
        for (const entry of group.entries) {
            const item = el('li', 'progress-item');
            item.appendChild(el('a', 'progress-word', entry.text, `${base}/words/${encodeURIComponent(entry.text)}`));
            item.appendChild(
                el(
                    'span',
                    'progress-meta',
                    `niveau ${entry.difficulty} · boîte ${entry.box} · ${entry.correct}✓ ${entry.wrong}✗`
                )
            );
            if (group.testable) {
                item.appendChild(el('a', 'btn btn-secondary progress-test', 'Se tester', `${base}/game?mot=${entry.id}`));
            }
            list.appendChild(item);
        }
        root.appendChild(list);
    }
}

if (typeof document !== 'undefined') {
    const base = document.body?.dataset?.base ?? '';
    const language = document.body?.dataset?.language || 'fr';
    const storage = typeof localStorage !== 'undefined' ? localStorage : null;
    const state = loadState(storage, language);
    const resultCard = document.querySelector('.result-card[data-mode]');
    const gameCard = document.querySelector('.game-card');
    const progressRoot = document.getElementById('progress-root');
    if (resultCard) {
        renderResultCard(resultCard, base, state);
        saveState(storage, state, language);
    }
    if (gameCard) renderGameCard(gameCard, base, state);
    if (progressRoot) renderProgress(progressRoot, base, state, language);
}
