const express = require('express');
const path = require('path');
const crypto = require('crypto');
const OpenAI = require('openai');

const app = express();
const PORT = process.env.PORT || 3000;

// Mot de passe d'accès sécurisé à l'application
// Configurable librement via la variable d'environnement APP_PASSWORD sur Render
const APP_PASSWORD = (process.env.APP_PASSWORD || "slidecraft2026").trim();

// Sessions actives en mémoire vive (Zero-Trace : aucune écriture sur disque, expiration automatique)
const activeSessions = new Map(); // token -> { createdAt: timestamp }
const SESSION_DURATION_MS = 24 * 60 * 60 * 1000; // 24 heures

// Protection contre les attaques par force brute (Brute-force protection)
const loginAttempts = new Map(); // ip -> { count, lastAttempt }
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_PERIOD_MS = 5 * 60 * 1000; // 5 minutes de verrouillage temporaire après 5 échecs

// Nettoyage périodique des sessions expirées
setInterval(() => {
    const now = Date.now();
    for (const [token, data] of activeSessions.entries()) {
        if (now - data.createdAt > SESSION_DURATION_MS) {
            activeSessions.delete(token);
        }
    }
    for (const [ip, data] of loginAttempts.entries()) {
        if (now - data.lastAttempt > LOCKOUT_PERIOD_MS) {
            loginAttempts.delete(ip);
        }
    }
}, 15 * 60 * 1000);

// Vérifier si un jeton de session est valide
function isValidSession(token) {
    if (!token || typeof token !== 'string') return false;
    const session = activeSessions.get(token);
    if (!session) return false;
    if (Date.now() - session.createdAt > SESSION_DURATION_MS) {
        activeSessions.delete(token);
        return false;
    }
    return true;
}

// Middleware d'authentification obligatoire pour les fonctionnalités sécurisées
function requireAuth(req, res, next) {
    const authHeader = req.headers['authorization'] || '';
    let token = '';
    if (authHeader.startsWith('Bearer ')) {
        token = authHeader.slice(7).trim();
    } else if (req.headers['x-auth-token']) {
        token = req.headers['x-auth-token'];
    }

    if (isValidSession(token)) {
        return next();
    }

    return res.status(401).json({ 
        error: "Accès refusé. Veuillez saisir le mot de passe pour déverrouiller l'application.",
        requireAuth: true
    });
}

// Masquer les informations du serveur
app.disable('x-powered-by');

// Middleware de sécurité et d'interdiction stricte de mise en cache (Zero-Trace)
app.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    next();
});

// Augmenter la limite pour accepter de longs textes extraits de gros documents
app.use(express.json({ limit: '50mb' }));

// Servir les fichiers statiques (index.html, etc.) depuis le dossier racine
app.use(express.static(__dirname));

// Liste des modèles dépréciés ou inaccessibles sur Groq (à ignorer systématiquement)
const DEPRECATED_MODELS = [
    'deepseek-r1-distill-llama-70b',
    'llama-3.3-70b-versatile',
    'llama-3.1-70b-versatile',
    'llama-3.1-8b-instant',
    'gemma2-9b-it',
    'mixtral-8x7b-32768',
    'llama3-70b-8192',
    'llama3-8b-8192'
];

// Prépare le texte du document pour respecter les limites TPM tout en conservant l'intégralité des documents jusqu'à ~15 pages
function smartPrepareDocumentText(rawText, maxChars = 24000) {
    if (!rawText || rawText.length <= maxChars) return rawText;

    // Isoler et sanctuariser tous les tableaux et sections de chiffres
    const tableRegex = /(?:=== \[TABLEAU [\s\S]*?=== \[FIN DU TABLEAU.*?===|(?:\|[^\n]+\|\r?\n){2,})/gi;
    const tables = rawText.match(tableRegex) || [];
    const tablesText = tables.join("\n\n");

    // Si le document est un gros fichier de plusieurs pages (> 24 000 caractères) :
    // On conserve le début (50%), la fin (30%) et les tableaux sanctuarisés
    const remainingChars = Math.max(8000, maxChars - tablesText.length);
    const headChars = Math.floor(remainingChars * 0.55);
    const tailChars = Math.floor(remainingChars * 0.35);

    const head = rawText.slice(0, headChars);
    const tail = rawText.slice(-tailChars);

    return `${head}\n\n[... SYNTHÈSE DES SECTIONS INTERMÉDIAIRES DU DOCUMENT MULTI-PAGES ...]\n\n=== [TABLEAUX ET CHIFFRES SANCTUARISÉS DU DOCUMENT] ===\n${tablesText}\n\n${tail}`;
}

// Score d'intelligence et de profondeur d'analyse (priorité absolue aux modèles de raisonnement 120B/27B/20B)
function getModelIntelligenceScore(modelId) {
    const id = (modelId || "").toLowerCase();
    if (DEPRECATED_MODELS.includes(id)) return -1;
    // Priorité 1 : Modèles géants actifs (120B)
    if (id.includes('120b')) return 95;
    // Priorité 2 : Modèles de pointe actifs (27B, 32B, Qwen)
    if (id.includes('27b') || id.includes('32b') || id.includes('qwen')) return 85;
    // Priorité 3 : Modèles intermédiaires actifs (20B)
    if (id.includes('20b')) return 75;
    // Priorité 4 : Modèles spécialisés actifs (Allam, etc.)
    if (id.includes('allam') || id.includes('7b')) return 65;
    return 50;
}

// Récupérer le client Groq
function getGroqClient() {
    const apiKey = (process.env.GROQ_API_KEY || process.env.OPENAI_API_KEY || "").trim();
    if (!apiKey) return null;
    return new OpenAI({
        apiKey: apiKey,
        baseURL: "https://api.groq.com/openai/v1",
    });
}

// Fonction d'appel à Groq avec bascule automatique de modèle et auto-ajustement des tokens
async function callGroqWithFallback(groq, modelsToTry, messages, options = {}) {
    let responseText = null;
    const modelErrors = [];

    // Filtrer d'office tous les modèles dépréciés
    const validModels = modelsToTry.filter(m => !DEPRECATED_MODELS.includes(m));

    for (const currentModel of validModels) {
        // En cas de dépassement de limite de tokens (413), tenter avec des quotas dégressifs
        const tokenAttempts = [
            options.max_tokens || 1400,
            1000
        ];

        for (const targetTokens of tokenAttempts) {
            try {
                console.log(`[Groq Pipeline] Appel de ${currentModel} (max_tokens: ${targetTokens})...`);
                const reqPayload = {
                    model: currentModel,
                    messages: messages,
                    temperature: options.temperature !== undefined ? options.temperature : 0.2,
                    max_tokens: targetTokens,
                    ...(options.jsonMode ? { response_format: { type: "json_object" } } : {})
                };

                let completion;
                try {
                    completion = await groq.chat.completions.create(reqPayload);
                } catch (errJson) {
                    if (errJson.message && (errJson.message.includes('response_format') || errJson.message.includes('json_object'))) {
                        delete reqPayload.response_format;
                        completion = await groq.chat.completions.create(reqPayload);
                    } else {
                        throw errJson;
                    }
                }

                responseText = completion.choices[0]?.message?.content;
                if (responseText) {
                    return { text: responseText, model: currentModel };
                }
            } catch (error) {
                const isTooLarge = error.status === 413 || 
                                  (error.message && (
                                      error.message.includes('tokens per minute') || 
                                      error.message.includes('TPM') || 
                                      error.message.includes('ITPM') || 
                                      error.message.includes('Request too large') || 
                                      error.message.includes('reduce the length')
                                  ));

                if (isTooLarge && targetTokens > 1000) {
                    console.warn(`[Groq Quota] 413 détecté sur ${currentModel}. Ajustement automatique du quota de tokens...`);
                    continue; // réessai avec targetTokens = 1000
                }

                console.error(`Erreur avec ${currentModel}:`, error.status, error.message);
                modelErrors.push(`[${currentModel}] ${error.message}`);
                
                if (error.status === 401) {
                    const authErr = new Error("Clé API Groq invalide ou expirée.");
                    authErr.status = 401;
                    throw authErr;
                }
                break; // passer au modèle suivant
            }
        }
    }

    const failureErr = new Error("Échec d'appel Groq : " + modelErrors.join(" | "));
    throw failureErr;
}

// =========================================================================
// ROUTES D'AUTHENTIFICATION ET DE SÉCURITÉ
// =========================================================================

// Connexion avec mot de passe
app.post('/api/auth/login', (req, res) => {
    const clientIp = req.ip || req.connection.remoteAddress || 'unknown';
    const now = Date.now();

    // Vérifier les tentatives de force brute
    const attemptData = loginAttempts.get(clientIp);
    if (attemptData && attemptData.count >= MAX_FAILED_ATTEMPTS) {
        const elapsed = now - attemptData.lastAttempt;
        if (elapsed < LOCKOUT_PERIOD_MS) {
            const remainingMinutes = Math.ceil((LOCKOUT_PERIOD_MS - elapsed) / 60000);
            return res.status(429).json({ 
                error: `Trop de tentatives erronées. Accès temporairement bloqué pendant ${remainingMinutes} minute(s).` 
            });
        } else {
            loginAttempts.delete(clientIp);
        }
    }

    const inputPassword = (req.body && req.body.password ? String(req.body.password) : "").trim();
    if (!inputPassword) {
        return res.status(400).json({ error: "Veuillez entrer le mot de passe." });
    }

    // Comparaison temporelle sécurisée (timing-safe) pour parer aux attaques par timing
    const inputBuffer = Buffer.from(inputPassword);
    const expectedBuffer = Buffer.from(APP_PASSWORD);
    let isMatch = false;

    if (inputBuffer.length === expectedBuffer.length) {
        isMatch = crypto.timingSafeEqual(inputBuffer, expectedBuffer);
    }

    if (isMatch) {
        loginAttempts.delete(clientIp);
        // Générer un jeton cryptographique aléatoire de 64 caractères
        const sessionToken = crypto.randomBytes(32).toString('hex');
        activeSessions.set(sessionToken, { createdAt: now });

        console.log(`[Sécurité] Connexion réussie depuis ${clientIp}`);
        return res.json({ 
            success: true, 
            token: sessionToken,
            message: "Authentification réussie." 
        });
    } else {
        // Enregistrer l'échec
        const currentCount = attemptData ? attemptData.count + 1 : 1;
        loginAttempts.set(clientIp, { count: currentCount, lastAttempt: now });

        console.warn(`[Sécurité] Échec de mot de passe depuis ${clientIp} (${currentCount}/${MAX_FAILED_ATTEMPTS})`);
        return res.status(401).json({ 
            error: "Mot de passe incorrect. Veuillez réessayer." 
        });
    }
});

// Vérification de la session active
app.get('/api/auth/check', (req, res) => {
    const authHeader = req.headers['authorization'] || '';
    let token = '';
    if (authHeader.startsWith('Bearer ')) {
        token = authHeader.slice(7).trim();
    } else if (req.headers['x-auth-token']) {
        token = req.headers['x-auth-token'];
    }

    const valid = isValidSession(token);
    res.json({ authenticated: valid });
});

// Déconnexion
app.post('/api/auth/logout', (req, res) => {
    const authHeader = req.headers['authorization'] || '';
    let token = '';
    if (authHeader.startsWith('Bearer ')) {
        token = authHeader.slice(7).trim();
    } else if (req.headers['x-auth-token']) {
        token = req.headers['x-auth-token'];
    }

    if (token) {
        activeSessions.delete(token);
    }
    res.json({ success: true, message: "Déconnexion effectuée." });
});

// Route diagnostic : liste directement les modèles actifs de votre clé Groq (Sécurisée)
app.get('/api/models', requireAuth, async (req, res) => {
    try {
        const groq = getGroqClient();
        if (!groq) return res.status(500).json({ error: "La variable GROQ_API_KEY n'est pas configurée sur Render." });
        
        const list = await groq.models.list();
        const textModels = (list.data || [])
            .filter(m => m.active !== false && 
                         !m.id.includes('whisper') && 
                         !m.id.includes('tts') && 
                         !m.id.includes('guard') &&
                         !m.id.includes('embed'))
            .map(m => m.id);

        res.json({
            count: textModels.length,
            recommended_chat_models: textModels,
            all_models: (list.data || []).map(m => m.id)
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Route API principale : Génération avec Pipeline Conseil Stratégique (Sécurisée)
app.post('/api/generate', requireAuth, async (req, res) => {
    try {
        const apiKey = (process.env.GROQ_API_KEY || process.env.OPENAI_API_KEY || "").trim();
        if (!apiKey) {
            return res.status(500).json({ 
                error: "La clé API Groq n'est pas configurée. Veuillez ajouter la variable d'environnement GROQ_API_KEY sur Render." 
            });
        }

        const rawText = req.body.text;
        if (!rawText) {
            return res.status(400).json({ error: "Aucun texte fourni." });
        }
        
        // Préparer intelligemment le texte pour respecter les quotas TPM de Groq tout en préservant 100% des tableaux
        const text = smartPrepareDocumentText(rawText, 24000);

        const mode = req.body.mode || "master"; // "master" (3 IA en chaîne) ou "express" (1 IA)
        const theme = req.body.theme || "";
        const themeInstruction = theme ? `\nIMPORTANT - THÈME OU STYLE DEMANDÉ : Le créateur souhaite ce thème ou style particulier : "${theme}". Adapte le ton, le vocabulaire et les angles d'analyse en fonction de cette demande.\n` : "";

        const groq = new OpenAI({
            apiKey: apiKey,
            baseURL: "https://api.groq.com/openai/v1",
        });

        // 1. Découverte dynamique des modèles disponibles sur la clé Groq
        let discoveredModels = [];
        try {
            const list = await groq.models.list();
            if (list && list.data) {
                discoveredModels = list.data
                    .filter(m => m.active !== false && 
                                 !DEPRECATED_MODELS.includes(m.id) &&
                                 !m.id.includes('whisper') && 
                                 !m.id.includes('tts') && 
                                 !m.id.includes('guard') && 
                                 !m.id.includes('embed') &&
                                 !m.id.includes('orpheus'))
                    .map(m => m.id);
            }
        } catch (listErr) {
            if (listErr.status === 401) {
                return res.status(401).json({ 
                    error: "Clé API Groq invalide ou expirée. Veuillez vérifier votre clé GROQ_API_KEY sur Render." 
                });
            }
        }

        if (discoveredModels.length > 0) {
            discoveredModels.sort((a, b) => getModelIntelligenceScore(b) - getModelIntelligenceScore(a));
        }

        const customModel = (process.env.GROQ_MODEL || "").trim();
        const priorityHeavyModels = [
            "openai/gpt-oss-120b",
            "qwen/qwen3.8-27b",
            "openai/gpt-oss-20b",
            "allam-2-7b"
        ];

        const candidates = [
            customModel,
            ...discoveredModels,
            ...priorityHeavyModels
        ].filter(m => m && !DEPRECATED_MODELS.includes(m));

        const modelsToTry = [...new Set(candidates)];
        modelsToTry.sort((a, b) => {
            if (customModel && a === customModel) return -1;
            if (customModel && b === customModel) return 1;
            return getModelIntelligenceScore(b) - getModelIntelligenceScore(a);
        });

        if (modelsToTry.length === 0) {
            return res.status(500).json({ 
                error: "Aucun modèle de chat actif n'a été trouvé sur votre compte Groq." 
            });
        }

        let finalJsonText = null;

        if (mode === "master") {
            // =========================================================================
            // PIPELINE CONSEIL STRATÉGIQUE (3 IA EN CHAÎNE - ANALYSE PROFONDE & QUOTAS RESPECTÉS)
            // =========================================================================
            console.log("Démarrage du Pipeline Master Pro (Priorité absolue à la profondeur d'analyse)...");

            // --- IA 1 : L'AUDITEUR ANALYTIQUE SENIOR (Diagnostic chirurgical, capture des tableaux & chiffres) ---
            const promptIA1 = `Tu es un Auditeur Stratégique et Diagnosticien Senior de classe mondiale (standards McKinsey, BCG, Bain).
Ta mission est d'analyser EXHAUSTIVEMENT, EN PROFONDEUR et SANS RIEN ÉLAGUER le document fourni (Word, PDF, PPTX, texte). La rapidité n'a aucune importance, seule compte la rigueur analytique maximale et la profondeur.

EXIGENCES ABSOLUES SUR LES TABLEAUX ET LES CHIFFRES :
- Détecte, isole et retranscris INTÉGRALEMENT tous les TABLEAUX et grilles de données chiffrées présents dans le document. Ne résume JAMAIS un tableau : conserve tous ses en-têtes de colonnes, toutes ses lignes et toutes ses valeurs chiffrées exactes.
- Extrais l'intégralité des données dures (Hard Facts) : 100% des chiffres, métriques, pourcentages (%), montants monétaires (€, $), volumes, dates clés et ratios.

Produis un diagnostic stratégique chirurgical et exhaustif structuré ainsi :
1. Thèse centrale, macro-environnement et problématiques de fond.
2. Restitution exhaustive de TOUS LES TABLEAUX de données identifiés dans le document (avec colonnes et lignes précises).
3. Synthèse de tous les chiffres clés et métriques de performance.
4. Diagnostic des causes profondes (Root Cause Analysis - 5 Pourquoi) et freins identifiés.
5. Opportunités stratégiques, leviers de création de valeur et matrice des risques majeurs.

Sois ultra-dense, factuel, fouillé et sans la moindre approximation. Conserve la langue originale du document.`;

            const resIA1 = await callGroqWithFallback(groq, modelsToTry, [
                { role: "system", content: promptIA1 },
                { role: "user", content: `DOCUMENT COMPLET À AUDITER EN PROFONDEUR :\n=========================================\n${text}\n=========================================` }
            ], { temperature: 0.15, max_tokens: 1500 });

            const auditSummary = resIA1.text;
            console.log("IA 1 (Audit en profondeur) terminée avec succès via", resIA1.model);

            // --- IA 2 : L'ARCHITECTE NARRATIF (Storytelling, Pyramide de Minto & Valorisation des tableaux) ---
            const promptIA2 = `Tu es le Directeur de la Stratégie d'une grande organisation et maître du storytelling exécutif.
À partir du document original et du diagnostic analytique ultra-détaillé de l'IA 1, construis la TRAME NARRATIVE (Storyline) d'une présentation de niveau Conseil d'Administration / Comité Exécutif.

EXIGENCES ABSOLUES :
1. NOMBRE DE DIAPOSITIVES : Tu DOIS OBLIGATOIREMENT concevoir une présentation dense et complète de 8 À 12 DIAPOSITIVES (INTERDICTION FORMELLE de faire seulement 2 ou 3 slides !).
   Chaque page, enjeu, bilan, analyse de fond et recommandation du document doit avoir sa propre diapositive dédiée.
2. VALORISATION OBLIGATOIRE DES TABLEAUX ET CHIFFRES : Prévois au minimum 1 à 3 diapositives dédiées spécifiquement à des TABLEAUX (Bilan financier, KPIs, comparatifs d'activité, planning ou synthèse de données).
3. Règles narratives :
   - Applique avec rigueur la Pyramide de Minto :
     * Slide 1 : Cadrage & Contexte global
     * Slide 2 : Problématiques majeures & Tensions stratégiques
     * Slide 3 : Indicateurs Clés de Performance & Données Chiffrées (TABLEAU 1)
     * Slide 4 : Analyse approfondie des causes racines et freins
     * Slide 5 : Piliers d'actions stratégiques et leviers prioritaires
     * Slide 6 : Bilan d'activité, Comparatif & Résultats Financiers (TABLEAU 2)
     * Slide 7 : Feuille de route opérationnelle, calendrier et jalons
     * Slide 8 : Gouvernance, gestion des risques et facteurs clés de succès
     * (Slides 9 à 12 : selon les autres sections et thématiques du document)
- Pour chaque diapositive :
  * Définis un TITRE DE THÈSE fort et explicite (ex: 'Érosion de 18% des marges due à l'inflation des coûts logistiques' et NON un titre creux comme 'Coûts logistiques').
  * Indique clairement si cette slide doit contenir un TABLEAU extrait du document et spécifie ses données.${themeInstruction}

Conserve la langue originale du document.`;

            const resIA2 = await callGroqWithFallback(groq, modelsToTry, [
                { role: "system", content: promptIA2 },
                { role: "user", content: `AUDIT ANALYTIQUE EN PROFONDEUR (RÉALISÉ PAR L'IA 1) :\n-----------------------------------------\n${auditSummary.slice(0, 6000)}\n-----------------------------------------\n\nDOCUMENT ORIGINAL :\n-----------------------------------------\n${text.slice(0, 10000)}\n-----------------------------------------\n\nConstruis la trame narrative stratégique diapositive par diapositive (8 à 12 diapositives minimum).` }
            ], { temperature: 0.2, max_tokens: 1400 });

            const storyline = resIA2.text;
            console.log("IA 2 (Trame narrative stratégique) terminée avec succès via", resIA2.model);

            // --- IA 3 : LE RÉDACTEUR EXÉCUTIF (Formulation d'impact, Restitution des tableaux & JSON) ---
            const promptIA3 = `Tu es l'Expert Ultime en Rédaction de Présentations pour Dirigeants et Comités Stratégiques.
À partir du diagnostic fouillé (IA 1) et de la trame narrative persuasive (IA 2), rédige l'intégralité des diapositives au format JSON strict.

EXIGENCES ABSOLUES DE RÉDACTION :
1. NOMBRE DE DIAPOSITIVES : Tu DOIS OBLIGATOIREMENT GÉNÉRER ENTRE 8 ET 12 DIAPOSITIVES COMPLÈTES (strict minimum 8 diapositives !).
   INTERDICTION FORMELLE ET STRICTE de générer seulement 2 ou 3 diapositives. Une présentation courte est CONSIDÉRÉE COMME UN ÉCHEC TOTAL.
2. TABLEAUX OBLIGATOIRES : Au moins 1 à 3 diapositives DOIVENT OBLIGATOIREMENT contenir un objet "table" complet avec "headers" et "rows".
   - Si le document contient des tableaux, reproduis-les fidèlement dans "table".
   - Si le document contient des chiffres et statistiques (CA, marges, volumes, plannings, comparatifs...), structure-les dans l'objet "table" pour offrir une restitution visuelle claire !
   - Sur les diapositives purement conceptuelles, mets "table": null.
3. PUCES EXÉCUTIVES (3 à 5 par diapositive) :
   - Règle d'or de rédaction pour chaque puce :
     'Idée maîtresse en gras/clé : explication fouillée du contexte et de la causalité, chiffre précis ou fait marquant extrait du document, et impact opérationnel ou stratégique mesurable'.
4. Titre de chaque diapositive : formuler une VRAIE phrase affirmée et percutante (Thèse explicite avec métrique ou impact clair).
5. Conserver la langue originale du document.${themeInstruction}

FORMAT STRICT DU RÉSULTAT (JSON pur, sans bloc markdown, sans texte hors JSON).
STRUCTURE COMPLÈTE ATTENDUE (Génère impérativement l'ensemble des 8 à 12 diapositives) :
{
    "presentation_title": "Titre Principal Stratégique",
    "slides": [
        {
            "title": "1. Cadrage et Contexte Stratégique Global",
            "bullet_points": [
                "Idée force 1 : explication détaillée avec chiffre marquant et impact concret.",
                "Idée force 2 : explication détaillée avec donnée chiffrée et recommandation opérationnelle.",
                "Idée force 3 : synthèse des enjeux majeurs."
            ],
            "table": null
        },
        {
            "title": "2. Diagnostic des Problématiques et Enjeux Critiques",
            "bullet_points": [
                "Constat prioritaire : explication fouillée du diagnostic et des freins identifiés.",
                "Point d'alerte : données chiffrées sur les pertes d'efficacité ou surcoûts.",
                "Tension stratégique : impacts mesurés sur les opérations."
            ],
            "table": null
        },
        {
            "title": "3. Données Chiffrées et Indicateurs Clés de Performance",
            "bullet_points": [
                "Analyse des métriques : mise en perspective des résultats consolidés du tableau ci-dessous.",
                "Tendance forte : évolution positive sur les indicateurs de tête."
            ],
            "table": {
                "headers": ["Indicateur Clé", "Période N-1", "Période N", "Variation", "Impact"],
                "rows": [
                    ["Chiffre d'affaires", "1.0 M€", "1.25 M€", "+25%", "Surperformance"],
                    ["Marge opérationnelle", "18%", "22%", "+4 pts", "Favorable"],
                    ["Trésorerie disponible", "350 k€", "420 k€", "+20%", "Sécurisé"]
                ]
            }
        },
        {
            "title": "4. Analyse Approfondie des Causes Racines",
            "bullet_points": [
                "Cause structurelle 1 : analyse détaillée des facteurs d'influence.",
                "Facteur organisationnel : blocages identifiés et leviers de déblocage.",
                "Conséquences opérationnelles : quantification précise des impacts."
            ],
            "table": null
        },
        {
            "title": "5. Piliers d'Action et Recommandations Prioritaires",
            "bullet_points": [
                "Pilier 1 : action stratégique majeure avec objectifs chiffrés à court terme.",
                "Pilier 2 : déploiement opérationnel et optimisation des ressources.",
                "Pilier 3 : conduite du changement et appropriation collective."
            ],
            "table": null
        },
        {
            "title": "6. Bilan Comparatif et Résultats Financiers Récapitulatifs",
            "bullet_points": [
                "Synthèse comparative : mise en avant des écarts constatés dans la grille ci-dessous.",
                "Levier de rentabilité : amélioration de la structure de coûts."
            ],
            "table": {
                "headers": ["Poste Budgétaire / Axe", "Budget Prévisionnel", "Réalisé", "Écart constaté"],
                "rows": [
                    ["Pôle Commercial", "250 k€", "230 k€", "-8% (Économie)"],
                    ["Développement Produit", "400 k€", "420 k€", "+5% (Accélération)"],
                    ["Opérations & Logistique", "150 k€", "140 k€", "-7% (Synergie)"]
                ]
            }
        },
        {
            "title": "7. Feuille de Route, Calendrier et Jalons Opérationnels",
            "bullet_points": [
                "Phase 1 (Mois 1-2) : cadrage initial et validation des prérequis techniques.",
                "Phase 2 (Mois 3-5) : déploiement pilote et premiers retours d'expérience.",
                "Phase 3 (Mois 6+) : passage à l'échelle et consolidation des acquis."
            ],
            "table": null
        },
        {
            "title": "8. Gouvernance, Gestion des Risques et Facteurs Clés de Succès",
            "bullet_points": [
                "Matrice des risques : identification des points de vigilance majeurs et parades associées.",
                "Dispositif de pilotage : rituels de gouvernance et indicateurs de suivi hebdomadaires.",
                "Facteur clé de succès : engagement fort des parties prenantes et suivi rigoureux."
            ],
            "table": null
        }
    ]
}`;

            const resIA3 = await callGroqWithFallback(groq, modelsToTry, [
                { role: "system", content: promptIA3 },
                { role: "user", content: `TRÂME NARRATIVE STRATÉGIQUE (IA 2) :\n-----------------------------------------\n${storyline.slice(0, 5000)}\n-----------------------------------------\n\nDONNÉES CHIFFRÉES ET FAITS DE L'AUDIT (IA 1) :\n-----------------------------------------\n${auditSummary.slice(0, 5000)}\n-----------------------------------------\n\nGénère impérativement la présentation PowerPoint complète (8 à 12 diapositives détaillées avec tableaux) en JSON strict.` }
            ], { jsonMode: true, temperature: 0.15, max_tokens: 3000 });

            finalJsonText = resIA3.text;
            console.log("IA 3 (Rédaction finale) terminée avec succès via", resIA3.model);

        } else {
            // =========================================================================
            // MODE EXPRESS (1 SEUL APPEL DIRECT)
            // =========================================================================
            console.log("Exécution en Mode Express (1 IA)...");
            const singlePrompt = `Tu es un expert en création de présentations professionnelles et exécutives.
Lis le texte fourni et génère une présentation PowerPoint complète, détaillée et étayée de chiffres.${themeInstruction}

EXIGENCES ABSOLUES :
1. NOMBRE DE DIAPOSITIVES : Tu DOIS générer entre 6 et 8 diapositives complètes (INTERDICTION DE FAIRE MOINS DE 6 SLIDES).
2. TABLEAUX : Au moins 1 diapositive DOIT contenir un objet "table" complet (avec "headers" et "rows") pour afficher les chiffres clés sous forme de tableau.

Tu dois STRICTEMENT renvoyer un objet JSON valide avec cette structure exacte :
{
    "presentation_title": "Titre principal",
    "slides": [
        {
            "title": "1. Cadrage et Enjeux Stratégiques",
            "bullet_points": ["Point clé 1 approfondi avec chiffres", "Point clé 2 approfondi"],
            "table": null
        },
        {
            "title": "2. Diagnostic et Données Clés",
            "bullet_points": ["Analyse des données ci-dessous"],
            "table": {
                "headers": ["Indicateur", "Valeur N-1", "Valeur N", "Écart"],
                "rows": [
                    ["Chiffre d'Affaires", "1.0 M€", "1.2 M€", "+20%"],
                    ["Marge", "15%", "18%", "+3 pts"]
                ]
            }
        },
        {
            "title": "3. Piliers d'Action et Recommandations",
            "bullet_points": ["Action prioritaire 1", "Action prioritaire 2"],
            "table": null
        },
        {
            "title": "4. Plan d'Exécution et Calendrier",
            "bullet_points": ["Jalon 1", "Jalon 2"],
            "table": null
        },
        {
            "title": "5. Gouvernance et Conclusion",
            "bullet_points": ["Facteur de succès 1", "Facteur de succès 2"],
            "table": null
        },
        {
            "title": "6. Synthèse des Résultats Attendus",
            "bullet_points": ["Bénéfice mesuré 1", "Bénéfice mesuré 2"],
            "table": null
        }
    ]
}`;
            const resSingle = await callGroqWithFallback(groq, modelsToTry, [
                { role: "system", content: singlePrompt },
                { role: "user", content: `DOCUMENT :\n\n${text.slice(0, 10000)}` }
            ], { jsonMode: true, temperature: 0.25, max_tokens: 2200 });

            finalJsonText = resSingle.text;
        }

        // Nettoyage au cas où des balises de réflexion (DeepSeek <think>) ou des balises markdown entourent le JSON
        finalJsonText = finalJsonText.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
        finalJsonText = finalJsonText.replace(/```json/gi, '').replace(/```/g, '').trim();

        // Extraction chirurgicale du bloc JSON { ... }
        const firstBrace = finalJsonText.indexOf('{');
        const lastBrace = finalJsonText.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
            finalJsonText = finalJsonText.substring(firstBrace, lastBrace + 1);
        }

        const jsonResult = JSON.parse(finalJsonText);
        res.json(jsonResult);

        // Nettoyage immédiat des variables pour garantir le zéro-trace en mémoire vive
        finalJsonText = null;
        if (req.body) req.body.text = null;

    } catch (error) {
        console.error("Erreur serveur Groq:", error.message);
        res.status(error.status || 500).json({ error: error.message });
    }
});

// Rediriger n'importe quelle autre route vers index.html
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Server SlideCraft AI (Multi-Agent Pipeline Ready) is running on port ${PORT}`);
});
