const express = require('express');
const path = require('path');
const OpenAI = require('openai');

const app = express();
const PORT = process.env.PORT || 3000;

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

// Prépare le texte du document pour garantir le respect strict des limites TPM de Groq (7000 ITPM / 8000 TPM)
function smartPrepareDocumentText(rawText, maxChars = 12000) {
    if (!rawText || rawText.length <= maxChars) return rawText;

    // Isoler et sanctuariser tous les tableaux détectés
    const tableRegex = /=== \[TABLEAU [\s\S]*?=== \[FIN DU TABLEAU.*?===/gi;
    const tables = rawText.match(tableRegex) || [];
    const tablesText = tables.join("\n\n");

    // Si les tableaux à eux seuls occupent une grande partie
    if (tablesText.length >= maxChars * 0.75) {
        return tablesText.slice(0, maxChars) + "\n\n[... données tabulaires extraites ...]";
    }

    const remainingChars = maxChars - tablesText.length;
    const headChars = Math.floor(remainingChars * 0.6);
    const tailChars = Math.floor(remainingChars * 0.4);

    const head = rawText.slice(0, headChars);
    const tail = rawText.slice(-tailChars);

    return `${head}\n\n[... Synthèse intermédiaire respectant les limites de tokens ...]\n\n${tablesText}\n\n${tail}`;
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

// Route diagnostic : liste directement les modèles actifs de votre clé Groq
app.get('/api/models', async (req, res) => {
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

// Route API principale : Génération avec Pipeline Conseil Stratégique (3 IA en Chaîne)
app.post('/api/generate', async (req, res) => {
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
        const text = smartPrepareDocumentText(rawText, 12000);

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
            ], { temperature: 0.15, max_tokens: 1400 });

            const auditSummary = resIA1.text;
            console.log("IA 1 (Audit en profondeur) terminée avec succès via", resIA1.model);

            // --- IA 2 : L'ARCHITECTE NARRATIF (Storytelling, Pyramide de Minto & Valorisation des tableaux) ---
            const promptIA2 = `Tu es le Directeur de la Stratégie d'une grande organisation et maître du storytelling exécutif.
À partir du document original et du diagnostic analytique ultra-détaillé de l'IA 1, construis la TRAME NARRATIVE (Storyline) d'une présentation de niveau Conseil d'Administration / Comité Exécutif.

Règles fondamentales :
- Applique avec rigueur la Pyramide de Minto :
  * Situation & Cadrage du contexte
  * Complication & Tension stratégique (appuyée par les faits durs)
  * Question centrale / Enjeu critique
  * Résolution stratégique découpée en piliers d'actions concrets et mesurables
  * Calendrier, gouvernance, gestion des risques et perspectives
- VALORISATION DES TABLEAUX ET DES CHIFFRES : Si le document original ou l'audit de l'IA 1 contient un ou plusieurs tableaux de données (bilan financier, KPIs, plannings, comparatifs...), tu DOIS obligatoirement dédier une ou plusieurs diapositives spécifiquement pour afficher et analyser ces tableaux !
- Découpe la présentation en 6 à 10 diapositives logiques et indissociables.
- Pour chaque diapositive :
  * Définis un TITRE DE THÈSE fort et explicite (ex: 'Érosion de 18% des marges due à l'inflation des coûts logistiques' et NON un titre creux comme 'Coûts logistiques').
  * Indique clairement si cette slide doit contenir un TABLEAU extrait du document et spécifie ses données.${themeInstruction}

Conserve la langue originale du document.`;

            const resIA2 = await callGroqWithFallback(groq, modelsToTry, [
                { role: "system", content: promptIA2 },
                { role: "user", content: `AUDIT ANALYTIQUE EN PROFONDEUR (RÉALISÉ PAR L'IA 1) :\n-----------------------------------------\n${auditSummary.slice(0, 6000)}\n-----------------------------------------\n\nDOCUMENT ORIGINAL :\n-----------------------------------------\n${text.slice(0, 8000)}\n-----------------------------------------\n\nConstruis la trame narrative stratégique diapositive par diapositive.` }
            ], { temperature: 0.2, max_tokens: 1200 });

            const storyline = resIA2.text;
            console.log("IA 2 (Trame narrative stratégique) terminée avec succès via", resIA2.model);

            // --- IA 3 : LE RÉDACTEUR EXÉCUTIF (Formulation d'impact, Restitution des tableaux & JSON) ---
            const promptIA3 = `Tu es l'Expert Ultime en Rédaction de Présentations pour Dirigeants et Comités Stratégiques.
À partir du diagnostic fouillé (IA 1) et de la trame narrative persuasive (IA 2), rédige l'intégralité des diapositives au format JSON strict.

EXIGENCES ABSOLUES DE RÉDACTION ET RESTITUTION DES TABLEAUX :
1. RESTITUTION VISUELLE DES TABLEAUX :
   - Pour chaque diapositive qui présente des données tabulaires du document, inclus OBLIGATOIREMENT l'objet "table" avec "headers" (tableau des noms de colonnes) et "rows" (tableau des lignes contenant les valeurs).
   - Conserve fidèlement chaque valeur, chiffre, pourcentage et intitulé du tableau d'origine.
   - S'il n'y a pas de tableau pour une diapositive conceptuelle, mets "table": null.
2. MISE EN AVANT DES CHIFFRES DANS LES PUCES :
   - Dans TOUTES les puces, mets systématiquement en valeur les chiffres clés, métriques, dates et pourcentages.
   - Règle d'or de rédaction pour chaque puce :
     'Idée maîtresse en gras/clé : explication fouillée du contexte et de la causalité, chiffre précis ou fait marquant extrait du document, et impact opérationnel ou stratégique mesurable'.
3. Titre de présentation : hautement engageant, précis, stratégique.
4. Titres de chaque diapositive : formuler une VRAIE phrase affirmée et percutante (Thèse explicite avec métrique ou impact clair).
5. Conserver la langue originale du document.${themeInstruction}

FORMAT STRICT DU RÉSULTAT (JSON pur, sans bloc markdown, sans texte hors JSON) :
{
    "presentation_title": "Titre Principal Stratégique",
    "slides": [
        {
            "title": "Titre de thèse affirmé et informatif de la diapositive",
            "bullet_points": [
                "Idée force 1 : explication détaillée avec chiffre marquant (+25%) et impact concret.",
                "Idée force 2 : explication détaillée avec donnée chiffrée et recommandation opérationnelle."
            ],
            "table": null
        },
        {
            "title": "Bilan Financier et Comparatif d'Activité (Tableau Récapitulatif)",
            "bullet_points": [
                "Analyse clé : croissance globale supérieure aux prévisions grâce à la dynamique digitale."
            ],
            "table": {
                "headers": ["Indicateur", "2024", "2025", "Variation"],
                "rows": [
                    ["Chiffre d'affaires", "1.2 M€", "1.5 M€", "+25%"],
                    ["Marge brute", "38%", "42%", "+4 pts"],
                    ["Trésorerie nette", "320 k€", "510 k€", "+59%"]
                ]
            }
        }
    ]
}`;

            const resIA3 = await callGroqWithFallback(groq, modelsToTry, [
                { role: "system", content: promptIA3 },
                { role: "user", content: `TRÂME NARRATIVE STRATÉGIQUE (IA 2) :\n-----------------------------------------\n${storyline.slice(0, 5000)}\n-----------------------------------------\n\nDONNÉES CHIFFRÉES ET FAITS DE L'AUDIT (IA 1) :\n-----------------------------------------\n${auditSummary.slice(0, 5000)}\n-----------------------------------------\n\nGénère la présentation PowerPoint finale complète en JSON strict.` }
            ], { jsonMode: true, temperature: 0.15, max_tokens: 1800 });

            finalJsonText = resIA3.text;
            console.log("IA 3 (Rédaction finale) terminée avec succès via", resIA3.model);

        } else {
            // =========================================================================
            // MODE EXPRESS (1 SEUL APPEL DIRECT)
            // =========================================================================
            console.log("Exécution en Mode Express (1 IA)...");
            const singlePrompt = `Tu es un expert en création de présentations professionnelles et exécutives.
Lis le texte fourni et extrais les informations les plus importantes pour créer une présentation PowerPoint claire, concise et étayée de chiffres.${themeInstruction}

CONSIGNE TABLEAUX ET CHIFFRES :
Si le texte contient des tableaux de données ou des comparaisons chiffrées, conserve-les et reproduis-les fidèlement via l'objet "table" (avec "headers" et "rows").
Dans les puces, mets toujours en avant les chiffres, pourcentages et résultats concrets.

Tu dois STRICTEMENT renvoyer un objet JSON valide avec cette structure exacte :
{
    "presentation_title": "Titre principal",
    "slides": [
        {
            "title": "Titre informatif de la diapositive",
            "bullet_points": ["Point clé approfondi avec chiffres"],
            "table": null
        },
        {
            "title": "Tableau Récapitulatif des Chiffres Clés",
            "bullet_points": ["Analyse synthétique du tableau ci-dessous"],
            "table": {
                "headers": ["Colonne 1", "Colonne 2", "Colonne 3"],
                "rows": [
                    ["Valeur A", "100 k€", "+15%"]
                ]
            }
        }
    ]
}`;
            const resSingle = await callGroqWithFallback(groq, modelsToTry, [
                { role: "system", content: singlePrompt },
                { role: "user", content: `DOCUMENT :\n\n${text.slice(0, 9000)}` }
            ], { jsonMode: true, temperature: 0.25, max_tokens: 1500 });

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
