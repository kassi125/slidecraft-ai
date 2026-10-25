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

// Récupérer le client Groq
function getGroqClient() {
    const apiKey = (process.env.GROQ_API_KEY || process.env.OPENAI_API_KEY || "").trim();
    if (!apiKey) return null;
    return new OpenAI({
        apiKey: apiKey,
        baseURL: "https://api.groq.com/openai/v1",
    });
}

// Fonction d'appel à Groq avec bascule automatique de modèle en cas d'erreur
async function callGroqWithFallback(groq, modelsToTry, messages, options = {}) {
    let responseText = null;
    const modelErrors = [];

    for (const currentModel of modelsToTry) {
        try {
            let completion;
            try {
                completion = await groq.chat.completions.create({
                    model: currentModel,
                    messages: messages,
                    temperature: options.temperature !== undefined ? options.temperature : 0.3,
                    ...(options.jsonMode ? { response_format: { type: "json_object" } } : {})
                });
            } catch (errJson) {
                if (options.jsonMode && errJson.message && errJson.message.includes('response_format')) {
                    completion = await groq.chat.completions.create({
                        model: currentModel,
                        messages: messages,
                        temperature: options.temperature !== undefined ? options.temperature : 0.3
                    });
                } else {
                    throw errJson;
                }
            }

            responseText = completion.choices[0]?.message?.content;
            if (responseText) {
                return { text: responseText, model: currentModel };
            }
        } catch (error) {
            console.error(`Erreur avec ${currentModel}:`, error.status, error.message);
            modelErrors.push(`[${currentModel}] ${error.message}`);
            if (error.status === 401) {
                const authErr = new Error("Clé API Groq invalide ou expirée.");
                authErr.status = 401;
                throw authErr;
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

        const text = req.body.text;
        if (!text) {
            return res.status(400).json({ error: "Aucun texte fourni." });
        }
        
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

        const customModel = (process.env.GROQ_MODEL || "").trim();
        const candidates = [
            customModel,
            ...discoveredModels,
            "openai/gpt-oss-120b",
            "openai/gpt-oss-20b",
            "qwen/qwen3.8-27b",
            "gemma2-9b-it"
        ].filter(Boolean);

        const modelsToTry = [...new Set(candidates)];
        if (modelsToTry.length === 0) {
            return res.status(500).json({ 
                error: "Aucun modèle de chat actif n'a été trouvé sur votre compte Groq." 
            });
        }

        let finalJsonText = null;

        if (mode === "master") {
            // =========================================================================
            // PIPELINE CONSEIL STRATÉGIQUE (3 IA EN CHAÎNE)
            // =========================================================================
            console.log("Démarrage du Pipeline Master Pro (3 IA en chaîne)...");

            // --- IA 1 : L'AUDITEUR ANALYTIQUE (Extraction exhaustive & faits durs) ---
            const promptIA1 = `Tu es un Auditeur Stratégique Senior de classe mondiale (standards McKinsey, BCG).
Ta mission est d'analyser EXHAUSTIVEMENT et SANS RIEN ÉLAGUER le document fourni.
Produis un diagnostic analytique complet et structuré :
1. Thèse centrale, contexte global et problématiques prioritaires.
2. Toutes les données quantitatives et concrètes : chiffres clés, pourcentages, métriques, dates, jalons, budgets, volumes.
3. Causes profondes et freins identifiés.
4. Opportunités stratégiques, leviers de performance et solutions évoquées.
5. Risques majeurs, impacts et recommandations clés.
Sois dense, factuel, ultra-précis et exhaustif. Conserve la langue originale du document.`;

            const resIA1 = await callGroqWithFallback(groq, modelsToTry, [
                { role: "system", content: promptIA1 },
                { role: "user", content: `DOCUMENT COMPLET À AUDITER :\n=========================================\n${text}\n=========================================` }
            ], { temperature: 0.2 });

            const auditSummary = resIA1.text;
            console.log("IA 1 (Audit) terminée avec succès via", resIA1.model);

            // --- IA 2 : L'ARCHITECTE NARRATIF (Storytelling & Pyramide de Minto) ---
            const promptIA2 = `Tu es le Directeur de la Stratégie d'une grande organisation.
En te basant sur le document original et sur l'audit analytique réalisé par l'IA 1, conçois la TRAME NARRATIVE (Storyline) d'une présentation PowerPoint exécutive parfaite.
Règles :
- Applique la logique de la Pyramide de Minto (messages directeurs clairs, logique persuasive déductive/inductive).
- Découpe la présentation en 6 à 10 diapositives stratégiques.
- Pour chaque diapositive, définis :
  * Le rôle narratif de la slide (ex: Cadrage, Démonstration par les chiffres, Pilier d'action 1, Gouvernance, Conclusion).
  * Les messages et enseignements clés incontournables à y faire figurer.${themeInstruction}
Conserve la langue originale du document.`;

            const resIA2 = await callGroqWithFallback(groq, modelsToTry, [
                { role: "system", content: promptIA2 },
                { role: "user", content: `AUDIT ANALYTIQUE (RÉALISÉ PAR L'IA 1) :\n-----------------------------------------\n${auditSummary}\n-----------------------------------------\n\nDOCUMENT ORIGINAL :\n-----------------------------------------\n${text.slice(0, 15000)}\n-----------------------------------------\n\nConstruis la trame narrative stratégique diapositive par diapositive.` }
            ], { temperature: 0.25 });

            const storyline = resIA2.text;
            console.log("IA 2 (Trame narrative) terminée avec succès via", resIA2.model);

            // --- IA 3 : LE RÉDACTEUR EXÉCUTIF (Formulation d'impact & Sortie JSON) ---
            const promptIA3 = `Tu es l'Expert Ultime en Rédaction de Présentations pour Comités de Direction.
À partir de l'Audit (IA 1) et de la Trame Narrative (IA 2), rédige l'intégralité des diapositives au format JSON strict.

EXIGENCES ABSOLUES DE RÉDACTION :
1. Titre de présentation : percutant, engageant et précis.
2. Titres de chaque diapositive : formuler une VRAIE phrase ou affirmation informative (pas juste un nom générique).
3. Puces (Bullet points) : 3 à 5 puces par diapositive. BANNIR formellement les puces creuses de 3 mots.
   Chaque puce doit être formulée selon la règle d'or :
   'Idée force : explication approfondie, chiffre ou fait marquant extrait du document, et impact mesurable'.
4. Intégrer scrupuleusement les chiffres, métriques et données factuelles de l'audit.
5. Conserver la langue originale du document.${themeInstruction}

FORMAT STRICT DU RÉSULTAT (JSON pur, sans bloc markdown, sans commentaire) :
{
    "presentation_title": "Titre Principal Stratégique",
    "slides": [
        {
            "title": "Titre informatif et ciblé de la slide",
            "bullet_points": [
                "Idée force 1 : explication détaillée, chiffre clé et impact mesurable",
                "Idée force 2 : explication détaillée, chiffre clé et impact mesurable",
                "Idée force 3 : explication détaillée, chiffre clé et impact mesurable"
            ]
        }
    ]
}`;

            const resIA3 = await callGroqWithFallback(groq, modelsToTry, [
                { role: "system", content: promptIA3 },
                { role: "user", content: `TRÂME NARRATIVE (IA 2) :\n-----------------------------------------\n${storyline}\n-----------------------------------------\n\nDONNÉES CHIFFRÉES ET FAITS DE L'AUDIT (IA 1) :\n-----------------------------------------\n${auditSummary}\n-----------------------------------------\n\nGénère la présentation PowerPoint finale complète en JSON strict.` }
            ], { jsonMode: true, temperature: 0.2 });

            finalJsonText = resIA3.text;
            console.log("IA 3 (Rédaction finale) terminée avec succès via", resIA3.model);

        } else {
            // =========================================================================
            // MODE EXPRESS (1 SEUL APPEL DIRECT)
            // =========================================================================
            console.log("Exécution en Mode Express (1 IA)...");
            const singlePrompt = `Tu es un expert en création de présentations professionnelles et exécutives.
Lis le texte fourni et extrais les informations les plus importantes pour créer une présentation PowerPoint claire, concise et étayée de chiffres.${themeInstruction}

Tu dois STRICTEMENT renvoyer un objet JSON valide avec cette structure exacte :
{
    "presentation_title": "Titre principal",
    "slides": [
        {
            "title": "Titre informatif de la diapositive",
            "bullet_points": ["Point clé 1 approfondi", "Point clé 2 approfondi"]
        }
    ]
}`;
            const resSingle = await callGroqWithFallback(groq, modelsToTry, [
                { role: "system", content: singlePrompt },
                { role: "user", content: `DOCUMENT :\n\n${text}` }
            ], { jsonMode: true, temperature: 0.3 });

            finalJsonText = resSingle.text;
        }

        // Nettoyage au cas où des balises markdown entourent le JSON
        finalJsonText = finalJsonText.replace(/```json/gi, '').replace(/```/g, '').trim();

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
