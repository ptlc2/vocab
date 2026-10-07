CREATE TABLE word (
    id SERIAL PRIMARY KEY,
    text TEXT NOT NULL,
    language TEXT NOT NULL DEFAULT 'fr',
    CONSTRAINT word_language_text_key UNIQUE (language, text),

    difficulty SMALLINT NOT NULL CHECK (difficulty BETWEEN 1 AND 5),

    register TEXT NOT NULL CHECK (
        (language = 'fr' AND register IN ('familier', 'courant', 'soutenu', 'litteraire', 'technique'))
        OR (language = 'en' AND register IN ('informal', 'standard', 'formal', 'literary', 'technical'))
    ),

    short_definition TEXT NOT NULL,
    long_definition TEXT NOT NULL,

    origin TEXT,
    notes TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);


CREATE TABLE category (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE
);

CREATE TABLE word_category (
    word_id INTEGER NOT NULL REFERENCES word(id) ON DELETE CASCADE,
    category_id INTEGER NOT NULL REFERENCES category(id) ON DELETE CASCADE,
    PRIMARY KEY (word_id, category_id)
);


CREATE TABLE example (
    id SERIAL PRIMARY KEY,
    word_id INTEGER NOT NULL REFERENCES word(id) ON DELETE CASCADE,
    sentence TEXT NOT NULL
);


CREATE TABLE near_words (
    id SERIAL PRIMARY KEY,
    word1_id INTEGER NOT NULL REFERENCES word(id) ON DELETE CASCADE,
    word2_id INTEGER NOT NULL REFERENCES word(id) ON DELETE CASCADE,
    CONSTRAINT no_self_near CHECK (word1_id <> word2_id)
);


CREATE TABLE confusion (
    id SERIAL PRIMARY KEY,
    word1_id INTEGER NOT NULL REFERENCES word(id) ON DELETE CASCADE,
    word2_id INTEGER NOT NULL REFERENCES word(id) ON DELETE CASCADE,
    nuance TEXT NOT NULL,
    CONSTRAINT no_self_confusion CHECK (word1_id <> word2_id)
);


CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_word_updated_at
BEFORE UPDATE ON word
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();


CREATE EXTENSION IF NOT EXISTS pg_trgm;
