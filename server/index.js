import Express from 'express';
import * as Vocab from './vocab.js';
import { Difficulties } from './difficulties.js';

const port = process.env.PORT ?? '80';

const app = Express();

app.use(Express.static('static'));
app.use(Express.urlencoded({ extended: false }));

app.set('view engine', 'ejs');
app.set('views', 'views');
app.locals.base = process.env.BASE_PATH ?? '/vocab';
app.locals.description =
    'Apprendre le vocabulaire français par le jeu : définitions, nuances, mots proches et confusions classiques.';
app.locals.difficulties = Difficulties;

// Locale middleware
app.use((req, res, next) => {
    res.locals.locale = firstValidLocale(req.acceptsLanguages());
    next();
});

function firstValidLocale(langs) {
    for (const lang of langs ?? []) {
        if (lang === '*' || lang === undefined) continue;
        try {
            Intl.getCanonicalLocales(lang);
            return lang;
        } catch {
            continue;
        }
    }
    return 'fr';
}

// Homepage route
app.get('/', async (req, res) => {
    const stats = await Vocab.getStats();
    res.render('index', { stats });
});

// Word list route
app.get('/words', async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 60) : '';
    const category = typeof req.query.categorie === 'string' ? req.query.categorie.trim().slice(0, 60) : '';
    const words = await Vocab.getWordsWithMeta({ q, category });
    const categories = await Vocab.getCategoriesWithCounts();
    const groups = [1, 2, 3, 4, 5]
        .map(level => ({ ...Difficulties[level], words: words.filter(word => word.difficulty === level) }))
        .filter(group => group.words.length > 0);
    res.render('words', { words, groups, categories, q, category, total: words.length });
});

// Word route
app.get('/words/:word', async (req, res) => {
    const word = await Vocab.getWordByText(req.params.word);
    if (word) {
        res.render('word', { word });
    } else {
        res.status(404).render('error', { code: 404, message: 'Mot non trouvé' });
    }
});
// Game route
app.get('/game', async (req, res) => {
    const motId = Number.parseInt(req.query.mot, 10);
    const maxId = Number.parseInt(req.query.max, 10);
    const mode = ['acquisition', 'reverse', 'frappe', 'distinction', 'jumelage', 'frappe-contexte'].includes(req.query.mode)
        ? req.query.mode
        : null;
    const category = typeof req.query.categorie === 'string' ? req.query.categorie.trim().slice(0, 60) : '';
    const game = await Vocab.getGame({
        wordId: Number.isInteger(motId) ? motId : null,
        mode,
        maxDifficulty: Number.isInteger(maxId) ? Math.max(1, Math.min(5, maxId)) : null,
        category: category || null,
    });
    res.render('game', { game, sticky: mode !== null || Number.isInteger(motId) });
});
// Progress route
app.get('/progress', (req, res) => {
    res.render('progress');
});

// Game answer route
app.post('/game/answer', async (req, res) => {
    const body = req.body ?? {};
    const mode = ['acquisition', 'reverse', 'frappe', 'distinction', 'jumelage', 'frappe-contexte'].includes(body.mode)
        ? body.mode
        : 'acquisition';

    if (mode === 'frappe' || mode === 'frappe-contexte') {
        const targetId = Number.parseInt(body.target, 10);
        const guess = typeof body.guess === 'string' ? body.guess.slice(0, 60) : '';
        if (!Number.isInteger(targetId) || guess.trim() === '') {
            res.status(400).render('error', { code: 400, message: 'Réponse invalide' });
            return;
        }
        const target = await Vocab.getWordById(targetId);
        if (!target) {
            res.status(404).render('error', { code: 404, message: 'Mot non trouvé' });
            return;
        }
        const otherId = Number.parseInt(body.other, 10);
        const other = mode === 'frappe-contexte' && Number.isInteger(otherId) ? await Vocab.getWordById(otherId) : null;
        const sentence = mode === 'frappe-contexte' && typeof body.sentence === 'string' ? body.sentence.slice(0, 500) : null;
        const nuance = mode === 'frappe-contexte' && typeof body.nuance === 'string' ? body.nuance.slice(0, 500) : null;
        res.render('game-result', {
            mode,
            correct: Vocab.isCloseMatch(guess, target.text),
            guess,
            definition: target.short_definition,
            sentence,
            nuance,
            other: other ?? null,
            example: target.examples.length > 0 ? target.examples[Math.floor(Math.random() * target.examples.length)] : null,
            sticky: body.sticky === '1',
            target,
            choice: null,
        });
        return;
    }

    const targetId = Number.parseInt(body.target, 10);
    const choiceId = Number.parseInt(body.choice, 10);
    if (!Number.isInteger(targetId) || !Number.isInteger(choiceId)) {
        res.status(400).render('error', { code: 400, message: 'Réponse invalide' });
        return;
    }
    const sentence = mode === 'distinction' && typeof body.sentence === 'string' ? body.sentence.slice(0, 500) : null;
    const nuance =
        (mode === 'distinction' || mode === 'jumelage') && typeof body.nuance === 'string' ? body.nuance.slice(0, 500) : null;
    const otherId = mode === 'jumelage' ? Number.parseInt(body.other, 10) : null;
    const words = await Promise.all([
        Vocab.getWordById(targetId),
        Vocab.getWordById(choiceId),
        Number.isInteger(otherId) ? Vocab.getWordById(otherId) : null,
    ]);
    const [target, choice, other] = words;
    if (!target || !choice) {
        res.status(404).render('error', { code: 404, message: 'Mot non trouvé' });
        return;
    }
    res.render('game-result', {
        correct: target.id === choice.id,
        mode,
        definition: target.short_definition,
        sentence,
        nuance,
        other: other ?? null,
        example: target.examples.length > 0 ? target.examples[Math.floor(Math.random() * target.examples.length)] : null,
        sticky: body.sticky === '1',
        target,
        choice,
    });
});

// 404 handler
app.use((req, res, _next) => {
    res.status(404).render('error', { code: 404, message: 'Page non trouvée' });
});

// Error handling
app.use((req, res, next) => {
    const origEnd = res.end;
    res.end = function (...args) {
        Promise.resolve()
            .then(() => origEnd.apply(res, args))
            .catch(next);
    };
    next();
});

app.use((err, req, res, _next) => {
    console.error(err);
    res.status(500).render('error', { code: 500, message: 'Erreur interne du serveur' });
});

// Start server
app.listen(port, err => {
    if (err) console.error(err);
    else console.info('HTTP server started');
});
