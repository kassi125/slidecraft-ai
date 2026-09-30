const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

// Augmenter la limite pour accepter de longs textes extraits de gros PDF
app.use(express.json({ limit: '50mb' }));

// Servir les fichiers statiques (index.html) depuis le dossier racine
app.use(express.static(__dirname));

const { GoogleGenerativeAI } = require('@google/generative-ai');

// Route API pour faire la requête cachée vers Gemini
app.post('/api/generate', async (req, res) => {
    try {
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
            return res.status(500).json({ error: "La clé API n'est pas configurée sur le serveur Render." });
        }

        const text = req.body.text;
        if (!text) {
            return res.status(400).json({ error: "Aucun texte fourni." });
        }

        // Le SDK officiel gère automatiquement la bonne version de l'API (v1, v1beta) et le bon routage !
        const genAI = new GoogleGenerativeAI(apiKey);
        // On permet de surcharger le modèle via l'environnement, sinon on utilise gemini-1.5-flash-latest
        const modelName = process.env.GEMINI_MODEL || "gemini-1.5-flash-latest";
        const model = genAI.getGenerativeModel({
            model: modelName,
            generationConfig: { responseMimeType: "application/json" }
        });

        const prompt = `
        Tu es un expert en création de présentations professionnelles. 
        Lis le texte fourni et extrais les informations les plus importantes pour créer une présentation PowerPoint claire et concise.
        Conserve la langue originale du document.
        
        Le résultat doit être STRICTEMENT un objet JSON avec la structure suivante, sans aucun autre texte autour, sans bloc markdown de code :
        {
            "presentation_title": "Titre principal",
            "slides": [
                {
                    "title": "Titre de la diapositive",
                    "bullet_points": ["Point clé 1", "Point clé 2"]
                }
            ]
        }
        
        Texte à résumer :
        ${text}
        `;

        const result = await model.generateContent(prompt);
        const responseText = result.response.text();
        
        // On convertit directement en objet JSON côté serveur
        const jsonResult = JSON.parse(responseText);
        res.json(jsonResult);

    } catch (error) {
        console.error("Erreur serveur Gemini:", error);
        res.status(500).json({ error: error.message });
    }
});

// Rediriger n'importe quelle autre route vers l'index HTML
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
