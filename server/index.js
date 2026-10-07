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
    const game = await Vocab.getAcquisitionGame(Number.isInteger(motId) ? motId : null);
    res.render('game', { game });
});

// Game answer route
app.post('/game/answer', async (req, res) => {
    const body = req.body ?? {};
    const targetId = Number.parseInt(body.target, 10);
    const choiceId = Number.parseInt(body.choice, 10);
    if (!Number.isInteger(targetId) || !Number.isInteger(choiceId)) {
        res.status(400).render('error', { code: 400, message: 'Réponse invalide' });
        return;
    }
    const [target, choice] = await Promise.all([Vocab.getWordById(targetId), Vocab.getWordById(choiceId)]);
    if (!target || !choice) {
        res.status(404).render('error', { code: 404, message: 'Mot non trouvé' });
        return;
    }
    res.render('game-result', { correct: target.id === choice.id, definition: target.short_definition, target, choice });
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
