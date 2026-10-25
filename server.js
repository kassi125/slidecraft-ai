const express = require('express');
const path = require('path');
const OpenAI = require('openai');

const app = express();
const PORT = process.env.PORT || 3000;

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

// Route API principale : génération automatique avec détection des modèles actifs
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
        
        const theme = req.body.theme || "";
        const themeInstruction = theme ? `\nIMPORTANT - THÈME DEMANDÉ : Le créateur souhaite ce thème ou style particulier : "${theme}". Adapte le ton, le style et le choix des informations en fonction de cette demande.\n` : "";

        const systemPrompt = `Tu es un consultant senior en stratégie et un expert de premier plan en création de présentations exécutives (standards McKinsey, BCG, Bain).

🎯 TON OBJECTIF :
Analyser EN PROFONDEUR le document fourni pour en extraire l'essence stratégique, les enjeux cruciaux et les enseignements majeurs, puis les convertir en une présentation PowerPoint d'une qualité irréprochable et à forte valeur ajoutée.

🧠 MÉTHODOLOGIE D'ANALYSE APPROFONDIE :
1. COMPRÉHENSION & SENS CRITIQUE :
   - Ne te contente JAMAIS d'un survol ou d'un résumé superficiel.
   - Identifie la thèse centrale, le contexte historique/opérationnel, les causes profondes, les freins, les opportunités et les conclusions majeures du document.
   - Extrais et mets impérativement en valeur les données concrètes : chiffres clés, pourcentages, ratios, métriques, dates et faits factuels précis.

2. STRUCTURE NARRATIVE & STORYTELLING :
   - Structure une suite logique, fluide et percutante de diapositives (généralement 6 à 10 diapositives selon la consistance du document) :
     * Slide 1 : Titre principal évocateur et sous-titre de cadrage.
     * Slide 2 : Contexte, vision globale et problématique centrale.
     * Slides intermédiaires : Décomposition analytique détaillée (piliers stratégiques, analyse sectorielle/technique, résultats démontrés, leviers de performance, risques).
     * Slide finale : Recommandations stratégiques concrètes, plan d'action ou prochaines étapes clés.

3. QUALITÉ ET PROFONDEUR DES POINTS (BULLET POINTS) :
   - Chaque diapositive doit comporter 3 à 5 points clés substantiels et denses en information.
   - BANNIS FORMELLEMENT les puces creuses de 3 mots (ex: "Améliorer les ventes", "Développer le projet").
   - Chaque puce doit être formulée avec une idée forte étayée par une justification, un chiffre ou un exemple concret (Format recommandé : "Idée directrice : explication approfondie et impact mesurable").

4. ADAPTATION AU THÈME & LANGUE :
   - Conserve scrupuleusement la langue d'origine du document.${themeInstruction}

📋 FORMAT DE SORTIE STRICT :
Tu dois répondre STRICTEMENT par un objet JSON valide, sans aucune balise de code ni texte introductif/conclusif, avec cette structure exacte :
{
    "presentation_title": "Titre Stratégique Percutant",
    "slides": [
        {
            "title": "Titre explicite et informatif de la diapositive",
            "bullet_points": [
                "Idée force 1 : explication détaillée, chiffre clé et impact concret",
                "Idée force 2 : explication détaillée, chiffre clé et impact concret",
                "Idée force 3 : explication détaillée, chiffre clé et impact concret"
            ]
        }
    ]
}`;

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
                console.log("Modèles Groq actifs détectés :", discoveredModels);
            }
        } catch (listErr) {
            console.warn("Impossible de lister les modèles Groq dynamiquement :", listErr.message);
            if (listErr.status === 401) {
                return res.status(401).json({ 
                    error: "Clé API Groq invalide ou expirée. Veuillez vérifier votre clé GROQ_API_KEY sur Render (elle commence par 'gsk_...')." 
                });
            }
        }

        // 2. Établir la liste des modèles à tester
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

        let responseText = null;
        const modelErrors = [];

        // 3. Boucle intelligente sur les modèles disponibles
        for (const currentModel of modelsToTry) {
            try {
                let completion;
                try {
                    // Essayer d'abord avec le mode JSON strict
                    completion = await groq.chat.completions.create({
                        model: currentModel,
                        messages: [
                            { role: "system", content: systemPrompt },
                            { role: "user", content: `DOCUMENT À ANALYSER EN PROFONDEUR :\n=========================================\n${text}\n=========================================\n\nProcède à une analyse approfondie et synthétise ce document en une présentation PowerPoint stratégique et détaillée au format JSON demandé.` }
                        ],
                        response_format: { type: "json_object" },
                        temperature: 0.3
                    });
                } catch (formatErr) {
                    // Si le modèle ne supporte pas response_format json_object, réessayer en mode texte standard
                    if (formatErr.message && formatErr.message.includes('response_format')) {
                        completion = await groq.chat.completions.create({
                            model: currentModel,
                            messages: [
                                { role: "system", content: systemPrompt },
                                { role: "user", content: `DOCUMENT À ANALYSER EN PROFONDEUR :\n=========================================\n${text}\n=========================================\n\nProcède à une analyse approfondie et synthétise ce document en une présentation PowerPoint stratégique et détaillée au format JSON demandé.` }
                            ],
                            temperature: 0.3
                        });
                    } else {
                        throw formatErr;
                    }
                }

                responseText = completion.choices[0]?.message?.content;
                if (responseText) {
                    console.log(`Génération réussie avec le modèle Groq : ${currentModel}`);
                    break; // Succès !
                }
            } catch (error) {
                console.error(`Erreur avec ${currentModel}:`, error.status, error.message);
                modelErrors.push(`[${currentModel}] ${error.message}`);

                // Clé non autorisée
                if (error.status === 401) {
                    return res.status(401).json({ 
                        error: "Clé API Groq invalide. Veuillez vérifier votre clé GROQ_API_KEY sur Render." 
                    });
                }
            }
        }

        if (!responseText) {
            return res.status(500).json({
                error: "Échec Groq : " + modelErrors.join(" | ") + 
                       (discoveredModels.length ? `\n(Modèles disponibles sur votre compte : ${discoveredModels.join(', ')})` : "")
            });
        }

        // Nettoyage au cas où des balises markdown entourent le JSON
        responseText = responseText.replace(/```json/gi, '').replace(/```/g, '').trim();

        const jsonResult = JSON.parse(responseText);
        res.json(jsonResult);

    } catch (error) {
        console.error("Erreur serveur Groq:", error);
        res.status(500).json({ error: error.message });
    }
});

// Rediriger n'importe quelle autre route vers index.html
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Server SlideCraft AI (Groq Auto-Discovery) is running on port ${PORT}`);
});
