const express = require('express');
const path = require('path');
const OpenAI = require('openai');

const app = express();
const PORT = process.env.PORT || 3000;

// Augmenter la limite pour accepter de longs textes extraits de gros documents
app.use(express.json({ limit: '50mb' }));

// Servir les fichiers statiques (index.html, etc.) depuis le dossier racine
app.use(express.static(__dirname));

// Récupérer le client Groq (utilise l'interface standard compatible OpenAI)
function getGroqClient() {
    const apiKey = (process.env.GROQ_API_KEY || process.env.OPENAI_API_KEY || "").trim();
    if (!apiKey) return null;
    return new OpenAI({
        apiKey: apiKey,
        baseURL: "https://api.groq.com/openai/v1",
    });
}

// Route diagnostic pour vérifier la connexion et lister les modèles accessibles avec la clé Groq
app.get('/api/models', async (req, res) => {
    try {
        const groq = getGroqClient();
        if (!groq) return res.status(500).json({ error: "La variable GROQ_API_KEY n'est pas configurée sur Render." });
        
        const list = await groq.models.list();
        res.json(list);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Route API principale : envoi du texte à Groq (Llama 3.3 70B gratuit et ultra-rapide)
app.post('/api/generate', async (req, res) => {
    try {
        const apiKey = (process.env.GROQ_API_KEY || process.env.OPENAI_API_KEY || "").trim();
        if (!apiKey) {
            return res.status(500).json({ 
                error: "La clé API Groq n'est pas configurée. Veuillez ajouter la variable d'environnement GROQ_API_KEY sur votre tableau de bord Render." 
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

        // Modèles Groq haute performance (Llama 3.3 70B par défaut)
        const preferredModel = (process.env.GROQ_MODEL || "llama-3.3-70b-versatile").trim();
        const modelsToTry = [preferredModel, "llama-3.3-70b-versatile", "llama-3.1-8b-instant", "mixtral-8x7b-32768"]
            .filter((val, idx, self) => self.indexOf(val) === idx);

        const groq = new OpenAI({
            apiKey: apiKey,
            baseURL: "https://api.groq.com/openai/v1",
        });

        let responseText = null;
        const modelErrors = [];

        for (const currentModel of modelsToTry) {
            try {
                const completion = await groq.chat.completions.create({
                    model: currentModel,
                    messages: [
                        { role: "system", content: systemPrompt },
                        { role: "user", content: `Voici le document à transformer en diapositives PowerPoint :\n\n${text}` }
                    ],
                    response_format: { type: "json_object" },
                    temperature: 0.4
                });

                responseText = completion.choices[0]?.message?.content;
                if (responseText) {
                    break; // Succès !
                }
            } catch (error) {
                console.error(`Erreur avec le modèle Groq ${currentModel}:`, error.status, error.message);
                modelErrors.push(`[${currentModel}] ${error.message}`);

                // Si la clé est invalide, inutile d'essayer les autres modèles
                if (error.status === 401) {
                    return res.status(401).json({ 
                        error: "Clé API Groq invalide. Veuillez vérifier la variable GROQ_API_KEY sur Render (elle commence par 'gsk_...')." 
                    });
                }
            }
        }

        if (!responseText) {
            return res.status(500).json({
                error: "Erreur Groq : " + modelErrors.join(" | ")
            });
        }

        // Nettoyage au cas où des balises markdown seraient présentes
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
    console.log(`Server SlideCraft AI (Groq - Llama 3.3) is running on port ${PORT}`);
});
