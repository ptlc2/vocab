-- # Dummy SQL file to populate the database with sample data

-- volubile
INSERT INTO word (id, text, difficulty, register, short_definition, long_definition, origin, notes)
VALUES (
    1,
    'volubile',
    4,
    'soutenu',
    'Qui parle avec aisance et rapidité, souvent de manière abondante.',
    'Se dit d’une personne dont la parole s’écoule avec une aisance vive et soutenue, parfois au point de devenir difficile à interrompre.',
    'latin (volubilis)',
    ''
);
INSERT INTO example (word_id, sentence)
VALUES
(1, 'Elle s’exprimait d’un ton volubile, presque intarissable.'),
(1, 'Son humeur joyeuse la rendait ce soir particulièrement volubile.');

-- prolixe
INSERT INTO word (id, text, difficulty, register, short_definition, long_definition, origin, notes)
VALUES (
    2,
    'prolixe',
    4,
    'soutenu',
    'Qui s’exprime en usant d’un excès de mots, de manière trop longue.',
    'Caractérise une parole ou un texte qui multiplie les termes et les détours, s’étendant plus qu’il ne serait nécessaire.',
    'latin (prolixus)',
    ''
);
INSERT INTO example (word_id, sentence)
VALUES
(2, 'Son rapport, d’une longueur prolixe, découragea toute l’assemblée.'),
(2, 'Il se lançait dans des explications prolixes qui noyaient l’essentiel.');

-- bavard
INSERT INTO word (id, text, difficulty, register, short_definition, long_definition)
VALUES (
    3,
    'bavard',
    2,
    'courant',
    'Qui parle beaucoup.',
    'Qualifie une personne ayant tendance à se répandre en paroles plus que nécessaire.'
);

-- verbeux
INSERT INTO word (id, text, difficulty, register, short_definition, long_definition)
VALUES (
    4,
    'verbeux',
    3,
    'courant',
    'Qui utilise trop de mots.',
    'Se dit d’un discours qui s’étend inutilement, alourdissant la formulation sans la rendre plus précise.'
);


-- volubile x bavard
INSERT INTO confusion (word1_id, word2_id, nuance)
VALUES (1, 3, 'Le terme "volubile" met l’accent sur la fluidité et la rapidité de la parole, tandis que "bavard" souligne simplement la quantité de paroles.');

-- prolixe ~ verbeux
INSERT INTO near_words (word1_id, word2_id)
VALUES (2, 4);

-- Resynchronisation des séquences après les ids explicites
SELECT setval('word_id_seq', (SELECT MAX(id) FROM word));
