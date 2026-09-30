const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

// Augmenter la limite pour accepter de longs textes extraits de gros PDF
app.use(express.json({ limit: '50mb' }));

// Servir les fichiers statiques (index.html) depuis le dossier racine
app.use(express.static(__dirname));

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

        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${apiKey}`;

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

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { response_mime_type: "application/json" }
            })
        });

        if (!response.ok) {
            const errData = await response.json();
            return res.status(response.status).json({ error: errData.error?.message || "Erreur Gemini API" });
        }

        const data = await response.json();
        res.json(data);
    } catch (error) {
        console.error("Erreur serveur:", error);
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
