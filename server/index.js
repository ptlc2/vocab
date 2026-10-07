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
    const mode = ['acquisition', 'reverse', 'distinction', 'jumelage'].includes(req.query.mode) ? req.query.mode : null;
    const category = typeof req.query.categorie === 'string' ? req.query.categorie.trim().slice(0, 60) : '';
    const game = await Vocab.getGame({
        wordId: Number.isInteger(motId) ? motId : null,
        mode,
        maxDifficulty: Number.isInteger(maxId) ? Math.max(1, Math.min(5, maxId)) : null,
        category: category || null,
    });
    res.render('game', { game });
});
// Progress route
app.get('/progress', (req, res) => {
    res.render('progress');
});

// Game answer route
app.post('/game/answer', async (req, res) => {
    const body = req.body ?? {};
    const mode = ['distinction', 'jumelage', 'reverse'].includes(body.mode) ? body.mode : 'acquisition';

    if (mode === 'jumelage') {
        const target1 = Number.parseInt(body.target1, 10);
        const target2 = Number.parseInt(body.target2, 10);
        const choice1 = Number.parseInt(body.choice1, 10);
        const choice2 = Number.parseInt(body.choice2, 10);
        if (![target1, target2, choice1, choice2].every(Number.isInteger)) {
            res.status(400).render('error', { code: 400, message: 'Réponse invalide' });
            return;
        }
        const [wordA, wordB, choice1Word, choice2Word] = await Promise.all([
            Vocab.getWordById(target1),
            Vocab.getWordById(target2),
            Vocab.getWordById(choice1),
            Vocab.getWordById(choice2),
        ]);
        if (!wordA || !wordB || !choice1Word || !choice2Word) {
            res.status(404).render('error', { code: 404, message: 'Mot non trouvé' });
            return;
        }
        const correctA = choice1 === target1;
        const correctB = choice2 === target2;
        const nuance = typeof body.nuance === 'string' ? body.nuance.slice(0, 500) : null;
        res.render('game-result', {
            mode,
            correct: correctA && correctB,
            correctA,
            correctB,
            wordA,
            wordB,
            nuance,
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
    const nuance = mode === 'distinction' && typeof body.nuance === 'string' ? body.nuance.slice(0, 500) : null;
    const [target, choice] = await Promise.all([Vocab.getWordById(targetId), Vocab.getWordById(choiceId)]);
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
