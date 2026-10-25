const express = require('express');
const path = require('path');
const OpenAI = require('openai');

const app = express();
const PORT = process.env.PORT || 3000;

// Augmenter la limite pour accepter de longs textes extraits de gros documents
app.use(express.json({ limit: '50mb' }));

// Servir les fichiers statiques (index.html, etc.) depuis le dossier racine
app.use(express.static(__dirname));

// Route diagnostic pour vérifier la connexion et lister les modèles accessibles avec la clé OpenAI
app.get('/api/models', async (req, res) => {
    try {
        const apiKey = process.env.OPENAI_API_KEY || process.env.CHATGPT_API_KEY;
        if (!apiKey) return res.status(500).json({ error: "La variable OPENAI_API_KEY n'est pas configurée." });
        
        const openai = new OpenAI({ apiKey });
        const list = await openai.models.list();
        res.json(list);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Route API principale : envoi du texte à ChatGPT (OpenAI)
app.post('/api/generate', async (req, res) => {
    try {
        const apiKey = process.env.OPENAI_API_KEY || process.env.CHATGPT_API_KEY;
        if (!apiKey) {
            return res.status(500).json({ 
                error: "La clé API OpenAI (ChatGPT) n'est pas configurée. Veuillez ajouter la variable d'environnement OPENAI_API_KEY sur votre tableau de bord Render." 
            });
        }

        const text = req.body.text;
        if (!text) {
            return res.status(400).json({ error: "Aucun texte fourni." });
        }
        
        const theme = req.body.theme || "";
        const themeInstruction = theme ? `\nIMPORTANT - THÈME DEMANDÉ : Le créateur souhaite ce thème ou style particulier : "${theme}". Adapte le ton, le style et le choix des informations en fonction de cette demande.\n` : "";

        const systemPrompt = `Tu es un expert en création de présentations professionnelles. 
Lis le texte fourni et extrais les informations les plus importantes pour créer une présentation PowerPoint claire et concise.
Conserve la langue originale du document.${themeInstruction}

Tu dois STRICTEMENT renvoyer un objet JSON valide avec cette structure exacte, sans aucun texte additionnel :
{
    "presentation_title": "Titre principal",
    "slides": [
        {
            "title": "Titre de la diapositive",
            "bullet_points": ["Point clé 1", "Point clé 2"]
        }
    ]
}`;

        const preferredModel = (process.env.OPENAI_MODEL || "gpt-4o-mini").trim();
        // Liste de modèles modernes OpenAI (sans gpt-3.5-turbo qui est déprécié)
        const modelsToTry = [preferredModel, "gpt-4o-mini", "gpt-4o"]
            .filter((val, idx, self) => self.indexOf(val) === idx);

        const openai = new OpenAI({ apiKey });
        let responseText = null;
        const modelErrors = [];

        for (const currentModel of modelsToTry) {
            try {
                const completion = await openai.chat.completions.create({
                    model: currentModel,
                    messages: [
                        { role: "system", content: systemPrompt },
                        { role: "user", content: `Voici le document à transformer en diapositives PowerPoint :\n\n${text}` }
                    ],
                    response_format: { type: "json_object" },
                    temperature: 0.7
                });

                responseText = completion.choices[0]?.message?.content;
                if (responseText) {
                    break; // Succès !
                }
            } catch (error) {
                console.error(`Erreur avec le modèle OpenAI ${currentModel}:`, error.status, error.message);
                modelErrors.push(`[${currentModel}] ${error.message}`);

                // Si c'est un problème d'authentification ou de solde/crédits, inutile de retenter avec les autres modèles
                if (error.status === 401) {
                    return res.status(401).json({ 
                        error: "Clé API OpenAI invalide ou révoquée. Veuillez vérifier votre clé OPENAI_API_KEY sur Render." 
                    });
                }
                if (error.status === 429 && error.message && error.message.toLowerCase().includes('quota')) {
                    return res.status(429).json({ 
                        error: "Crédits OpenAI insuffisants (Quota dépassé). Sur l'API payante d'OpenAI, il est nécessaire d'avoir un solde positif (minimum 5$) sur votre compte : https://platform.openai.com/settings/organization/billing" 
                    });
                }
            }
        }

        if (!responseText) {
            return res.status(500).json({
                error: "Erreur OpenAI : " + modelErrors.join(" | ")
            });
        }

        // Nettoyage au cas où des balises markdown seraient présentes
        responseText = responseText.replace(/```json/gi, '').replace(/```/g, '').trim();

        const jsonResult = JSON.parse(responseText);
        res.json(jsonResult);

    } catch (error) {
        console.error("Erreur serveur OpenAI / ChatGPT:", error);
        res.status(500).json({ error: error.message });
    }
});

// Rediriger n'importe quelle autre route vers index.html
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Server SlideCraft AI (ChatGPT) is running on port ${PORT}`);
});
