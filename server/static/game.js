const STORAGE_KEY = 'vocab:progress:v1';
const CORRECT_INTERVALS_MS = [8 * 3600e3, 24 * 3600e3, 3 * 86400e3, 7 * 86400e3, 30 * 86400e3];
const WRONG_RETRY_MS = 10 * 60e3;
const MASTERED_BOX = 4;
const MAX_LEVEL = 5;
const UNLOCK_THRESHOLD = 5;

export function newState() {
    return { words: {}, session: { rounds: 0, score: 0, streak: 0, best: 0, unlocked: 1, frontierCorrect: 0 } };
}

export function loadState(storage) {
    try {
        const raw = storage?.getItem(STORAGE_KEY);
        if (!raw) return newState();
        const parsed = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null || typeof parsed.words !== 'object' || !parsed.session) {
            return newState();
        }
        const base = newState();
        return { ...base, ...parsed, session: { ...base.session, ...parsed.session } };
    } catch {
        return newState();
    }
}

export function saveState(storage, state) {
    storage?.setItem(STORAGE_KEY, JSON.stringify(state));
}

export function recordRound(state, round) {
    const { targetId, text, difficulty, correct, now = Date.now() } = round;
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

export function renderResultCard(card, base, state) {
    const correct = card.dataset.correct === 'true';
    recordRound(state, {
        targetId: card.dataset.targetId,
        text: card.dataset.targetText,
        difficulty: Number.parseInt(card.dataset.difficulty, 10),
        correct,
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
    line.appendChild(document.createTextNode(`Maîtrisés : ${c.mastered} · En cours : ${c.learning} · À revoir : ${c.due} — `));
    line.appendChild(el('a', null, 'voir la collection', `${base}/progress`));
    block.appendChild(line);
    card.appendChild(block);

    const replay = card.querySelector('.result-actions .btn-primary');
    const due = dueWords(state);
    if (replay) {
        if (due.length > 0) {
            replay.setAttribute('href', `${base}/game?mot=${due[0].id}`);
            replay.textContent = 'Rejouer un mot à revoir';
        } else if (session.unlocked < MAX_LEVEL) {
            replay.setAttribute('href', `${base}/game?max=${session.unlocked}`);
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

export function renderProgress(root, base, state) {
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
            localStorage.removeItem(STORAGE_KEY);
            renderProgress(root, base, loadState(localStorage));
        }
    });
    head.appendChild(reset);
    root.appendChild(head);

    if (c.seen === 0) {
        root.appendChild(el('p', 'page-sub', `Rien encore — joue quelques rounds et ta collection apparaîtra ici.`));
        const play = el('a', 'btn btn-primary', 'Jouer', `${base}/game`);
        root.appendChild(play);
        return;
    }

    const groups = [
        { title: 'À revoir', entries: dueWords(state) },
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
            list.appendChild(item);
        }
        root.appendChild(list);
    }
}

if (typeof document !== 'undefined') {
    const base = document.body?.dataset?.base ?? '';
    const state = loadState(typeof localStorage !== 'undefined' ? localStorage : null);
    const resultCard = document.querySelector('.result-card[data-target-id]');
    const gameCard = document.querySelector('.game-card');
    const progressRoot = document.getElementById('progress-root');
    if (resultCard) {
        renderResultCard(resultCard, base, state);
        saveState(typeof localStorage !== 'undefined' ? localStorage : null, state);
    }
    if (gameCard) renderGameCard(gameCard, base, state);
    if (progressRoot) renderProgress(progressRoot, base, state);
}
